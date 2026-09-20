// Package market provides an internal fixed-price, indivisible-lot prototype.
package market

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	assets *assets.Service
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool, assets.New(pool)} }

type List struct {
	ActorID                      int64
	RequestKey                   string
	ItemID, Tier                 string
	Quantity, EquipmentID, Price int64
	Lifetime                     time.Duration
}

// List escrows either one stack lot or one equipment instance, at a fixed price.
func (s *Service) List(ctx context.Context, r List) (assets.Result, error) {
	if r.ActorID <= 0 || r.Price < 1 || r.Price > assets.MaxCoins || r.Lifetime < 100*time.Millisecond || r.Lifetime > 24*time.Hour {
		return assets.Result{}, assets.ErrInvalid
	}
	gear := r.EquipmentID > 0
	if gear && (r.ItemID != "" || r.Tier != "" || r.Quantity != 0) || !gear && (r.EquipmentID != 0 || r.ItemID == "" || len(r.ItemID) > 128 || r.Quantity < 1 || r.Quantity > assets.MaxCoins || (r.Tier != "normal" && r.Tier != "large" && r.Tier != "giant")) {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "market_list", RuleVersion: "market-lot-v1", Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var id int64
		var err error
		if gear {
			var exists bool
			if err = t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.equipment_instances WHERE id=$1 AND owner_id=$2 AND lifecycle='available')`, r.EquipmentID, r.ActorID).Scan(&exists); err != nil {
				return assets.Result{}, err
			}
			if !exists {
				return assets.Result{}, assets.Rejection("equipment_unavailable")
			}
			err = t.SQL().QueryRow(ctx, `INSERT INTO fishing.market_listings(seller_id,equipment_id,price,created_operation,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+($5::bigint*interval '1 millisecond')) RETURNING id`, r.ActorID, r.EquipmentID, r.Price, t.OperationID(), r.Lifetime.Milliseconds()).Scan(&id)
			if err == nil {
				err = t.HoldEquipment(ctx, r.ActorID, r.EquipmentID, id)
			}
		} else {
			if err = t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: r.ItemID, Tier: r.Tier, Quantity: -r.Quantity}}); err != nil {
				return assets.Result{}, err
			}
			err = t.SQL().QueryRow(ctx, `INSERT INTO fishing.market_listings(seller_id,item_id,tier,quantity,price,created_operation,expires_at) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+($7::bigint*interval '1 millisecond')) RETURNING id`, r.ActorID, r.ItemID, r.Tier, r.Quantity, r.Price, t.OperationID(), r.Lifetime.Milliseconds()).Scan(&id)
		}
		return assets.Result{Status: "listed", ResourceID: strconv.FormatInt(id, 10)}, err
	})
}

type Purchase struct {
	ActorID, ListingID, ExpectedPrice int64
	RequestKey                        string
}

func (s *Service) Buy(ctx context.Context, r Purchase) (assets.Result, error) {
	if r.ActorID <= 0 || r.ListingID <= 0 || r.ExpectedPrice < 1 || r.ExpectedPrice > assets.MaxCoins {
		return assets.Result{}, assets.ErrInvalid
	}
	// Seller is immutable. This nonlocking read only discovers the complete lock
	// set; price, status, ownership and expiry are re-read under ordered locks.
	seller, err := s.seller(ctx, r.ListingID)
	if err != nil {
		return assets.Result{}, err
	}
	if seller == r.ActorID {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "market_buy", RuleVersion: "market-lot-v1", Players: []int64{seller, r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		lot, err := readLocked(ctx, t, r.ListingID)
		if err != nil {
			return assets.Result{}, err
		}
		if lot.SellerID != seller {
			return assets.Result{}, assets.ErrUnavailable
		}
		if lot.State != "open" {
			return assets.Result{}, assets.Rejection("listing_closed")
		}
		if lot.Expired {
			return assets.Result{}, assets.Rejection("listing_expired")
		}
		if lot.Price != r.ExpectedPrice {
			return assets.Result{}, assets.Rejection("price_changed")
		}
		if err = t.Coins(ctx, r.ActorID, -lot.Price); err != nil {
			return assets.Result{}, err
		}
		if err = t.Coins(ctx, seller, lot.Price); err != nil {
			return assets.Result{}, err
		}
		if err = release(ctx, t, lot, r.ActorID); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.market_listings SET state='sold',buyer_id=$2,closed_operation=$3 WHERE id=$1`, r.ListingID, r.ActorID, t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "purchased", ResourceID: strconv.FormatInt(r.ListingID, 10)}, nil
	})
}

type Close struct {
	ActorID, ListingID int64
	RequestKey         string
	Expire             bool
}

