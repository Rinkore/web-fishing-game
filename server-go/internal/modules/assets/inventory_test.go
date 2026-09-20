package assets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"fishing.local/server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

type assetFixture struct {
	t   *testing.T
	ctx context.Context
	db  testdb.DB
	s   *Service
	seq int
}

func newAssets(t *testing.T) *assetFixture {
	t.Helper()
	db := testdb.New(t, true)
	f := &assetFixture{t: t, ctx: context.Background(), db: db, s: New(db.App)}
	_, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES ('fish','fish',null),('ore','material',null),('chest','chest',null),('rod_base','equipment','rod'),('line_base','equipment','line')`)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *assetFixture) player() int64 {
	f.t.Helper()
	var id int64
	if err := f.db.Admin.QueryRow(f.ctx, "INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id").Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, "INSERT INTO fishing.player_state(account_id) VALUES ($1)", id); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, "INSERT INTO fishing.wallets(account_id) VALUES ($1)", id); err != nil {
		f.t.Fatal(err)
	}
	return id
}
func (f *assetFixture) key() string { f.seq++; return fmt.Sprintf("k-%d", f.seq) }
func (f *assetFixture) change(c Change, status string) Result {
	f.t.Helper()
	if c.RequestKey == "" {
		c.RequestKey = f.key()
	}
	if c.RuleVersion == "" {
		c.RuleVersion = "synthetic-v1"
	}
	r, err := f.s.ApplyChange(f.ctx, c)
	if err != nil || r.Status != status {
		f.t.Fatalf("change: %v status %s want %s", err, r.Status, status)
	}
	return r
}
func (f *assetFixture) gear(owner int64, part string) int64 {
	f.t.Helper()
	r := f.change(Change{ActorID: owner, Reason: "reward", Create: []EquipmentSpec{{part + "_base", part, json.RawMessage(`{"quality":"mythic","affixes":[{"type":"speed","value":-2.5,"source":"ct"}],"legacy":"same-definition-is-not-instance-id"}`)}}}, "applied")
	id, err := strconv.ParseInt(r.EquipmentIDs[0], 10, 64)
	if err != nil {
		f.t.Fatal(err)
	}
	return id
}
func (f *assetFixture) number(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func (f *assetFixture) coins(owner int64) int64 {
	return f.number("SELECT coins FROM fishing.wallets WHERE account_id=$1", owner)
}
func (f *assetFixture) qty(owner int64, item, tier string) int64 {
	return f.number("SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier=$3),0)", owner, item, tier)
}
func (f *assetFixture) exchange(r Exchange, status string) Result {
	f.t.Helper()
	if r.RequestKey == "" {
		r.RequestKey = f.key()
	}
	result, err := f.s.ExchangeAssets(f.ctx, r)
	if err != nil || result.Status != status {
		f.t.Fatalf("exchange %v %s want %s", err, result.Status, status)
	}
	return result
}
func (f *assetFixture) rod(r RodCommand, status string) Result {
	f.t.Helper()
	if r.RequestKey == "" {
		r.RequestKey = f.key()
	}
	result, err := f.s.ChangeRod(f.ctx, r)
	if err != nil || result.Status != status {
		f.t.Fatalf("rod %s: %v %s want %s", r.Action, err, result.Status, status)
	}
	return result
}
func (f *assetFixture) active(owner int64) int64 {
	return f.number("SELECT slot FROM fishing.rod_loadouts WHERE owner_id=$1 AND active", owner)
}

func TestInventoryInputValidation(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	base := Change{ActorID: 1, RequestKey: "key", RuleVersion: "r1", Reason: "reward", Coins: 1}
	for _, edit := range []func(*Change){
		func(c *Change) { c.Coins = MaxCoins + 1 }, func(c *Change) { c.Reason = "untrusted" }, func(c *Change) { c.Coins = -1 },
		func(c *Change) { c.Stacks = []StackDelta{{"ore", "normal", 1}, {"ore", "normal", 2}} },
		func(c *Change) { c.Consume = []int64{1, 1} }, func(c *Change) { c.RequestKey = "" },
		func(c *Change) { c.Stacks = []StackDelta{{"ore", "invalid", 1}} },
	} {
		c := base
		edit(&c)
		if _, err := s.ApplyChange(ctx, c); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid change accepted")
		}
	}
	for _, raw := range []string{`[]`, `null`, `{"x":1,"x":2}`, `{"x":9007199254740992}`, `{"x":1e9999999}`, `{"x":"\u0000"}`, "{\"x\":\"\xff\"}"} {
		c := base
		c.Create = []EquipmentSpec{{"rod_base", "rod", json.RawMessage(raw)}}
		if _, err := s.ApplyChange(ctx, c); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid attributes accepted: %q", raw)
		}
	}
	if _, err := s.ExchangeAssets(ctx, Exchange{ActorID: 1, RecipientID: 1, RequestKey: "x", Coins: 1}); !errors.Is(err, ErrInvalid) {
		t.Fatal("self exchange accepted")
	}
	if _, err := s.ChangeRod(ctx, RodCommand{ActorID: 1, RequestKey: "x", Action: "equip", Part: "invalid"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("invalid part accepted")
	}
}

func TestIntegrationInventoryAndEquipment(t *testing.T) {
	f := newAssets(t)
	t.Run("reward-replay-and-instance-identity", func(t *testing.T) {
		a := f.player()
		c := Change{ActorID: a, RequestKey: "reward", Reason: "reward", RuleVersion: "r1", Coins: 100, Stacks: []StackDelta{{"fish", "normal", 10}, {"fish", "large", 3}, {"fish", "giant", 1}}, Create: []EquipmentSpec{{"rod_base", "rod", json.RawMessage(`{"quality":"rare"}`)}, {"rod_base", "rod", json.RawMessage(`{"quality":"rare"}`)}}}
		r := f.change(c, "applied")
		repeat := f.change(c, "applied")
		if r.OperationID != repeat.OperationID || r.EquipmentIDs[0] == r.EquipmentIDs[1] || r.EquipmentIDs[1] != repeat.EquipmentIDs[1] || f.coins(a) != 100 {
			t.Fatal("replay or identity invalid")
		}
		if f.qty(a, "fish", "normal") != 10 || f.qty(a, "fish", "large") != 3 || f.qty(a, "fish", "giant") != 1 {
			t.Fatal("fish classification changed")
		}
		c.Coins++
		if _, err := f.s.ApplyChange(f.ctx, c); !errors.Is(err, ErrKeyConflict) {
			t.Fatal("changed reward key accepted")
		}
		if _, err := f.s.TransferCoins(f.ctx, Transfer{a, f.player(), 1, "reward"}); !errors.Is(err, ErrKeyConflict) {
			t.Fatal("cross-command key conflict ignored")
		}
	})
	t.Run("normal-cannot-consume-reserved-fish", func(t *testing.T) {
		a := f.player()
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"fish", "large", 5}, {"fish", "giant", 2}}}, "applied")
		f.change(Change{ActorID: a, Reason: "consume", Stacks: []StackDelta{{"fish", "normal", -1}}}, "insufficient_items")
		f.change(Change{ActorID: a, Reason: "consume", Stacks: []StackDelta{{"fish", "large", -2}}}, "applied")
		if f.qty(a, "fish", "large") != 3 || f.qty(a, "fish", "giant") != 2 {
			t.Fatal("reserved tiers incorrectly consumed")
		}
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"ore", "large", 1}}}, "invalid_item_tier")
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"rod_base", "normal", 1}}}, "invalid_item_tier")
	})
	t.Run("atomic-coins-items-equipment-exchange", func(t *testing.T) {
		a, b := f.player(), f.player()
		id := f.gear(a, "rod")
		f.change(Change{ActorID: a, Reason: "reward", Coins: 10, Stacks: []StackDelta{{"ore", "normal", 4}}}, "applied")
		f.change(Change{ActorID: b, Reason: "reward", Coins: 100}, "applied")
		r := Exchange{a, b, "bundle", -25, []StackDelta{{"ore", "normal", 2}}, []int64{id}}
		result := f.exchange(r, "exchanged")
		replay := f.exchange(r, "exchanged")
		if result.OperationID != replay.OperationID || f.coins(a) != 35 || f.coins(b) != 75 || f.qty(a, "ore", "normal") != 2 || f.qty(b, "ore", "normal") != 2 {
			t.Fatal("bundle did not conserve assets")
		}
		if f.number("SELECT owner_id FROM fishing.equipment_instances WHERE id=$1", id) != b {
			t.Fatal("equipment owner not transferred")
		}
		var intact bool
		if err := f.db.Admin.QueryRow(f.ctx, "SELECT attributes->'affixes'->0->>'source'='ct' AND attributes->'affixes'->0->>'value'='-2.5' FROM fishing.equipment_instances WHERE id=$1", id).Scan(&intact); err != nil || !intact {
			t.Fatal("attributes changed on transfer")
		}
		f.exchange(Exchange{ActorID: a, RecipientID: b, Coins: 1, Equipment: []int64{id}}, "equipment_unavailable")
		if f.coins(a) != 35 || f.coins(b) != 75 {
			t.Fatal("ownership rejection left partial coins")
		}
	})
	t.Run("craft-insufficient-input-rolls-back-earlier-effects", func(t *testing.T) {
		a := f.player()
		f.change(Change{ActorID: a, Reason: "reward", Coins: 50, Stacks: []StackDelta{{"fish", "normal", 3}}}, "applied")
		c := Change{ActorID: a, RequestKey: "craft-missing", Reason: "craft", RuleVersion: "r1", Coins: -10, Stacks: []StackDelta{{"fish", "normal", -2}, {"ore", "normal", -1}}, Create: []EquipmentSpec{{"rod_base", "rod", json.RawMessage(`{}`)}}}
		f.change(c, "insufficient_items")
		if f.coins(a) != 50 || f.qty(a, "fish", "normal") != 3 {
			t.Fatal("business rejection left partial mutations")
		}
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"ore", "normal", 1}}}, "applied")
		f.change(c, "insufficient_items") // terminal outcome does not change after funding
		c.RequestKey = "craft-success"
		result := f.change(c, "applied")
		if len(result.EquipmentIDs) != 1 || f.coins(a) != 40 || f.qty(a, "fish", "normal") != 1 || f.qty(a, "ore", "normal") != 0 {
			t.Fatal("craft assets wrong")
		}
		id, _ := strconv.ParseInt(result.EquipmentIDs[0], 10, 64)
		f.change(Change{ActorID: a, Reason: "consume", Consume: []int64{id}}, "applied")
		f.change(Change{ActorID: a, Reason: "consume", Consume: []int64{id}}, "equipment_unavailable")
	})
	t.Run("quantity-limit-counts-all-tiers", func(t *testing.T) {
		a := f.player()
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"fish", "normal", MaxCoins}}}, "applied")
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"fish", "large", 1}}}, "quantity_limit")
		f.change(Change{ActorID: a, Reason: "craft", Stacks: []StackDelta{{"fish", "normal", -1}, {"fish", "large", 1}}}, "applied")
		if f.qty(a, "fish", "normal") != MaxCoins-1 || f.qty(a, "fish", "large") != 1 {
			t.Fatal("tier conversion miscounted")
		}
	})
	t.Run("concurrent-consume-and-repeated-reward", func(t *testing.T) {
		a := f.player()
		f.change(Change{ActorID: a, Reason: "reward", Stacks: []StackDelta{{"ore", "normal", 10}}}, "applied")
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				r, err := f.s.ApplyChange(f.ctx, Change{ActorID: a, RequestKey: fmt.Sprintf("consume-%d", i), RuleVersion: "r1", Reason: "consume", Stacks: []StackDelta{{"ore", "normal", -1}}})
				if err != nil || r.Status != "applied" && r.Status != "insufficient_items" {
					t.Errorf("concurrent consume %v %s", err, r.Status)
				}
			}(i)
		}
		wg.Wait()
		if f.qty(a, "ore", "normal") != 0 {
			t.Fatal("concurrent overspend")
		}
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, err := f.s.ApplyChange(f.ctx, Change{ActorID: a, RequestKey: "concurrent-grant", RuleVersion: "r1", Reason: "reward", Stacks: []StackDelta{{"ore", "normal", 3}}})
				if err != nil || r.Status != "applied" {
					t.Errorf("reward %v", err)
				}
			}()
		}
		wg.Wait()
		if f.qty(a, "ore", "normal") != 3 {
			t.Fatal("duplicated reward")
		}
	})
	t.Run("technical-outbox-failure-rolls-back-created-equipment", func(t *testing.T) {
		a := f.player()
		f.change(Change{ActorID: a, Reason: "reward", Coins: 20, Stacks: []StackDelta{{"ore", "normal", 4}}}, "applied")
		_, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;CREATE TRIGGER reject_event BEFORE INSERT ON fishing.outbox_events FOR EACH ROW EXECUTE FUNCTION fishing.reject_event()`)
		if err != nil {
			t.Fatal(err)
		}
		c := Change{ActorID: a, RequestKey: "rollback-equipment", Reason: "craft", RuleVersion: "r1", Coins: -5, Stacks: []StackDelta{{"ore", "normal", -2}}, Create: []EquipmentSpec{{"rod_base", "rod", json.RawMessage(`{}`)}}}
		if _, err := f.s.ApplyChange(f.ctx, c); !errors.Is(err, ErrUnavailable) {
			t.Fatal("technical error not exposed")
		}
		if f.coins(a) != 20 || f.qty(a, "ore", "normal") != 4 || f.number("SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1", a) != 0 {
			t.Fatal("technical failure leaked assets")
		}
		if _, err := f.s.Lookup(f.ctx, a, c.RequestKey); !errors.Is(err, ErrNotFound) {
			t.Fatal("failed command persisted")
		}
		if _, err := f.db.Admin.Exec(f.ctx, "DROP TRIGGER reject_event ON fishing.outbox_events;DROP FUNCTION fishing.reject_event()"); err != nil {
			t.Fatal(err)
		}
		f.change(c, "applied")
	})
	assertInventoryReconciles(t, f.db.Admin)
}

