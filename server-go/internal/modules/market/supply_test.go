package market

import (
	"encoding/json"
	"reflect"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

func TestSupplyCountsRepeatsRestockMixAndPreservesGradualQuota(t *testing.T) {
	recipe := storedSupplyRecipe{Counts: map[string]int{"fish": 1, "material": 1}}
	if got := supplyCounts(storedSupplyRule{Mode: "restock"}, recipe, 10); !reflect.DeepEqual(got, map[string]int{"fish": 5, "material": 5}) {
		t.Fatalf("restock recipe was treated as finite stock: %v", got)
	}
	if got := supplyCounts(storedSupplyRule{Mode: "restock", Created: 1}, recipe, 1); !reflect.DeepEqual(got, map[string]int{"material": 1}) {
		t.Fatalf("single-item batches starved later categories: %v", got)
	}
	large := storedSupplyRecipe{Counts: map[string]int{"fish": 100, "material": 100}}
	if got := supplyCounts(storedSupplyRule{Mode: "restock"}, large, 20); !reflect.DeepEqual(got, map[string]int{"fish": 10, "material": 10}) {
		t.Fatalf("small batch did not preserve recipe ratio: %v", got)
	}
	if got := supplyCounts(storedSupplyRule{Mode: "gradual", RemainingCounts: map[string]int{"material": 1}}, recipe, 10); !reflect.DeepEqual(got, map[string]int{"material": 1}) {
		t.Fatalf("gradual quota was replenished: %v", got)
	}
}

func TestIntegrationRestockBatchRollbackAndRetry(t *testing.T) {
	f := orderSetup(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,'supply_fixture','Supply','123456','unused-test-only')`, f.a); err != nil {
		t.Fatal(err)
	}
	rule := storedSupplyRule{ID: "restock-fixture", Enabled: true, Mode: "restock", Batch: 10, IntervalSeconds: 60, Threshold: 1, Target: 20, Recipe: map[string]any{"seller": "supply_fixture", "counts": map[string]int{"fish": 1, "material": 1}}}
	raw, _ := json.Marshal(rule)
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('market_supply',$1)`, raw); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.fail_supply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic supply failure'; END $$; CREATE TRIGGER fail_supply BEFORE INSERT ON fishing.market_orders FOR EACH ROW EXECUTE FUNCTION fishing.fail_supply()`); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SupplyTick(f.ctx, c); err == nil {
		t.Fatal("injected failure did not abort supply")
	}
	if got := f.num(`SELECT count(*) FROM fishing.market_orders`); got != 0 {
		t.Fatal("failed batch left orders", got)
	}
	current, err := f.s.readSupplyRule(f.ctx)
	if err != nil || current.Created != 0 || !current.Enabled || current.NextAt != 0 {
		t.Fatal("failed batch advanced cursor", current, err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DROP TRIGGER fail_supply ON fishing.market_orders`); err != nil {
		t.Fatal(err)
	}
	for batch := 1; batch <= 2; batch++ {
		if err := f.s.SupplyTick(f.ctx, c); err != nil {
			t.Fatal(err)
		}
		current, err = f.s.readSupplyRule(f.ctx)
		if err != nil || current.Created != batch*10 || !current.Enabled || current.Error != "" {
			t.Fatal("restock batch did not advance", current, err)
		}
		if got := f.num(`SELECT count(*) FROM fishing.market_orders WHERE supply_id=$1`, rule.ID); got != int64(batch*10) {
			t.Fatal("restock batch size", got)
		}
		if got := f.num(`SELECT count(*) FROM fishing.market_orders m JOIN fishing.item_definitions i ON i.id=m.item_id WHERE supply_id=$1 AND i.kind='fish'`, rule.ID); got != int64(batch*5) {
			t.Fatal("restock category quota", got)
		}
		if err := f.s.SupplyTick(f.ctx, c); err != nil {
			t.Fatal("tick before due", err)
		}
		if got := f.num(`SELECT count(*) FROM fishing.market_orders WHERE supply_id=$1`, rule.ID); got != int64(batch*10) {
			t.Fatal("tick duplicated batch", got)
		}
		if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.operator_settings SET value=jsonb_set(value,'{nextAt}','0') WHERE key='market_supply'`); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.s.SupplyTick(f.ctx, c); err != nil {
		t.Fatal(err)
	}
	current, err = f.s.readSupplyRule(f.ctx)
	if err != nil || current.Created != 20 || current.Refilling || current.Error != "" {
		t.Fatal("restock did not stop at target", current, err)
	}
	// Model a worker that read the old rule just before the operator paused or
	// replaced it. Its idle, failure and order commits must all lose the CAS.
	stale := current
	plan, err := BuildBulkPlan(c, BulkOptions{Counts: map[string]int{"fish": 1}}, BulkSeed("stale-supply"))
	if err != nil {
		t.Fatal(err)
	}
	for _, replace := range []bool{false, true} {
		paused := current
		paused.Enabled = false
		if replace {
			paused.ID = "replacement-fixture"
		}
		raw, _ = json.Marshal(paused)
		if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.operator_settings SET value=$1 WHERE key='market_supply'`, raw); err != nil {
			t.Fatal(err)
		}
		if err := f.s.saveSupplyRule(f.ctx, stale); err != nil {
			t.Fatal(err)
		}
		if err := f.s.saveSupplyError(f.ctx, stale, "stale failure"); err != nil {
			t.Fatal(err)
		}
		res, err := f.s.AdminBulk(f.ctx, AdminBulkRequest{ActorID: f.a, RequestKey: f.key(), Sellers: []Seller{{ID: f.a, Key: "supply_fixture", Name: "Supply"}}, Plan: plan, SupplyID: stale.ID, BeforeRule: stale.original, AfterRule: stale.original})
		if err != nil || res.Status != "supply_rule_changed" {
			t.Fatal("stale order batch accepted", res, err)
		}
		got, err := f.s.readSupplyRule(f.ctx)
		if err != nil || got.ID != paused.ID || got.Enabled || got.Error != "" || got.Created != 20 || f.num(`SELECT count(*) FROM fishing.market_orders`) != 20 {
			t.Fatal("stale worker changed paused or replaced rule", got, err)
		}
	}
}
