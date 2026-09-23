// Package trade implements bilateral, versioned offers with atomic settlement.
package trade

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
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

type Stack struct {
	ID       string `json:"id"`
	Quantity int64  `json:"qty"`
}
type Offer struct {
	Stacks    []Stack `json:"stacks"`
	Equipment []int64 `json:"equipment"`
}
type Invite struct {
	ActorID, TargetID int64
	RequestKey        string
}
type Change struct {
	ActorID, TradeID, Revision int64
	RequestKey, Action         string
	Offer                      Offer
	Accept                     bool
}
type View struct {
	ID                int64     `json:"id,string"`
	AID               int64     `json:"a,string"`
	BID               int64     `json:"b,string"`
	State             string    `json:"state"`
	Revision          int64     `json:"revision,string"`
	AOffer            Offer     `json:"aOffer"`
	BOffer            Offer     `json:"bOffer"`
	AConfirm          bool      `json:"aConfirm"`
	BConfirm          bool      `json:"bConfirm"`
	CooldownUntil     time.Time `json:"cooldownUntil"`
	ExpiresAt         time.Time `json:"expiresAt"`
	expired, cooldown bool
}

func result(v View, status string) assets.Result {
	return assets.Result{Status: status, ResourceID: strconv.FormatInt(v.ID, 10), Generation: v.Revision}
}
func online(ctx context.Context, q assets.SQL, a, b int64) (bool, error) {
	var count int
	err := q.QueryRow(ctx, `SELECT count(*) FROM fishing.fishing_connections WHERE owner_id=ANY($1::bigint[]) AND expires_at>clock_timestamp()`, []int64{a, b}).Scan(&count)
	return count == 2, err
}
func (s *Service) Invite(ctx context.Context, r Invite) (assets.Result, error) {
	if r.ActorID <= 0 || r.TargetID <= 0 || r.ActorID == r.TargetID {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "trade_invite", RuleVersion: "trade-v1", Players: []int64{r.ActorID, r.TargetID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		alive, err := online(ctx, t.SQL(), r.ActorID, r.TargetID)
		if err != nil {
			return assets.Result{}, err
		}
		if !alive {
			return assets.Result{}, assets.Rejection("player_offline")
		}
		var exists bool
		if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.trades WHERE LEAST(a_id,b_id)=LEAST($1::bigint,$2::bigint) AND GREATEST(a_id,b_id)=GREATEST($1::bigint,$2::bigint) AND state IN ('invited','accepted'))`, r.ActorID, r.TargetID).Scan(&exists); err != nil {
			return assets.Result{}, err
		}
		if exists {
			return assets.Result{}, assets.Rejection("trade_exists")
		}
		var id int64
		err = t.SQL().QueryRow(ctx, `INSERT INTO fishing.trades(a_id,b_id,created_operation) VALUES($1,$2,$3) RETURNING id`, r.ActorID, r.TargetID, t.OperationID()).Scan(&id)
		return result(View{ID: id, Revision: 1}, "invited"), err
	})
}
func read(ctx context.Context, q assets.SQL, id, actor int64, lock bool) (View, error) {
	sql := `SELECT id,a_id,b_id,state,revision,a_offer,b_offer,a_confirm,b_confirm,CASE WHEN cooldown_until='-infinity' THEN '1970-01-01'::timestamptz ELSE cooldown_until END,expires_at,expires_at<=clock_timestamp(),cooldown_until>clock_timestamp() FROM fishing.trades WHERE id=$1 AND ($2=a_id OR $2=b_id)`
	if lock {
		sql += " FOR UPDATE"
	}
	var v View
	var a, b []byte
	err := q.QueryRow(ctx, sql, id, actor).Scan(&v.ID, &v.AID, &v.BID, &v.State, &v.Revision, &a, &b, &v.AConfirm, &v.BConfirm, &v.CooldownUntil, &v.ExpiresAt, &v.expired, &v.cooldown)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, assets.Rejection("trade_not_found")
	}
	if err != nil {
		return v, err
	}
	// Evaluate deadlines after acquiring the row lock, including time spent waiting.
	if lock {
		if err := q.QueryRow(ctx, `SELECT $1::timestamptz<=clock_timestamp(),$2::timestamptz>clock_timestamp()`, v.ExpiresAt, v.CooldownUntil).Scan(&v.expired, &v.cooldown); err != nil {
			return v, err
		}
	}
	if json.Unmarshal(a, &v.AOffer) != nil || json.Unmarshal(b, &v.BOffer) != nil {
		return v, assets.ErrUnavailable
	}
	return v, nil
}
func (s *Service) View(ctx context.Context, id, actor int64) (View, error) {
	return read(ctx, s.pool, id, actor, false)
}
func normalize(o Offer) (Offer, bool) {
	if len(o.Stacks)+len(o.Equipment) > 100 {
		return o, false
	}
	seen := map[string]bool{}
	for _, x := range o.Stacks {
		if x.ID == "" || len(x.ID) > 128 || x.Quantity < 1 || x.Quantity > assets.MaxCoins || seen[x.ID] {
			return o, false
		}
		seen[x.ID] = true
	}
	ids := map[int64]bool{}
	for _, id := range o.Equipment {
		if id < 1 || ids[id] {
			return o, false
		}
		ids[id] = true
	}
	o.Stacks = append([]Stack{}, o.Stacks...)
	o.Equipment = append([]int64{}, o.Equipment...)
	sort.Slice(o.Stacks, func(i, j int) bool { return o.Stacks[i].ID < o.Stacks[j].ID })
	sort.Slice(o.Equipment, func(i, j int) bool { return o.Equipment[i] < o.Equipment[j] })
	return o, true
}
func owns(ctx context.Context, q assets.SQL, owner int64, o Offer) (bool, error) {
	for _, x := range o.Stacks {
		var valid bool
		err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier='normal' AND quantity-bound_quantity>=$3)`, owner, x.ID, x.Quantity).Scan(&valid)
		if err != nil || !valid {
			return false, err
		}
	}
	for _, id := range o.Equipment {
		var valid bool
		err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.equipment_instances e WHERE e.id=$1 AND e.owner_id=$2 AND e.lifecycle='available' AND NOT e.reward_bound AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id))`, id, owner).Scan(&valid)
		if err != nil || !valid {
			return false, err
		}
	}
	return true, nil
}
func (s *Service) Change(ctx context.Context, r Change) (assets.Result, error) {
	if r.ActorID <= 0 || r.TradeID <= 0 || r.Revision < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	switch r.Action {
	case "respond", "offer", "confirm", "cancel":
	default:
		return assets.Result{}, assets.ErrInvalid
	}
	var ok bool
	r.Offer, ok = normalize(r.Offer)
	if !ok {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.Action != "offer" && (len(r.Offer.Stacks)+len(r.Offer.Equipment) > 0) {
		return assets.Result{}, assets.ErrInvalid
	}
	// Read immutable participants to acquire the complete, ascending lock set.
	v, err := s.View(ctx, r.TradeID, r.ActorID)
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "trade_" + r.Action, RuleVersion: "trade-v1", Players: []int64{v.AID, v.BID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		v, err := read(ctx, t.SQL(), r.TradeID, r.ActorID, true)
		if err != nil {
			return assets.Result{}, err
		}
		if v.State != "invited" && v.State != "accepted" {
			return assets.Result{}, assets.Rejection("trade_closed")
		}
		if v.Revision != r.Revision {
			return assets.Result{}, assets.Rejection("offer_changed")
		}
		alive, err := online(ctx, t.SQL(), v.AID, v.BID)
		if err != nil {
			return assets.Result{}, err
		}
		if v.expired || !alive {
			return closeTrade(ctx, t, v, "expired")
		}
		switch r.Action {
		case "cancel":
			return closeTrade(ctx, t, v, "cancelled")
		case "respond":
			if r.ActorID != v.BID || v.State != "invited" {
				return assets.Result{}, assets.Rejection("cannot_respond")
			}
			if !r.Accept {
				return closeTrade(ctx, t, v, "cancelled")
			}
			v.Revision++
			_, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET state='accepted',revision=revision+1 WHERE id=$1`, v.ID)
			return result(v, "accepted"), err
		case "offer":
			if v.State != "accepted" {
				return assets.Result{}, assets.Rejection("not_accepted")
			}
			valid, err := owns(ctx, t.SQL(), r.ActorID, r.Offer)
			if err != nil {
				return assets.Result{}, err
			}
			if !valid {
				return assets.Result{}, assets.Rejection("offer_unavailable")
			}
			data, _ := json.Marshal(r.Offer)
			column := "a_offer"
			if r.ActorID == v.BID {
				column = "b_offer"
			}
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.trades SET `+column+`=$2,revision=revision+1,cooldown_until=CASE WHEN a_confirm OR b_confirm THEN clock_timestamp()+interval '3 seconds' ELSE cooldown_until END,a_confirm=false,b_confirm=false WHERE id=$1`, v.ID, data)
			v.Revision++
			return result(v, "offer_updated"), err
		case "confirm":
			if v.State != "accepted" {
				return assets.Result{}, assets.Rejection("not_accepted")
			}
			if v.cooldown {
				return assets.Result{}, assets.Rejection("confirmation_cooldown")
			}
			if r.ActorID == v.AID {
				v.AConfirm = true
			} else {
				v.BConfirm = true
			}
			if !v.AConfirm || !v.BConfirm {
				_, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET a_confirm=$2,b_confirm=$3 WHERE id=$1`, v.ID, v.AConfirm, v.BConfirm)
				return result(v, "confirmed"), err
			}
			for _, side := range []struct {
				id    int64
				offer Offer
			}{{v.AID, v.AOffer}, {v.BID, v.BOffer}} {
				valid, err := owns(ctx, t.SQL(), side.id, side.offer)
				if err != nil {
					return assets.Result{}, err
				}
				if !valid {
					_, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET a_confirm=false,b_confirm=false,revision=revision+1,cooldown_until=clock_timestamp()+interval '3 seconds' WHERE id=$1`, v.ID)
					v.Revision++
					return result(v, "offer_invalidated"), err
				}
			}
			net := map[string]int64{}
			for _, x := range v.AOffer.Stacks {
				net[x.ID] -= x.Quantity
			}
			for _, x := range v.BOffer.Stacks {
				net[x.ID] += x.Quantity
			}
			a, b := []assets.StackDelta{}, []assets.StackDelta{}
			for id, n := range net {
				if n != 0 {
					a = append(a, assets.StackDelta{ItemID: id, Tier: "normal", Quantity: n})
					b = append(b, assets.StackDelta{ItemID: id, Tier: "normal", Quantity: -n})
				}
			}
			if err := t.Stacks(ctx, v.AID, a); err != nil {
				return assets.Result{}, err
			}
			if err := t.Stacks(ctx, v.BID, b); err != nil {
				return assets.Result{}, err
			}
			for _, id := range v.AOffer.Equipment {
				if err := t.MoveEquipment(ctx, v.AID, v.BID, id); err != nil {
					return assets.Result{}, err
				}
			}
			for _, id := range v.BOffer.Equipment {
				if err := t.MoveEquipment(ctx, v.BID, v.AID, id); err != nil {
					return assets.Result{}, err
				}
			}
			_, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET state='done',revision=revision+1,a_confirm=true,b_confirm=true,settled_operation=$2 WHERE id=$1`, v.ID, t.OperationID())
			v.Revision++
			return result(v, "traded"), err
		}
		return assets.Result{}, assets.ErrInvalid
	})
}
func closeTrade(ctx context.Context, t *assets.Transaction, v View, state string) (assets.Result, error) {
	_, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET state=$2,revision=revision+1,a_confirm=false,b_confirm=false WHERE id=$1`, v.ID, state)
	v.Revision++
	return result(v, state), err
}
