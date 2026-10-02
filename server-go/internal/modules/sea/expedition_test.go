package sea

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationExpeditionLifecycleAndRewards(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err = db.Admin.Exec(ctx, q, owner); err != nil {
			t.Fatal(err)
		}
	}
	svc := New(db.App, c)
	want := func(r assets.Result, err error, status string) {
		t.Helper()
		if err != nil || r.Status != status {
			t.Fatalf("want %s got %s, %v", status, r.Status, err)
		}
	}
	r, err := svc.StartExpedition(ctx, owner, "locked-route", "gather", 8)
	want(r, err, "ship_level_insufficient")
	if _, err = svc.StartExpedition(ctx, owner, "invalid-hours", "trade", 1); err == nil {
		t.Fatal("accepted invalid duration")
	}
	r, err = svc.StartExpedition(ctx, owner, "start-coast", "trade", 8)
	want(r, err, "dispatched")
	id := r.ResourceID
	replay, err := svc.StartExpedition(ctx, owner, "start-coast", "trade", 8)
	want(replay, err, "dispatched")
	if replay.ResourceID != id {
		t.Fatal("retry created another voyage")
	}
	r, err = svc.StartExpedition(ctx, owner, "second-active", "trade", 2)
	want(r, err, "expedition_active")
	view, err := svc.ExpeditionView(ctx, owner)
	if err != nil || view.Active == nil || view.Active.Reward != nil || view.Captain.Voyages != 1 {
		t.Fatalf("active view: %+v %v", view, err)
	}
	var numeric int64
	if _, err = fmt.Sscan(id, &numeric); err != nil {
		t.Fatal(err)
	}
	r, err = svc.ClaimExpedition(ctx, owner, "claim-early", numeric)
	want(r, err, "expedition_not_ready")
	// Change the stored clock only in an isolated test DB; no production fast-forward endpoint exists.
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.sea_expeditions SET started_at=started_at-interval '9 hours',ends_at=ends_at-interval '9 hours' WHERE id=$1`, numeric); err != nil {
		t.Fatal(err)
	}
	// Construct another service instance, proving the pending voyage is not held in process memory.
	svc = New(db.App, c)
	view, err = svc.ExpeditionView(ctx, owner)
	if err != nil || !view.Active.Ready || view.Active.Reward == nil {
		t.Fatal("recovery", err)
	}
	expected := *view.Active.Reward
	if _, err = db.Admin.Exec(ctx, `CREATE FUNCTION fishing.test_expedition_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic reward fault'; END $$; CREATE TRIGGER expedition_fault BEFORE INSERT ON fishing.inventory_entries FOR EACH ROW EXECUTE FUNCTION fishing.test_expedition_fault()`); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ClaimExpedition(ctx, owner, "claim-with-fault", numeric); err == nil {
		t.Fatal("reward fault did not abort")
	}
	var leaked int64
	if err = db.Admin.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatal("failure leaked coins", leaked, err)
	}
	if _, err = db.Admin.Exec(ctx, `DROP TRIGGER expedition_fault ON fishing.inventory_entries`); err != nil {
		t.Fatal(err)
	}
	const n = 8
	results := make([]assets.Result, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = svc.ClaimExpedition(ctx, owner, fmt.Sprintf("claim-%d", i), numeric)
		}(i)
	}
	wg.Wait()
	successes := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.Status == "claimed" {
			successes++
		} else if r.Status != "expedition_claimed" {
			t.Fatal(r.Status)
		}
	}
	if successes != 1 {
		t.Fatal("duplicate reward", successes)
	}
	var coins, xp, marks int64
	var starter int
	if err = db.Admin.QueryRow(ctx, `SELECT w.coins,s.experience,c.marks,c.starter FROM fishing.wallets w JOIN fishing.sea_players s ON s.owner_id=w.account_id JOIN fishing.sea_captains c ON c.owner_id=w.account_id WHERE w.account_id=$1`, owner).Scan(&coins, &xp, &marks, &starter); err != nil {
		t.Fatal(err)
	}
	if coins != expected.Coins || xp != expected.XP || marks != 5 || starter != 1 {
		t.Fatalf("wrong rewards %d %d %d %d", coins, xp, marks, starter)
	}
	var fish int
	if err = db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.inventory_stacks i JOIN fishing.item_definitions d ON d.id=i.item_id WHERE owner_id=$1 AND d.kind='fish'`, owner).Scan(&fish); err != nil || fish != 0 {
		t.Fatal("expedition produced fish", err)
	}
	if len(view.Sets) != 4 {
		t.Fatalf("expected four fishing sets, got %d", len(view.Sets))
	}
	for _, set := range view.Sets {
		if _, ok := c.GearConfig().Sets[set.ID]; !ok {
			t.Fatal("specialization offered as equipment", set.ID)
		}
	}
	for _, starter := range []bool{true, false} {
		part := "rod"
		if starter {
			part = ""
		}
		r, err = svc.RedeemSet(ctx, owner, fmt.Sprintf("reject-specialization-%t", starter), "tide", part, starter)
		want(r, err, "远航专精请在专精菜单独立解锁")
	}
	r, err = svc.RedeemSet(ctx, owner, "starter-choice", "harvest", "", true)
	want(r, err, "redeemed")
	r, err = svc.RedeemSet(ctx, owner, "starter-again", "harvest", "", true)
	want(r, err, "starter_unavailable")
	var pieces int
	if err = db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND definition_id LIKE 'set_harvest_%'`, owner).Scan(&pieces); err != nil || pieces != 2 {
		t.Fatal("starter set", pieces, err)
	}
	// Force a failed risky voyage and confirm partial rewards but no marks.
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.sea_players SET level=5 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'deepscale','material','normal',5) ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=fishing.inventory_stacks.quantity+5`, owner); err != nil {
		t.Fatal(err)
	}
	r, err = svc.StartExpedition(ctx, owner, "danger-start", "danger", 12)
	want(r, err, "dispatched")
	if _, err = fmt.Sscan(r.ResourceID, &numeric); err != nil {
		t.Fatal(err)
	}
	failed := ExpeditionReward{Success: false, Event: "test storm", Coins: 36000, XP: 12, Items: map[string]int64{"boneash": 3, "stardust": 3}}
	raw, _ := json.Marshal(failed)
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.sea_expeditions SET reward=$2,started_at=started_at-interval '13 hours',ends_at=ends_at-interval '13 hours' WHERE id=$1`, numeric, raw); err != nil {
		t.Fatal(err)
	}
	r, err = svc.ClaimExpedition(ctx, owner, "danger-claim", numeric)
	want(r, err, "claimed")
	view, err = svc.ExpeditionView(ctx, owner)
	if err != nil || view.Captain.Marks != 5 || view.Captain.Successes != 1 {
		t.Fatal("failure granted marks", err)
	}
	// Even a pre-existing autosell rule cannot sell new exclusive catalysts.
	var sellable int64
	if err = db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='stardust'`, owner).Scan(&sellable); err != nil || sellable != 3 {
		t.Fatal("failed partial payout", err)
	}
	_, err = economy.New(db.App, c).Sell(ctx, economy.Sell{ActorID: owner, RequestKey: "sell-catalyst", ItemID: "stardust", Quantity: 1})
	if err == nil {
		t.Fatal("system sold exclusive catalyst")
	}
	// A legacy autosell configuration must not bypass the new exclusive-resource rule.
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,rules) VALUES($1,'{"stardust":{"on":true}}') ON CONFLICT(owner_id) DO UPDATE SET rules=excluded.rules`, owner); err != nil {
		t.Fatal(err)
	}
	_, _ = economy.New(db.App, c).AutoSell(ctx, owner, "legacy-autosell")
	if err = db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='stardust'`, owner).Scan(&sellable); err != nil || sellable != 3 {
		t.Fatal("legacy autosell sold a catalyst", err)
	}
}

func TestExpeditionRuleBoundsAndSetEffects(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	cfg := c.ExpeditionConfig()
	if len(cfg.Routes) != 5 || len(cfg.Catalysts) != 9 || len(c.GearSets()) != 9 {
		t.Fatal("incomplete design configuration")
	}
	for _, route := range cfg.Routes {
		for _, h := range []int{2, 8, 12} {
			snap := ExpeditionSnapshot{Level: route.Level, Success: route.Success, Effects: rules.EmptyEffects()}
			success := expeditionReward(cfg, route, h, snap, func() float64 { return 0 })
			if !success.Success || success.Marks <= 0 || success.XP <= 0 {
				t.Fatal("invalid success")
			}
			for id, n := range success.Items {
				it, ok := c.Item(id)
				if !ok || it.Kind == "fish" || n <= 0 {
					t.Fatal("invalid reward", id)
				}
			}
			if route.Success < 100 {
				failure := expeditionReward(cfg, route, h, snap, func() float64 { return .99 })
				if failure.Success || failure.Marks != 0 || failure.Coins <= 0 || failure.Coins >= success.Coins {
					t.Fatal("invalid failure")
				}
			}
		}
	}
	route := cfg.Routes[2]
	snap := ExpeditionSnapshot{Set: "rescue", Success: 0, Effects: rules.EmptyEffects()}
	r := expeditionReward(cfg, route, 8, snap, func() float64 { return .99 })
	if r.Marks != 0 || r.Coins != 28800 {
		t.Fatal("rescue payout", r)
	}
	snap.Set = "forge"
	r = expeditionReward(cfg, route, 8, snap, func() float64 { return .99 })
	if r.Heat <= 0 {
		t.Fatal("forge did not accrue heat")
	}
}

func TestIntegrationGearProgressAndSetAssembly(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err = db.Admin.Exec(ctx, q, owner); err != nil {
			t.Fatal(err)
		}
	}
	c.Constants["GEAR_SYSTEM"] = json.RawMessage(`{"enabled":false}`) // Historical progress contract.
	svc := New(db.App, c)
	a := assets.New(db.App)
	seq := 0
	key := func() string { seq++; return fmt.Sprintf("gear-progress-%d", seq) }
	equip := func(part, signature, want string) {
		t.Helper()
		id := int64(0)
		if signature != "" {
			base, _, _, ok := c.Instance(signature)
			if !ok {
				t.Fatal("invalid gear", signature)
			}
			raw, _ := json.Marshal(map[string]string{"signature": signature})
			r, err := a.ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: key(), Reason: "reward", RuleVersion: "test", Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: raw}}})
			if err != nil || len(r.EquipmentIDs) != 1 {
				t.Fatal("create", r, err)
			}
			fmt.Sscan(r.EquipmentIDs[0], &id)
		}
		r, err := a.ChangeRod(ctx, assets.RodCommand{ActorID: owner, RequestKey: key(), Action: "equip", Part: part, EquipmentID: id})
		if err != nil || r.Status != want {
			t.Fatal("equip", part, r, err)
		}
	}
	progress := func(catches []rules.Catch, writeCodex bool) {
		t.Helper()
		cmd := assets.Command{ActorID: owner, RequestKey: key(), Kind: "fishing_settle", RuleVersion: "test", Players: []int64{owner}, Input: catches}
		for range 2 {
			r, err := a.Run(ctx, cmd, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
				if err := svc.GearCatchProgress(ctx, tx, owner, catches); err != nil {
					return assets.Result{}, err
				}
				if writeCodex {
					for _, v := range catches {
						if v.Kind == "fish" {
							if _, err := tx.SQL().Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count) VALUES($1,$2,1) ON CONFLICT(owner_id,item_id) DO UPDATE SET count=fishing.player_codex.count+1`, owner, v.ID); err != nil {
								return assets.Result{}, err
							}
						}
					}
				}
				return assets.Result{Status: "settled"}, nil
			})
			if err != nil || r.Status != "settled" {
				t.Fatal("progress", r, err)
			}
		}
	}
	check := func(field string, want int) {
		t.Helper()
		var got int
		if err := db.Admin.QueryRow(ctx, "SELECT "+field+" FROM fishing.sea_captains WHERE owner_id=$1", owner).Scan(&got); err != nil || got != want {
			t.Fatal(field, got, want, err)
		}
	}
	equip("rod", "set_apex_rod#epic#skl+8", "rod_updated")
	equip("charm", "set_tide_charm#epic#res+6", "set_mismatch")
	equip("charm", "set_apex_charm#epic#size+6", "rod_updated")
	r, err := svc.SelectTarget(ctx, owner, key(), "carp")
	if err != nil || r.Status != "target_selected" {
		t.Fatal(r, err)
	}
	for range 4 {
		progress([]rules.Catch{{ID: "crucian", Kind: "fish"}}, false)
	}
	check("tracking", 3)
	_, err = a.Run(ctx, assets.Command{ActorID: owner, RequestKey: key(), Kind: "fishing_settle", RuleVersion: "test", Players: []int64{owner}}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		pool := []rules.LootEntry{{Pick: "fish:carp", Weight: 10}, {Pick: "fish:crucian", Weight: 10}}
		if err := svc.TrackingPool(ctx, tx, owner, pool); err != nil {
			return assets.Result{}, err
		}
		if pool[0].Weight != 17.5 || pool[1].Weight != 10 {
			t.Fatal("wrong target bonus", pool)
		}
		return assets.Result{Status: "checked"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	progress([]rules.Catch{{ID: "carp", Kind: "fish"}, {ID: "crucian", Kind: "fish"}}, false)
	check("tracking", 0)
	progress([]rules.Catch{{ID: "crucian", Kind: "fish"}}, false)
	r, err = svc.SelectTarget(ctx, owner, key(), "crucian")
	if err != nil || r.Status != "target_selected" {
		t.Fatal(r, err)
	}
	check("tracking", 0)
	equip("charm", "", "rod_updated")
	equip("rod", "set_research_rod#epic#skl+8", "rod_updated")
	equip("charm", "set_research_charm#epic#res+6", "rod_updated")
	progress([]rules.Catch{{ID: "crucian", Kind: "fish"}, {ID: "crucian", Kind: "fish"}}, true)
	check("samples", 1)
	progress([]rules.Catch{{ID: "crucian", Kind: "fish"}}, true)
	check("samples", 1)
	progress([]rules.Catch{{ID: "carp", Kind: "fish"}}, true)
	check("samples", 2)
	equip("charm", "", "rod_updated")
	equip("rod", "set_forge_rod#epic#mat+8", "rod_updated")
	equip("charm", "set_forge_charm#epic#res+6", "rod_updated")
	progress([]rules.Catch{{ID: "bait_pack", Kind: "material"}, {ID: "carp", Kind: "fish"}}, false)
	check("heat", 1)
	equip("bait", "gear_bait_3#epic#res+5", "rod_updated")
	equip("accessory", "gear_accessory_2#epic#res+5", "rod_updated")
	equip("line", "line_nylon#epic#res+5", "resonance_limit")
	// Earned archaeology clues turn into one chest and retain the remainder.
	equip("charm", "", "rod_updated")
	equip("rod", "set_wreck_rod#epic#mat+8", "rod_updated")
	equip("charm", "set_wreck_charm#epic#res+6", "rod_updated")
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.sea_players(owner_id,level) VALUES($1,3) ON CONFLICT(owner_id) DO UPDATE SET level=3`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err = a.ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: key(), Reason: "reward", RuleVersion: "test", Stacks: []assets.StackDelta{{ItemID: "deepscale", Tier: "normal", Quantity: 1}}}); err != nil {
		t.Fatal(err)
	}
	r, err = svc.StartExpedition(ctx, owner, key(), "salvage", 12)
	if err != nil || r.Status != "dispatched" {
		t.Fatal(r, err)
	}
	var voyage int64
	fmt.Sscan(r.ResourceID, &voyage)
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.sea_captains SET clues=5 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.sea_expeditions SET started_at=started_at-interval '13 hours',ends_at=ends_at-interval '13 hours',reward=jsonb_set(reward,'{clues}','3') WHERE id=$1`, voyage); err != nil {
		t.Fatal(err)
	}
	r, err = svc.ClaimExpedition(ctx, owner, key(), voyage)
	if err != nil || r.Status != "claimed" {
		t.Fatal(r, err)
	}
	check("clues", 2)
	var chests int
	if err = db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='chest_deep'`, owner).Scan(&chests); err != nil || chests != 1 {
		t.Fatal("archaeology chest", chests, err)
	}
}
