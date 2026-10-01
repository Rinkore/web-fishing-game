package workshop

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

type fixture struct {
	t      *testing.T
	db     testdb.DB
	s      *Service
	assets *assets.Service
	c      *rules.Catalog
	owner  int64
	ctx    context.Context
	seq    int
}

func setup(t *testing.T) *fixture {
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Constants["GEAR_SYSTEM"] = json.RawMessage(`{"enabled":false}`) // Historical workshop contract only.
	f := &fixture{t: t, db: db, c: c, ctx: context.Background(), s: New(db.App, c), assets: assets.New(db.App)}
	if err := SeedDefinitions(f.ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&f.owner); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err := db.Admin.Exec(f.ctx, sql, f.owner); err != nil {
			t.Fatal(err)
		}
	}
	r, err := f.assets.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: "resources", Reason: "reward", RuleVersion: "test-v1", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "relic", Tier: "normal", Quantity: 1000}, {ItemID: "dragonpearl", Tier: "normal", Quantity: 100}, {ItemID: "stardust", Tier: "normal", Quantity: 100}}})
	if err != nil || r.Status != "applied" {
		t.Fatal("resources", err)
	}
	return f
}
func (f *fixture) key() string { f.seq++; return fmt.Sprintf("craft-%d", f.seq) }
func (f *fixture) num(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func TestIntegrationChest(t *testing.T) {
	f := setup(t)
	r, err := f.s.Chest(f.ctx, ChestCommand{ActorID: f.owner, RequestKey: f.key(), ChestID: "chest_king", Action: "craft", Quantity: 1})
	if err != nil || r.Status != "crafted" {
		t.Fatal("chest craft", r, err)
	}
	open := ChestCommand{ActorID: f.owner, RequestKey: f.key(), ChestID: "chest_king", Action: "open", Quantity: 1, BaseID: "gear_line_1"}
	r, err = f.s.Chest(f.ctx, open)
	if err != nil || r.Status != "opened" {
		t.Fatal("chest open", r, err)
	}
	repeat, err := f.s.Chest(f.ctx, open)
	if err != nil || repeat.OperationID != r.OperationID {
		t.Fatal("chest duplicate")
	}
	if f.num(`SELECT count FROM fishing.player_codex WHERE owner_id=$1 AND item_id='gear_line_1'`, f.owner) != 1 {
		t.Fatal("codex duplicate")
	}
	if f.num(`SELECT w.coins-COALESCE(sum(e.delta),0) FROM fishing.wallets w LEFT JOIN fishing.asset_entries e ON e.account_id=w.account_id WHERE w.account_id=$1 GROUP BY w.coins`, f.owner) != 0 {
		t.Fatal("craft ledger mismatch")
	}
}
