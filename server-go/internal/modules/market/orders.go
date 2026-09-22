package market

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
)

type OrderRequest struct {
	ActorID                          int64
	RequestKey, ItemID               string
	Quantity, EquipmentID, UnitPrice int64
	RodSlot                          *int
	Hours                            int
}
type FillRequest struct {
	ActorID, OrderID, Quantity, ExpectedUnitPrice int64
	RequestKey                                    string
}
type Order struct {
	ID        int64     `json:"id,string"`
	SellerID  int64     `json:"sellerId,string"`
	Kind      string    `json:"kind"`
	ItemID    string    `json:"itemId,omitempty"`
	Quantity  int64     `json:"quantity"`
	Remaining int64     `json:"remaining"`
	UnitPrice int64     `json:"unitPrice"`
	RodName   string    `json:"rodName,omitempty"`
	State     string    `json:"state"`
	ExpiresAt time.Time `json:"expiresAt"`
	Source    string    `json:"-"`
}

func listingFee(total int64, hours int) int64 {
	rate := .01
	if hours == 12 {
		rate = .03
	} else if hours == 24 {
		rate = .05
	}
	return int64(math.Ceil(float64(total) * rate))
}
func (s *Service) ListOrder(ctx context.Context, r OrderRequest) (assets.Result, error) {
	if r.ActorID < 1 || r.UnitPrice < 1 || r.UnitPrice > assets.MaxCoins || (r.Hours != 6 && r.Hours != 12 && r.Hours != 24) {
		return assets.Result{}, assets.ErrInvalid
	}
	kind := "stack"
	quantity := r.Quantity
	if r.RodSlot != nil {
		kind = "rod"
		quantity = 1
		if *r.RodSlot < 0 || *r.RodSlot > 7 || r.ItemID != "" || r.EquipmentID != 0 || r.Quantity != 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	} else if r.EquipmentID > 0 {
		kind = "equipment"
		quantity = 1
		if r.ItemID != "" || r.Quantity != 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	} else if r.EquipmentID != 0 || r.ItemID == "" || len(r.ItemID) > 128 || quantity < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	if quantity > assets.MaxCoins/r.UnitPrice {
		return assets.Result{}, assets.ErrInvalid
	}
	fee := listingFee(quantity*r.UnitPrice, r.Hours)
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "market_list", RuleVersion: "market-v0.21.4", Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var capacity, count int
		if err := t.SQL().QueryRow(ctx, `SELECT listing_capacity,(SELECT count(*) FROM fishing.market_orders WHERE seller_id=$1 AND state='open') FROM fishing.player_state WHERE account_id=$1`, r.ActorID).Scan(&capacity, &count); err != nil {
			return assets.Result{}, err
		}
		if capacity > 0 && count >= capacity {
			return assets.Result{}, assets.Rejection("listing_capacity")
		}
		name := ""
		if kind == "stack" {
			var allowed bool
			if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.item_definitions WHERE id=$1 AND kind IN ('material','chest'))`, r.ItemID).Scan(&allowed); err != nil {
				return assets.Result{}, err
			}
			if !allowed {
				return assets.Result{}, assets.Rejection("item_not_listable")
			}
		} else if kind == "rod" {
			err := t.SQL().QueryRow(ctx, `SELECT name FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=$2`, r.ActorID, *r.RodSlot).Scan(&name)
			if errors.Is(err, pgx.ErrNoRows) {
				return assets.Result{}, assets.Rejection("empty_rod")
			}
			if err != nil {
				return assets.Result{}, err
			}
		}
		if err := t.Coins(ctx, r.ActorID, -fee); err != nil {
			return assets.Result{}, err
		}
		var id int64
		err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.market_orders(seller_id,kind,item_id,quantity,remaining,unit_price,rod_name,hours,created_operation,expires_at) VALUES($1,$2,NULLIF($3,''),$4,$4,$5,$6,$7,$8,clock_timestamp()+($7::integer*interval '1 hour')) RETURNING id`, r.ActorID, kind, r.ItemID, quantity, r.UnitPrice, name, r.Hours, t.OperationID()).Scan(&id)
		if err != nil {
			return assets.Result{}, err
		}
		switch kind {
		case "stack":
			err = t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: r.ItemID, Tier: "normal", Quantity: -quantity}})
		case "equipment":
			err = t.HoldOrderEquipment(ctx, r.ActorID, r.EquipmentID, id)
		case "rod":
			err = t.HoldOrderRod(ctx, r.ActorID, id, *r.RodSlot)
		}
		if err != nil {
			return assets.Result{}, err
		}
		_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.market_charges(operation_id,order_id,account_id,kind,amount) VALUES($1,$2,$3,'listing',$4)`, t.OperationID(), id, r.ActorID, fee)
		return assets.Result{Status: "listed", ResourceID: strconv.FormatInt(id, 10)}, err
	})
}
func readOrder(ctx context.Context, q assets.SQL, id int64, lock bool) (Order, error) {
	sql := `SELECT id,seller_id,kind,COALESCE(item_id,''),quantity,remaining,unit_price,rod_name,state,expires_at,source FROM fishing.market_orders WHERE id=$1`
	if lock {
		sql += " FOR UPDATE"
	}
	var o Order
	err := q.QueryRow(ctx, sql, id).Scan(&o.ID, &o.SellerID, &o.Kind, &o.ItemID, &o.Quantity, &o.Remaining, &o.UnitPrice, &o.RodName, &o.State, &o.ExpiresAt, &o.Source)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, assets.Rejection("listing_not_found")
	}
	return o, err
}
func orderExpired(ctx context.Context, q assets.SQL, o Order) (bool, error) {
	var expired bool
	err := q.QueryRow(ctx, `SELECT $1::timestamptz<=clock_timestamp()`, o.ExpiresAt).Scan(&expired)
	return expired, err
}
func (s *Service) Fill(ctx context.Context, r FillRequest) (assets.Result, error) {
	if r.ActorID < 1 || r.OrderID < 1 || r.Quantity < 1 || r.ExpectedUnitPrice < 1 || r.ExpectedUnitPrice > assets.MaxCoins || r.Quantity > assets.MaxCoins/r.ExpectedUnitPrice {
		return assets.Result{}, assets.ErrInvalid
	}
	o, err := readOrder(ctx, s.pool, r.OrderID, false)
	if err != nil {
		return assets.Result{}, err
	}
	if o.SellerID == r.ActorID {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "market_buy", RuleVersion: "market-v0.21.4", Players: []int64{r.ActorID, o.SellerID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		o, err := readOrder(ctx, t.SQL(), r.OrderID, true)
		if err != nil {
			return assets.Result{}, err
		}
		if o.State != "open" {
			return assets.Result{}, assets.Rejection("listing_closed")
		}
		expired, err := orderExpired(ctx, t.SQL(), o)
		if err != nil {
			return assets.Result{}, err
		}
		if expired {
			return assets.Result{}, assets.Rejection("listing_expired")
		}
		if o.UnitPrice != r.ExpectedUnitPrice {
			return assets.Result{}, assets.Rejection("price_changed")
		}
		if r.Quantity > o.Remaining {
			return assets.Result{}, assets.Rejection("quantity_unavailable")
		}
		total := o.UnitPrice * r.Quantity
		tax := int64(math.Ceil(float64(total) * .10))
		if err := t.Coins(ctx, r.ActorID, -total); err != nil {
			return assets.Result{}, err
		}
		if err := t.Coins(ctx, o.SellerID, total-tax); err != nil {
			return assets.Result{}, err
		}
		if o.Source == "admin" {
			if o.Kind == "stack" {
				err = t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: o.ItemID, Tier: "normal", Quantity: r.Quantity}})
			} else {
				err = t.ReturnOrderEquipment(ctx, o.SellerID, r.ActorID, o.ID, o.Kind == "rod", o.RodName)
			}
		} else if o.Kind == "stack" {
			err = t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: o.ItemID, Tier: "normal", Quantity: r.Quantity}})
		} else {
			err = t.ReturnOrderEquipment(ctx, o.SellerID, r.ActorID, o.ID, o.Kind == "rod", o.RodName)
		}
		if err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.market_orders SET remaining=remaining-$2,state=CASE WHEN remaining=$2 THEN 'sold' ELSE 'open' END,closed_operation=CASE WHEN remaining=$2 THEN $3::bigint ELSE NULL END WHERE id=$1`, o.ID, r.Quantity, t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.market_fills(operation_id,order_id,buyer_id,quantity,total,tax) VALUES($1,$2,$3,$4,$5,$6)`, t.OperationID(), o.ID, r.ActorID, r.Quantity, total, tax); err != nil {
			return assets.Result{}, err
		}
		_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.market_charges(operation_id,order_id,account_id,kind,amount) VALUES($1,$2,$3,'tax',$4)`, t.OperationID(), o.ID, o.SellerID, tax)
		return assets.Result{Status: "purchased", ResourceID: strconv.FormatInt(o.ID, 10)}, err
	})
}
func (s *Service) CloseOrder(ctx context.Context, actor, id int64, key string, expire bool) (assets.Result, error) {
	if actor < 1 || id < 1 || strings.HasPrefix(key, "market:expire:") {
		return assets.Result{}, assets.ErrInvalid
	}
	if (expire || strings.HasPrefix(key, "market:order-expire:")) && (!expire || key != fmt.Sprintf("market:order-expire:%d", id)) {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "market_close", RuleVersion: "market-v0.21.4", Players: []int64{actor}, Input: struct {
		ID     int64
		Expire bool
	}{id, expire}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		o, err := readOrder(ctx, t.SQL(), id, true)
		if err != nil {
			return assets.Result{}, err
		}
		if o.SellerID != actor {
			return assets.Result{}, assets.Rejection("not_listing_owner")
		}
		if o.State != "open" {
			return assets.Result{}, assets.Rejection("listing_closed")
		}
		expired, err := orderExpired(ctx, t.SQL(), o)
		if err != nil {
			return assets.Result{}, err
		}
		if expire && !expired {
			return assets.Result{}, assets.ErrDeferred
		}
		if o.Source == "admin" {
			if o.Kind != "stack" {
				err = t.DiscardOrderEquipment(ctx, o.SellerID, o.ID)
			}
		} else if o.Kind == "stack" {
			err = t.Stacks(ctx, actor, []assets.StackDelta{{ItemID: o.ItemID, Tier: "normal", Quantity: o.Remaining}})
		} else {
			err = t.ReturnOrderEquipment(ctx, actor, actor, id, o.Kind == "rod", o.RodName)
		}
		if err != nil {
			var rejection assets.Rejection
			if expire && errors.As(err, &rejection) {
				return assets.Result{}, assets.ErrDeferred
			}
			return assets.Result{}, err
		}
		state := "cancelled"
		if expired {
			state = "expired"
		}
		_, err = t.SQL().Exec(ctx, `UPDATE fishing.market_orders SET state=$2,remaining=0,closed_operation=$3 WHERE id=$1`, id, state, t.OperationID())
		return assets.Result{Status: state, ResourceID: strconv.FormatInt(id, 10)}, err
	})
}
func (s *Service) OpenOrders(ctx context.Context, after int64, limit int) ([]Order, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, assets.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT id,seller_id,kind,COALESCE(item_id,''),quantity,remaining,unit_price,rod_name,state,expires_at,source FROM fishing.market_orders WHERE state='open' AND expires_at>clock_timestamp() AND id>$1 ORDER BY id LIMIT $2`, after, limit)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	out := []Order{}
	for rows.Next() {
		var o Order
		if err := rows.Scan(&o.ID, &o.SellerID, &o.Kind, &o.ItemID, &o.Quantity, &o.Remaining, &o.UnitPrice, &o.RodName, &o.State, &o.ExpiresAt, &o.Source); err != nil {
			return nil, assets.ErrUnavailable
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
func (s *Service) ExpireOrders(ctx context.Context, after int64) (int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,seller_id FROM fishing.market_orders WHERE state='open' AND expires_at<=clock_timestamp() AND id>$1 ORDER BY id LIMIT 64`, after)
	if err != nil {
		return after, err
	}
	type pair struct{ id, seller int64 }
	list := []pair{}
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.id, &p.seller); err != nil {
			rows.Close()
			return after, err
		}
		list = append(list, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return after, err
	}
	for _, p := range list {
		_, err = s.CloseOrder(ctx, p.seller, p.id, fmt.Sprintf("market:order-expire:%d", p.id), true)
		if err != nil && !errors.Is(err, assets.ErrDeferred) {
			return after, err
		}
		after = p.id
	}
	if len(list) < 64 {
		after = 0
	}
	return after, err
}