func assertInventoryReconciles(t *testing.T, db *pgxpool.Pool) {
	t.Helper()
	queries := []string{
		`SELECT count(*) FROM fishing.inventory_stacks s WHERE s.quantity<>(SELECT COALESCE(sum(e.delta),0) FROM fishing.inventory_entries e WHERE e.owner_id=s.owner_id AND e.item_id=s.item_id AND e.tier=s.tier)`,
		`SELECT count(*) FROM fishing.wallets w WHERE w.coins<>(SELECT COALESCE(sum(e.delta),0) FROM fishing.asset_entries e WHERE e.account_id=w.account_id)`,
		`SELECT count(*) FROM fishing.command_results WHERE result IS NULL`,
		`SELECT count(*) FROM fishing.asset_operations o LEFT JOIN fishing.outbox_events e ON e.operation_id=o.id WHERE e.id IS NULL`,
		`SELECT count(*) FROM fishing.rod_components c JOIN fishing.equipment_instances e ON c.equipment_id=e.id WHERE c.owner_id<>e.owner_id OR e.lifecycle<>'available' OR c.part<>e.part`,
	}
	for _, q := range queries {
		var n int64
		if err := db.QueryRow(context.Background(), q).Scan(&n); err != nil || n != 0 {
			t.Fatalf("asset reconciliation: %d %v", n, err)
		}
	}
}
