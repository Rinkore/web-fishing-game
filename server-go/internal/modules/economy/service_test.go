package economy

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fmt"
	"strconv"
	"sync"
	"testing"
)

func TestIntegrationSharedSupplyAutosellAndRollback(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	s := New(db.App, c)
	a := assets.New(db.App)
	owners := make([]int64, 4)
	for i := range owners {
		if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owners[i]); err != nil {
			t.Fatal(err)
		}
		for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
			if _, err := db.Admin.Exec(ctx, sql, owners[i]); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := a.ApplyChange(ctx, assets.Change{ActorID: owners[i], RequestKey: "stock", Reason: "reward", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "normal", Quantity: 100}, {ItemID: "crucian", Tier: "large", Quantity: 30}, {ItemID: "crucian", Tier: "giant", Quantity: 20}, {ItemID: "bait_pack", Tier: "normal", Quantity: 80}}}); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	results := make([]assets.Result, 4)
	errs := make([]error, 4)
	for i := range owners {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Sell(ctx, Sell{owners[i], "sale", "crucian", "normal", 10})
		}(i)
	}
	wg.Wait()
	for i, r := range results {
		if errs[i] != nil || r.Status != "sold" {
			t.Fatal("concurrent sell", r, errs[i])
		}
		again, err := s.Sell(ctx, Sell{owners[i], "sale", "crucian", "normal", 10})
		if err != nil || again.OperationID != r.OperationID {
			t.Fatal("sale replay", err)
		}
	}
	var st rules.SaleState
	var raw []byte
	if err := db.Admin.QueryRow(ctx, `SELECT state FROM fishing.economy_prices WHERE item_id='crucian'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &st); err != nil || st.SoldTotal != 40 {
		t.Fatal("shared supply", err, st.SoldTotal)
	}
	// Default batch applies to the combined eligible pool; ordinary stock is sold first.
	cfg := Settings{IncludeTiers: true, Rules: map[string]rules.AutoSellRule{"crucian": {On: true, Keep: 20}, "bait_pack": {On: true, Keep: 50}}}
	r, err := s.Configure(ctx, owners[0], "configure", cfg)
	if err != nil || r.Status != "configured" {
		t.Fatal("configure", err)
	}
	r, err = s.AutoSell(ctx, owners[0], "auto")
	if err != nil || r.Status != "sold" {
		t.Fatal("autosell", err, r.Status)
	}
	var details struct {
		Gain  int64            `json:"gain"`
		Parts []rules.SalePart `json:"parts"`
	}
	if err := json.Unmarshal(r.Details, &details); err != nil {
		t.Fatal(err)
	}
	if len(details.Parts) != 3 {
		t.Fatal("normal first keep", details.Parts)
	}
	for _, p := range details.Parts {
		if p.ID == "crucian" && p.Tier == "giant" {
			t.Fatal("giant keep consumed")
		}
	}
	// Inject an error after asset mutation; neither price pressure nor sales rows may persist.
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_sale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_sale BEFORE INSERT ON fishing.shop_sales FOR EACH ROW EXECUTE FUNCTION fishing.fail_sale()`); err != nil {
		t.Fatal(err)
	}
	cmd := Sell{owners[1], "fault", "crucian", "giant", 2}
	if _, err := s.Sell(ctx, cmd); err == nil {
		t.Fatal("expected fault")
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_sale ON fishing.shop_sales`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Sell(ctx, cmd)
	if err != nil || r.Status != "sold" {
		t.Fatal("fault retry", err)
	}
	if err := json.Unmarshal(r.Details, &details); err != nil || len(details.Parts) != 1 {
		t.Fatal("sale result", err)
	}
	part := details.Parts[0]
	if part.Gain != part.Unit*5 || part.Bonus != part.Unit*3 {
		t.Fatal("giant bonus", part)
	}
	for _, owner := range owners {
		var diff int64
		if err := db.Admin.QueryRow(ctx, `SELECT w.coins-COALESCE((SELECT sum(gain) FROM fishing.shop_sales WHERE owner_id=w.account_id),0) FROM fishing.wallets w WHERE account_id=$1`, owner).Scan(&diff); err != nil || diff != 0 {
			t.Fatal("sales coins reconcile", owner, diff, err)
		}
	}
	for i, request := range []Sell{{owners[0], "", "crucian", "normal", 10000}, {owners[0], "", "crucian", "giant", 10000}} {
		request.RequestKey = fmt.Sprintf("insufficient-%d", i)
		r, err := s.Sell(ctx, request)
		if err != nil || r.Status == "sold" {
			t.Fatal("oversell", err, r.Status)
		}
	}
	// Duplicate workers settle online players once; offline holdings are untouched.
	for i, owner := range owners {
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,$2,'synthetic','123456','unused-test-only')`, owner, fmt.Sprintf("test_%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	for _, owner := range owners[2:] {
		if _, err := s.Configure(ctx, owner, "worker-config", Settings{Rules: map[string]rules.AutoSellRule{"crucian": {On: true}}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.fishing_connections(owner_id,generation,expires_at) VALUES($1,1,clock_timestamp()+interval '1 hour')`, owners[2]); err != nil {
		t.Fatal(err)
	}
	// Each has 90 normal fish left: use a second item to cross the combined batch.
	for _, owner := range owners[2:] {
		if _, err := s.Configure(ctx, owner, "worker-config-2", Settings{Rules: map[string]rules.AutoSellRule{"crucian": {On: true}, "bait_pack": {On: true}}}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); _, errs[i] = s.Sweep(ctx, 0) }(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatal("worker sweep", errs)
	}
	var count int
	if err := db.Admin.QueryRow(ctx, `SELECT count(DISTINCT operation_id) FROM fishing.shop_sales WHERE automatic AND owner_id=$1`, owners[2]).Scan(&count); err != nil || count != 1 {
		t.Fatal("worker duplicate", count, err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.shop_sales WHERE automatic AND owner_id=$1`, owners[3]).Scan(&count); err != nil || count != 0 {
		t.Fatal("offline sale", count, err)
	}
	if _, err := s.AutoSell(ctx, owners[2], "autosell:run:blocked"); err != assets.ErrInvalid {
		t.Fatal("reserved worker key accepted")
	}
	// A concrete equipment instance is consumed once and does not alter fish supply.
	gear, err := a.ApplyChange(ctx, assets.Change{ActorID: owners[3], RequestKey: "gear", Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: "rod_bamboo", Part: "rod", Attributes: json.RawMessage(`{"signature":"rod_bamboo#rare#spd+5"}`)}}})
	if err != nil || len(gear.EquipmentIDs) != 1 {
		t.Fatal("gear", err)
	}
	id, _ := strconv.ParseInt(gear.EquipmentIDs[0], 10, 64)
	r, err = s.SellEquipment(ctx, owners[3], id, "gear-sale")
	if err != nil || r.Status != "sold" {
		t.Fatal("gear sale", err, r.Status)
	}
	r, err = s.SellEquipment(ctx, owners[3], id, "gear-again")
	if err != nil || r.Status == "sold" {
		t.Fatal("double gear sale", err, r.Status)
	}
}
