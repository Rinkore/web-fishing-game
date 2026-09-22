package prototype_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/testdb"
)

type fixture struct {
	t   *testing.T
	ctx context.Context
	db  testdb.DB
	a   *assets.Service
	f   *fishing.Service
	m   *market.Service
	seq int
}

func setup(t *testing.T) *fixture {
	db := testdb.New(t, true)
	f := &fixture{t: t, ctx: context.Background(), db: db, a: assets.New(db.App), f: fishing.New(db.App), m: market.New(db.App)}
	f.exec(`INSERT INTO fishing.item_definitions(id,kind,part) VALUES ('fish','fish',NULL),('ore','material',NULL),('rod','equipment','rod')`)
	f.exec(`INSERT INTO fishing.fishing_rules(version,interval_ms,bite_ppm,item_id,tier,quantity,sale_price) VALUES ('caught-v1',1000,1000000,'fish','normal',2,7),('empty-v1',1000,0,'fish','normal',2,7),('random-v1',1000,500000,'fish','normal',2,7),('large-v1',1000,1000000,'fish','large',2,7)`)
	return f
}
func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Admin.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) num(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func (f *fixture) key() string { f.seq++; return fmt.Sprintf("p-%d", f.seq) }
func (f *fixture) player() int64 {
	f.t.Helper()
	var id int64
	if err := f.db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO fishing.player_state(account_id) VALUES ($1)`, id)
	f.exec(`INSERT INTO fishing.wallets(account_id) VALUES ($1)`, id)
	return id
}
func (f *fixture) reward(owner, coins, fish int64) {
	f.t.Helper()
	c := assets.Change{ActorID: owner, RequestKey: f.key(), RuleVersion: "test-v1", Reason: "reward", Coins: coins}
	if fish > 0 {
		c.Stacks = []assets.StackDelta{{ItemID: "fish", Tier: "normal", Quantity: fish}}
	}
	r, err := f.a.ApplyChange(f.ctx, c)
	f.want(r, err, "applied")
}
func (f *fixture) want(r assets.Result, err error, status string) assets.Result {
	f.t.Helper()
	if err != nil || r.Status != status {
		f.t.Fatalf("want %s: result=%+v err=%v", status, r, err)
	}
	return r
}
func (f *fixture) gear(owner int64) int64 {
	f.t.Helper()
	r, err := f.a.ApplyChange(f.ctx, assets.Change{ActorID: owner, RequestKey: f.key(), RuleVersion: "test-v1", Reason: "reward", Create: []assets.EquipmentSpec{{DefinitionID: "rod", Part: "rod", Attributes: json.RawMessage(`{"quality":"mythic","affix":{"source":"ct","value":-2.5}}`)}}})
	f.want(r, err, "applied")
	return parse(f.t, r.EquipmentIDs[0])
}
func parse(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}
func (f *fixture) connect(owner int64) int64 {
	r, err := f.f.Connection(f.ctx, fishing.Connection{ActorID: owner, RequestKey: f.key(), Action: "connect"})
	return f.want(r, err, "connected").Generation
}
func (f *fixture) start(owner int64, rule string, auto bool) fishing.Candidate {
	connection := f.connect(owner)
	r, err := f.f.Start(f.ctx, fishing.Start{ActorID: owner, RequestKey: f.key(), RuleVersion: rule, ConnectionGeneration: connection, AutoSell: auto})
	f.want(r, err, "started")
	return fishing.Candidate{OwnerID: owner, SessionID: parse(f.t, r.ResourceID), Generation: r.Generation, Sequence: r.Sequence}
}
func (f *fixture) due(c fishing.Candidate) {
	f.exec(`UPDATE fishing.fishing_sessions SET due_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, c.SessionID)
}
func (f *fixture) lot(owner, qty, gear, price int64, lifetime time.Duration) int64 {
	r := market.List{ActorID: owner, RequestKey: f.key(), Price: price, EquipmentID: gear, Lifetime: lifetime}
	if gear == 0 {
		r.ItemID = "fish"
		r.Tier = "normal"
		r.Quantity = qty
	}
	result, err := f.m.List(f.ctx, r)
	f.want(result, err, "listed")
	return parse(f.t, result.ResourceID)
}
func (f *fixture) balance(owner int64) int64 {
	return f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner)
}
func (f *fixture) qty(owner int64) int64 {
	return f.num(`SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='fish' AND tier='normal'),0)`, owner)
}

func (f *fixture) reconcile() {
	f.t.Helper()
	for _, q := range []string{
		`SELECT count(*) FROM fishing.wallets w WHERE coins<>(SELECT COALESCE(sum(delta),0) FROM fishing.asset_entries e WHERE e.account_id=w.account_id)`,
		`SELECT count(*) FROM fishing.inventory_stacks s WHERE quantity<>(SELECT COALESCE(sum(delta),0) FROM fishing.inventory_entries e WHERE e.owner_id=s.owner_id AND e.item_id=s.item_id AND e.tier=s.tier)`,
		`SELECT count(*) FROM fishing.command_results WHERE result IS NULL`,
		`SELECT count(*) FROM fishing.asset_operations a WHERE NOT EXISTS(SELECT 1 FROM fishing.outbox_events e WHERE e.operation_id=a.id)`,
		`SELECT count(*) FROM fishing.equipment_instances e WHERE (lifecycle='escrow')<>(EXISTS(SELECT 1 FROM fishing.market_listings l WHERE l.equipment_id=e.id AND l.seller_id=e.owner_id AND l.id=e.escrow_listing_id AND l.state='open'))`,
		`SELECT count(*) FROM fishing.market_listings l JOIN fishing.equipment_instances e ON e.id=l.equipment_id WHERE l.state='open' AND (e.lifecycle<>'escrow' OR e.escrow_listing_id<>l.id OR e.owner_id<>l.seller_id)`,
		`SELECT count(*) FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id<>e.owner_id OR e.lifecycle<>'available'`,
		`SELECT count(*) FROM fishing.fishing_settlements s LEFT JOIN fishing.asset_operations a ON a.id=s.operation_id WHERE a.id IS NULL OR a.kind<>'fishing_settle'`,
	} {
		if n := f.num(q); n != 0 {
			f.t.Fatalf("reconciliation found %d invalid rows", n)
		}
	}
}