func (s *Service) Close(ctx context.Context, r Close) (assets.Result, error) {
	if r.ActorID <= 0 || r.ListingID <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	if strings.HasPrefix(r.RequestKey, "market:expire:") && (!r.Expire || r.RequestKey != fmt.Sprintf("market:expire:%d", r.ListingID)) {
		return assets.Result{}, assets.ErrInvalid
	}
	if strings.HasPrefix(r.RequestKey, "market:order-expire:") {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "market_close", RuleVersion: "market-lot-v1", Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		lot, err := readLocked(ctx, t, r.ListingID)
		if err != nil {
			return assets.Result{}, err
		}
		if lot.SellerID != r.ActorID {
			return assets.Result{}, assets.Rejection("not_listing_owner")
		}
		if lot.State != "open" {
			return assets.Result{}, assets.Rejection("listing_closed")
		}
		if r.Expire && !lot.Expired {
			return assets.Result{}, assets.ErrDeferred
		}
		if err = release(ctx, t, lot, r.ActorID); err != nil {
			var rejected assets.Rejection
			if r.Expire && errors.As(err, &rejected) {
				return assets.Result{}, assets.ErrDeferred
			}
			return assets.Result{}, err
		}
		state := "cancelled"
		if lot.Expired {
			state = "expired"
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.market_listings SET state=$2,closed_operation=$3 WHERE id=$1`, r.ListingID, state, t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: state, ResourceID: strconv.FormatInt(r.ListingID, 10)}, nil
	})
}

// Listing is a bounded public projection. No account secrets or equipment seeds.
type Listing struct {
	ID          int64  `json:"id,string"`
	SellerID    int64  `json:"sellerId,string"`
	ItemID      string `json:"itemId,omitempty"`
	Tier        string `json:"tier,omitempty"`
	Quantity    int64  `json:"quantity"`
	EquipmentID int64  `json:"equipmentId,omitempty,string"`
	Price       int64  `json:"price"`
	State       string `json:"state"`
	Expired     bool   `json:"expired"`
}

func readLocked(ctx context.Context, t *assets.Transaction, id int64) (Listing, error) {
	var l Listing
	var expires time.Time
	err := t.SQL().QueryRow(ctx, `SELECT id,seller_id,COALESCE(item_id,''),COALESCE(tier,''),COALESCE(quantity,0),COALESCE(equipment_id,0),price,state,expires_at FROM fishing.market_listings WHERE id=$1 FOR UPDATE`, id).Scan(&l.ID, &l.SellerID, &l.ItemID, &l.Tier, &l.Quantity, &l.EquipmentID, &l.Price, &l.State, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, assets.Rejection("listing_not_found")
	}
	if err == nil {
		// Evaluate time after lock acquisition, including any database lock wait.
		err = t.SQL().QueryRow(ctx, `SELECT $1::timestamptz<=clock_timestamp()`, expires).Scan(&l.Expired)
	}
	return l, err
}
func release(ctx context.Context, t *assets.Transaction, l Listing, recipient int64) error {
	if l.EquipmentID > 0 {
		return t.ReleaseEquipment(ctx, l.SellerID, recipient, l.EquipmentID, l.ID)
	}
	return t.Stacks(ctx, recipient, []assets.StackDelta{{ItemID: l.ItemID, Tier: l.Tier, Quantity: l.Quantity}})
}
func (s *Service) seller(ctx context.Context, id int64) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var seller int64
	err := s.pool.QueryRow(ctx, `SELECT seller_id FROM fishing.market_listings WHERE id=$1`, id).Scan(&seller)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, assets.ErrNotFound
	}
	if err != nil {
		return 0, assets.ErrUnavailable
	}
	return seller, nil
}

// Open uses keyset pagination. The cursor is the last returned ID; at most 100
// rows are read. Concurrent purchases may close a row after it is displayed.
func (s *Service) Open(ctx context.Context, after int64, limit int) ([]Listing, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return nil, assets.ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx, `SELECT id,seller_id,COALESCE(item_id,''),COALESCE(tier,''),COALESCE(quantity,0),COALESCE(equipment_id,0),price,state FROM fishing.market_listings WHERE state='open' AND expires_at>clock_timestamp() AND id>$1 ORDER BY id LIMIT $2`, after, limit)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	out := []Listing{}
	for rows.Next() {
		var l Listing
		if err = rows.Scan(&l.ID, &l.SellerID, &l.ItemID, &l.Tier, &l.Quantity, &l.EquipmentID, &l.Price, &l.State); err != nil {
			return nil, assets.ErrUnavailable
		}
		out = append(out, l)
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	return out, nil
}

// Expire scans without locks. Returns the final scanned ID to rotate fairly
// past lots whose owner currently lacks space for an escrow return.
func (s *Service) Expire(ctx context.Context, after int64, limit int) (int64, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return 0, assets.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT id,seller_id FROM fishing.market_listings WHERE state='open' AND expires_at<=clock_timestamp() AND id>$1 ORDER BY id LIMIT $2`, after, limit)
	if err != nil {
		return after, assets.ErrUnavailable
	}
	type candidate struct{ id, seller int64 }
	batch := []candidate{}
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.id, &c.seller); err != nil {
			break
		}
		batch = append(batch, c)
	}
	readErr := rows.Err()
	rows.Close()
	if err != nil || readErr != nil {
		return after, assets.ErrUnavailable
	}
	var failed bool
	for _, c := range batch {
		_, err = s.Close(ctx, Close{ActorID: c.seller, ListingID: c.id, RequestKey: fmt.Sprintf("market:expire:%d", c.id), Expire: true})
		if err != nil {
			failed = true
		}
		after = c.id
	}
	if len(batch) < limit {
		after = 0
	}
	if failed {
		return after, assets.ErrUnavailable
	}
	return after, nil
}
