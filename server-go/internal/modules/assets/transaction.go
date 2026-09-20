package assets

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// SQL has no Commit, Rollback or Begin: participants use the caller's transaction.
// Business tables belong to their modules; only assets writes asset tables.
type SQL interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Command struct {
	ActorID                       int64
	RequestKey, Kind, RuleVersion string
	Players                       []int64
	Input                         any // validated, immutable server input; never credentials or private seeds
}

type Transaction struct {
	u       *assetTx
	players map[int64]bool
}

// Do not expose the pgx.Tx dynamic value: even a type assertion by a participant
// must not provide access to Commit or Rollback.
type scopedSQL struct{ tx pgx.Tx }

func (q scopedSQL) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return q.tx.Exec(ctx, sql, args...)
}
func (q scopedSQL) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return q.tx.Query(ctx, sql, args...)
}
func (q scopedSQL) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return q.tx.QueryRow(ctx, sql, args...)
}
func (t *Transaction) SQL() SQL           { return scopedSQL{t.u.tx} }
func (t *Transaction) OperationID() int64 { return t.u.op }
func (t *Transaction) Coins(ctx context.Context, owner, delta int64) error {
	if !t.players[owner] || !amountValid(delta) {
		return ErrInvalid
	}
	return t.u.coins(ctx, owner, delta)
}
func (t *Transaction) Stacks(ctx context.Context, owner int64, deltas []StackDelta) error {
	items, ok := normalizeStacks(deltas)
	if !t.players[owner] || !ok {
		return ErrInvalid
	}
	return t.u.stacks(ctx, owner, items)
}

// Run owns the command, ordered player locks, retry, savepoint, event and commit.
// The callback must do bounded local work only and must not retain Transaction.
func (s *Service) Run(ctx context.Context, c Command, apply func(context.Context, *Transaction) (Result, error)) (Result, error) {
	if c.ActorID <= 0 || !validKey(c.RequestKey) || !validKey(c.RuleVersion) || apply == nil {
		return Result{}, ErrInvalid
	}
	if reserved := systemKind(c.RequestKey); reserved != "" && reserved != c.Kind {
		return Result{}, ErrInvalid
	}
	switch c.Kind {
	case "party_change":
	case "sea_quests_refresh", "sea_quest_claim":
	case "sea_voyage", "sea_anchor":
	case "ship_upgrade", "chart_craft":
	case "feature_publish":
	case "shop_sell", "autosell_config", "autosell_run":
	case "mall_buy", "friend_change":
	case "fishing_connection", "fishing_start", "fishing_stop", "fishing_settle", "market_list", "market_buy", "market_close", "trade_invite", "trade_respond", "trade_offer", "trade_confirm", "trade_cancel", "trade_expire", "workshop_smelt", "workshop_recast", "workshop_forge", "chest_craft", "chest_open":
	default:
		return Result{}, ErrInvalid
	}
	players, ok := normalizeIDs(c.Players)
	if !ok || len(players) < 1 || len(players) > 2 {
		return Result{}, ErrInvalid
	}
	locked := map[int64]bool{}
	for _, id := range players {
		locked[id] = true
	}
	if !locked[c.ActorID] {
		return Result{}, ErrInvalid
	}
	data, err := json.Marshal(struct {
		Version, Kind, Rule string
		Players             []int64
		Input               any
	}{"module-command-v1", c.Kind, c.RuleVersion, players, c.Input})
	if err != nil || len(data) > 65536 {
		return Result{}, ErrInvalid
	}
	return s.execute(ctx, command{c.ActorID, c.RequestKey, c.Kind, c.RuleVersion, fingerprint(json.RawMessage(data)), players}, func(ctx context.Context, u *assetTx) (Result, error) {
		return apply(ctx, &Transaction{u, locked})
	})
}

// MoveEquipment transfers a loose instance after both owners are locked.
func (t *Transaction) MoveEquipment(ctx context.Context, from, to, id int64) error {
	if from == to || !t.players[from] || !t.players[to] || id <= 0 {
		return ErrInvalid
	}
	return t.u.moveEquipment(ctx, from, to, id)
}

// HoldEquipment moves an unbound instance into a listing's escrow. The listing
// row must already exist in this transaction; all seller/player locks are held.
func (t *Transaction) HoldEquipment(ctx context.Context, owner, id, listing int64) error {
	if !t.players[owner] || id <= 0 || listing <= 0 {
		return ErrInvalid
	}
	var allowed bool
	if err := t.u.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.equipment_instances e JOIN fishing.market_listings l ON l.equipment_id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND e.lifecycle='available' AND l.id=$3 AND l.seller_id=$2 AND l.state='open')`, id, owner, listing).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return Rejection("equipment_unavailable")
	}
	var bound bool
	if err := t.u.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.rod_components WHERE equipment_id=$1)`, id).Scan(&bound); err != nil {
		return err
	}
	if bound {
		return Rejection("equipment_locked")
	}
	if _, err := t.u.tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='escrow',escrow_listing_id=$2 WHERE id=$1`, id, listing); err != nil {
		return err
	}
	_, err := t.u.tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,next_owner,action) VALUES ($1,$2,$3,$3,'hold')`, t.u.op, id, owner)
	return err
}
func (t *Transaction) ReleaseEquipment(ctx context.Context, seller, buyer, id, listing int64) error {
	if !t.players[seller] || !t.players[buyer] || id <= 0 || listing <= 0 {
		return ErrInvalid
	}
	tag, err := t.u.tx.Exec(ctx, `UPDATE fishing.equipment_instances SET owner_id=$2,lifecycle='available',escrow_listing_id=NULL WHERE id=$1 AND owner_id=$3 AND lifecycle='escrow' AND escrow_listing_id=$4`, id, buyer, seller, listing)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("escrow invariant violated")
	}
	_, err = t.u.tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,next_owner,action) VALUES ($1,$2,$3,$4,'release')`, t.u.op, id, seller, buyer)
	return err
}
