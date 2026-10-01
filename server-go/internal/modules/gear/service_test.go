package gear

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fmt"
	"sync"
	"testing"
)

type fixture struct {
	t     *testing.T
	ctx   context.Context
	db    testdb.DB
	c     *rules.Catalog
	s     *Service
	a     *assets.Service
	owner int64
	seq   int
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, ctx: context.Background(), db: db, c: c, s: New(db.App, c), a: assets.New(db.App)}
	if err = workshop.SeedDefinitions(f.ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	if err = db.Admin.QueryRow(f.ctx, "INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id").Scan(&f.owner); err != nil {
		t.Fatal(err)
	}
	f.exec("INSERT INTO fishing.player_state(account_id) VALUES($1)", f.owner)
	f.exec("INSERT INTO fishing.wallets(account_id) VALUES($1)", f.owner)
	r, err := f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: "gear-fixture-resources", Reason: "reward", RuleVersion: "test", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "gear_alloy", Tier: "normal", Quantity: 1000}, {ItemID: "gear_fine", Tier: "normal", Quantity: 100}, {ItemID: "gear_crystal", Tier: "normal", Quantity: 1000}}})
	if err != nil || r.Status != "applied" {
		t.Fatal(r, err)
	}
	f.exec("INSERT INTO fishing.gear_progress(owner_id,state) VALUES($1,$2)", f.owner, `{"receipts":100,"heat":40,"tiers":{"forge":3},"unlocked":{}}`)
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
func (f *fixture) key() string { f.seq++; return fmt.Sprintf("gear-test-%d", f.seq) }
func (f *fixture) add(sig string) string {
	f.t.Helper()
	b, _, _, ok := f.c.Instance(sig)
	if !ok {
		f.t.Fatal("invalid signature", sig)
	}
	raw, _ := json.Marshal(map[string]any{"signature": sig})
	r, err := f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.key(), Reason: "reward", RuleVersion: "test", Create: []assets.EquipmentSpec{{DefinitionID: b.ID, Part: b.Part, Attributes: raw}}})
	if err != nil || len(r.EquipmentIDs) != 1 {
		f.t.Fatal(r, err)
	}
	return r.EquipmentIDs[0]
}
func (f *fixture) modern(level int, sub string) string {
	sig, err := f.c.GearSignature("gear_reel_1", level, sub, "none", 0)
	if err != nil {
		f.t.Fatal(err)
	}
	return f.add(sig)
}
func (f *fixture) apply(in Command) assets.Result {
	f.t.Helper()
	if in.RequestKey == "" {
		in.RequestKey = f.key()
	}
	r, err := f.s.Apply(f.ctx, f.owner, in)
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}
func resultID(t *testing.T, r assets.Result) string {
	t.Helper()
	if r.Status != "crafted" {
		t.Fatalf("not crafted: %+v", r)
	}
	var d struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(r.Details, &d); err != nil {
		t.Fatal(err)
	}
	return d.ID
}
func TestIntegrationGrowthAtomicConcurrentAndBinding(t *testing.T) {
	f := setup(t)
	id := f.modern(3, "")
	in := Command{Action: "upgrade", ID: id, Sub: "skill", RequestKey: f.key()}
	const n = 6
	rr := make([]assets.Result, n)
	ee := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) { defer wg.Done(); rr[i], ee[i] = f.s.Apply(f.ctx, f.owner, in) }(i)
	}
	wg.Wait()
	next := ""
	for i, r := range rr {
		if ee[i] != nil {
			t.Fatal(ee[i])
		}
		got := resultID(t, r)
		if next != "" && got != next {
			t.Fatal("idempotency failed")
		}
		next = got
	}
	if f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 996000 {
		t.Fatal("duplicate fee")
	}
	if f.num("SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='gear_alloy'", f.owner) != 992 {
		t.Fatal("material fee")
	}
	if f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 99 {
		t.Fatal("receipt fee")
	}
	if f.num("SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND attributes->>'bound'='true'", next) != 1 {
		t.Fatal("upgrade not bound")
	}
	if r := f.apply(Command{Action: "upgrade", ID: id, Sub: "skill"}); r.Status == "crafted" {
		t.Fatal("consumed equipment reused")
	}
	next = resultID(t, f.apply(Command{Action: "upgrade", ID: next, Sub: "double"}))
	view, err := f.s.View(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range view["equipment"].([]Equipment) {
		if e.ID == next {
			found = true
			if e.Affixes[1].Type != "skill" {
				t.Fatal("free retune")
			}
		}
	}
	if !found {
		t.Fatal("new item missing")
	}
	target := f.modern(0, "")
	next = resultID(t, f.apply(Command{Action: "transfer", ID: next, OtherID: target}))
	if f.num("SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND attributes->>'bound'='true'", next) != 1 {
		t.Fatal("transfer lost binding")
	}
	var other int64
	if err = f.db.Admin.QueryRow(f.ctx, "INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id").Scan(&other); err != nil {
		t.Fatal(err)
	}
	f.exec("INSERT INTO fishing.player_state(account_id) VALUES($1)", other)
	if _, err = f.db.Admin.Exec(f.ctx, "UPDATE fishing.equipment_instances SET owner_id=$1 WHERE id=$2", other, next); err == nil {
		t.Fatal("database allowed bound transfer")
	}
}
func TestIntegrationFailedGrowthRollsBack(t *testing.T) {
	f := setup(t)
	id := f.modern(7, "double")
	f.exec("CREATE FUNCTION fishing.gear_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER gear_fault BEFORE INSERT ON fishing.equipment_instances FOR EACH ROW EXECUTE FUNCTION fishing.gear_test_fault()")
	in := Command{Action: "upgrade", ID: id, RequestKey: f.key()}
	if _, err := f.s.Apply(f.ctx, f.owner, in); err == nil {
		t.Fatal("fault did not abort")
	}
	if f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 1000000 || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 100 || f.num("SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'", id) != 1 {
		t.Fatal("failure leaked assets")
	}
	f.exec("DROP TRIGGER gear_fault ON fishing.equipment_instances")
	resultID(t, f.apply(in))
	id = f.modern(8, "skill")
	f.exec("UPDATE fishing.gear_progress SET state=jsonb_set(state,'{receipts}','0') WHERE owner_id=$1", f.owner)
	coins := f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner)
	r := f.apply(Command{Action: "engrave", ID: id, Direction: "main", UseHeat: true})
	if r.Status == "crafted" || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != coins {
		t.Fatal("insufficient receipt charged assets")
	}
}
func TestIntegrationStagesAndEngraving(t *testing.T) {
	f := setup(t)
	// Exercise core retention even when the default stage costs no longer consume cores.
	cfg := f.c.GearConfig()
	cfg.Costs.Stage[0].Cores = 1
	f.c.Constants["GEAR_SYSTEM"], _ = json.Marshal(cfg)
	for _, part := range []string{"rod", "charm"} {
		sig, _ := f.c.GearCoreSignature("research", part)
		f.add(sig)
	}
	if r := f.apply(Command{Action: "stage", Set: "research"}); r.Status == "crafted" {
		t.Fatal("consumed unique core")
	}
	sig, _ := f.c.GearCoreSignature("research", "rod")
	f.add(sig)
	r := f.apply(Command{Action: "stage", Set: "research"})
	if r.Status != "crafted" {
		t.Fatal(r)
	}
	if f.num("SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND definition_id IN ('set_research_rod','set_research_charm') AND lifecycle='available'", f.owner) != 2 {
		t.Fatal("core retention")
	}
	id := f.modern(8, "double")
	id = resultID(t, f.apply(Command{Action: "engrave", ID: id, Direction: "main", UseHeat: true}))
	if f.num("SELECT (state->>'heat')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 32 {
		t.Fatal("heat discount")
	}
	if r = f.apply(Command{Action: "engrave", ID: id, Direction: "main"}); r.Status == "crafted" {
		t.Fatal("duplicate engraving")
	}
	id = resultID(t, f.apply(Command{Action: "engrave", ID: id, Direction: "sub"}))
	id = resultID(t, f.apply(Command{Action: "preset", ID: id, Direction: "main"}))
	var raw string
	if err := f.db.Admin.QueryRow(f.ctx, "SELECT attributes->>'signature' FROM fishing.equipment_instances WHERE id=$1", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	g, ok := rules.Growth(raw)
	if !ok || g.Engrave != "main" || g.Presets != 3 {
		t.Fatal("preset state", raw)
	}
}

func TestIntegrationSpecializationPreferenceModes(t *testing.T) {
	f := setup(t)
	f.exec("UPDATE fishing.gear_progress SET state=$2 WHERE owner_id=$1", f.owner, `{"receipts":100,"tiers":{"tide":2,"storm":1,"rescue":2},"unlocked":{"tide":true,"storm":true,"rescue":true,"wreck":true},"selected":"wreck","voyageMode":"normal"}`)
	for _, in := range []Command{
		{Set: "tide", Mode: "concentrate"},
		{Set: "storm", Mode: "deep"},
		{Set: "rescue", Mode: "evacuate"},
		{Set: "wreck", Mode: "deep"},
		{Mode: "concentrate"},
	} {
		in.Action = "preferences"
		if r := f.apply(in); r.Status != "specialization_mode_locked" {
			t.Fatal("saved unavailable mode", in, r)
		}
		v, err := Read(f.ctx, f.db.Admin, f.owner)
		if err != nil || v.Selected != "wreck" || v.VoyageMode != "normal" {
			t.Fatal("rejected mode changed preferences", v, err)
		}
	}
	f.exec("UPDATE fishing.gear_progress SET state=jsonb_set(state,'{tiers}','{\"tide\":3,\"storm\":2,\"rescue\":3}') WHERE owner_id=$1", f.owner)
	for _, in := range []Command{
		{Set: "tide", Mode: "concentrate", Focus: "gear_crystal"},
		{Set: "storm", Mode: "deep"},
		{Set: "rescue", Mode: "evacuate"},
		{Set: "wreck", Mode: "normal"},
		{Mode: "normal"},
		{},
	} {
		in.Action = "preferences"
		if r := f.apply(in); r.Status != "crafted" {
			t.Fatal("valid mode rejected", in, r)
		}
		v, err := Read(f.ctx, f.db.Admin, f.owner)
		if err != nil || v.Selected != in.Set || v.VoyageMode != in.Mode || v.Focus != in.Focus {
			t.Fatal("preferences not saved", v, err)
		}
	}
}

func TestIntegrationIndependentSpecializationProgress(t *testing.T) {
	f := setup(t)
	if r := f.apply(Command{Action: "stage", Set: "tide"}); r.Status != "请先认证专精" {
		t.Fatal("locked specialization advanced", r)
	}
	// Competing unlocks must charge once, without requiring any equipment.
	rr := make([]assets.Result, 2)
	ee := make([]error, 2)
	var wg sync.WaitGroup
	for i := range rr {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rr[i], ee[i] = f.s.Apply(f.ctx, f.owner, Command{Action: "unlock", Set: "tide", RequestKey: fmt.Sprintf("specialization-unlock-%d", i)})
		}(i)
	}
	wg.Wait()
	wins := 0
	for i, r := range rr {
		if ee[i] != nil {
			t.Fatal(ee[i])
		}
		if r.Status == "crafted" {
			wins++
		} else if r.Status != "专精已认证或不存在" {
			t.Fatal(r)
		}
	}
	if wins != 1 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 995000 {
		t.Fatal("specialization unlock charged more than once")
	}
	// Material failure must roll back payment and progress together.
	f.exec("UPDATE fishing.inventory_stacks SET quantity=0 WHERE owner_id=$1 AND item_id='gear_crystal'", f.owner)
	if r := f.apply(Command{Action: "stage", Set: "tide"}); r.Status == "crafted" {
		t.Fatal("advanced without materials")
	}
	v, err := Read(f.ctx, f.db.Admin, f.owner)
	if err != nil || v.Tiers["tide"] != 0 || v.Receipts != 100 || !v.Unlocked["tide"] || v.Tiers["forge"] != 3 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 995000 {
		t.Fatal("failed advancement changed assets or progress", v, err)
	}
	f.exec("UPDATE fishing.inventory_stacks SET quantity=998 WHERE owner_id=$1 AND item_id='gear_crystal'", f.owner)
	legacyID := ""
	for stage := 1; stage <= 3; stage++ {
		if r := f.apply(Command{Action: "stage", Set: "tide"}); r.Status != "crafted" {
			t.Fatal("specialization requires equipment", stage, r)
		}
		if stage == 1 {
			// Later upgrades must also preserve previously issued specialization equipment.
			legacyID = f.add("set_tide_rod#epic#mat+8")
		}
	}
	if r := f.apply(Command{Action: "stage", Set: "tide"}); r.Status != "已达三阶" {
		t.Fatal("advanced beyond maximum", r)
	}
	v, err = Read(f.ctx, f.db.Admin, f.owner)
	if err != nil || v.Tiers["tide"] != 3 || v.Receipts != 97 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 875000 || f.num("SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='gear_crystal'", f.owner) != 908 {
		t.Fatal("wrong specialization costs", v, err)
	}
	if r := f.apply(Command{Action: "preferences", Set: "tide"}); r.Status != "crafted" || f.num("SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'", legacyID) != 1 {
		t.Fatal("legacy asset removed", r)
	}
}
func TestIntegrationHarvestSingleCastAndTargetQueue(t *testing.T) {
	f := setup(t)
	cfg := f.c.GearConfig()
	one := rules.Catch{ID: "crucian", Kind: "fish", CodexID: "crucian", Tier: "normal"}
	r, err := f.a.Run(f.ctx, assets.Command{ActorID: f.owner, RequestKey: f.key(), Kind: "workshop_forge", RuleVersion: "test", Players: []int64{f.owner}}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		fish := Fishing{State: State{Tiers: map[string]int{}, Unlocked: map[string]bool{}, Harvest: 19}, Active: "harvest", Config: cfg, Effect: cfg.Sets["harvest"].Effect(0)}
		bonuses, e := fish.Finish(ctx, tx, f.c, f.owner, []rules.Catch{one, one}, false)
		if e != nil {
			return assets.Result{}, e
		}
		if len(bonuses) != 1 || bonuses[0].Size != nil || bonuses[0].CodexID != "" {
			t.Fatal("harvest side effects", bonuses)
		}
		more, e := fish.Finish(ctx, tx, f.c, f.owner, []rules.Catch{one}, true)
		if e != nil {
			return assets.Result{}, e
		}
		if len(more) != 0 || fish.State.Harvest != 0 {
			t.Fatal("double cast progress")
		}
		fish = Fishing{State: State{Target: "crucian", TargetQueue: []string{"carp"}, TargetGoal: 1, Tiers: map[string]int{}, Unlocked: map[string]bool{}}, Active: "apex", Allowed: true, Effect: cfg.Sets["apex"].Effect(3)}
		_, e = fish.Finish(ctx, tx, f.c, f.owner, []rules.Catch{one}, true)
		if fish.State.Target != "carp" || fish.State.TargetQueue[0] != "crucian" {
			t.Fatal("queue did not rotate")
		}
		return assets.Result{Status: "tested"}, e
	})
	if err != nil || r.Status != "tested" {
		t.Fatal(r, err)
	}
}
func TestIntegrationCompetingUpgradesOnlySpendOnce(t *testing.T) {
	f := setup(t)
	id := f.modern(0, "")
	rr := make([]assets.Result, 2)
	ee := make([]error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rr[i], ee[i] = f.s.Apply(f.ctx, f.owner, Command{Action: "upgrade", ID: id, RequestKey: fmt.Sprintf("competing-key-%d", i)})
		}(i)
	}
	wg.Wait()
	wins := 0
	for i, r := range rr {
		if r.Status == "crafted" {
			wins++
		}
		if ee[i] != nil {
			t.Fatal(ee[i])
		}
	}
	if wins != 1 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 999000 {
		t.Fatal("double spend")
	}
}

func TestIntegrationGrowthRewardBindingPolicy(t *testing.T) {
	for _, inherit := range []bool{false, true} {
		t.Run(fmt.Sprint(inherit), func(t *testing.T) {
			f := setup(t)
			id := f.modern(0, "")
			f.exec(`UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=$2 WHERE id=$1`, id, inherit)
			denied := f.apply(Command{Action: "upgrade", ID: id, UnboundInputs: true})
			if denied.Status != "reward_bound" {
				t.Fatal("ordinary-only used reward equipment", denied)
			}
			next := resultID(t, f.apply(Command{Action: "upgrade", ID: id}))
			var bound, propagate bool
			if err := f.db.Admin.QueryRow(f.ctx, `SELECT reward_bound,bind_outputs FROM fishing.equipment_instances WHERE id=$1`, next).Scan(&bound, &propagate); err != nil || bound != inherit || propagate != inherit {
				t.Fatal("growth binding mismatch", bound, propagate, err)
			}
			// Mixed ordinary equipment and inheriting material must produce bound gear.
			ordinary := f.modern(0, "")
			f.exec(`UPDATE fishing.inventory_stacks SET bound_quantity=quantity,inherit_quantity=quantity WHERE owner_id=$1 AND item_id='gear_alloy'`, f.owner)
			next = resultID(t, f.apply(Command{Action: "upgrade", ID: ordinary}))
			if err := f.db.Admin.QueryRow(f.ctx, `SELECT reward_bound,bind_outputs FROM fishing.equipment_instances WHERE id=$1`, next).Scan(&bound, &propagate); err != nil || !bound || !propagate {
				t.Fatal("mixed input lost binding", bound, propagate, err)
			}
			view, err := f.s.View(f.ctx, f.owner)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, e := range view["equipment"].([]Equipment) {
				if e.ID == next {
					found = e.Bound && e.RewardBound && e.BindOutputs
				}
			}
			if !found {
				t.Fatal("binding missing from growth view")
			}
		})
	}
}
