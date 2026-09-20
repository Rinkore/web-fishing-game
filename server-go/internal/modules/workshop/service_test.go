package workshop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
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
	r, err := f.assets.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: "resources", Reason: "reward", RuleVersion: "test-v1", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "relic", Tier: "normal", Quantity: 1000}, {ItemID: "dragonpearl", Tier: "normal", Quantity: 100}, {ItemID: "bait_pack", Tier: "normal", Quantity: 100}}})
	if err != nil || r.Status != "applied" {
		t.Fatal("resources", err)
	}
	return f
}
func (f *fixture) key() string { f.seq++; return fmt.Sprintf("craft-%d", f.seq) }
func (f *fixture) gear(signature string) int64 {
	f.t.Helper()
	base, _, _, ok := f.c.Instance(signature)
	if !ok {
		f.t.Fatal("invalid fixture signature")
	}
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	r, err := f.assets.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.key(), Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}}})
	if err != nil || len(r.EquipmentIDs) != 1 {
		f.t.Fatal("gear creation", err)
	}
	id, _ := strconv.ParseInt(r.EquipmentIDs[0], 10, 64)
	return id
}
func (f *fixture) num(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func TestIntegrationSmeltRetryPreservesRandomResultAndAtomicAssets(t *testing.T) {
	f := setup(t)
	mainSig := "rod_bamboo#mythic#spd+5,skl+3,rare+2@bt"
	subSig := "rod_bamboo#epic#skl+2"
	main, sub := f.gear(mainSig), f.gear(subSig)
	command := Command{ActorID: f.owner, RequestKey: f.key(), Action: "smelt", MainID: main, SubID: sub, MainAffix: "speed", SubAffix: "skill", Materials: []rules.Material{{ID: "bait_pack", Quantity: 3}}, Relics: 10, Pearl: true}
	input := struct {
		Command Command
		Version string
	}{command, f.s.ruleVersion()}
	seed, err := f.s.intent(f.ctx, f.owner, command.RequestKey, input)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := f.c.SmeltPlan(rules.SmeltInput{MainID: mainSig, SubID: subSig, MainAffix: "speed", SubAffix: "skill", Materials: command.Materials, Relics: 10, Pearl: true}, f.c.ComponentConfig(), f.c.WorkshopConfig())
	if err != nil {
		t.Fatal(err)
	}
	expected := plan.Roll(rules.Stream(seed, "workshop:smelt"))
	if _, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.test_craft_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault'; END $$; CREATE TRIGGER test_craft_failure BEFORE INSERT ON fishing.equipment_instances FOR EACH ROW EXECUTE FUNCTION fishing.test_craft_failure()`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Apply(f.ctx, command); !errors.Is(err, assets.ErrUnavailable) {
		t.Fatal("synthetic failure did not abort")
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=ANY($1::bigint[]) AND lifecycle='available'`, []int64{main, sub}) != 2 || f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.owner) != 1000000 {
		t.Fatal("craft failure did not roll back")
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DROP TRIGGER test_craft_failure ON fishing.equipment_instances`); err != nil {
		t.Fatal(err)
	}
	r, err := f.s.Apply(f.ctx, command)
	if err != nil || r.Status != "crafted" {
		t.Fatal("smelt", r, err)
	}
	var outcome rules.SmeltOutcome
	if json.Unmarshal(r.Details, &outcome) != nil {
		t.Fatal("missing craft outcome")
	}
	want, _ := json.Marshal(expected)
	if string(want) != string(r.Details) {
		t.Fatal("retry rerolled private seed")
	}
	repeated, err := f.s.Apply(f.ctx, command)
	if err != nil || repeated.OperationID != r.OperationID || repeated.EquipmentIDs[0] != r.EquipmentIDs[0] {
		t.Fatal("duplicate smelt")
	}
	if f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.owner) != 1000000-int64(plan.Gold) || f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='relic'`, f.owner) != 990 {
		t.Fatal("smelt costs")
	}
	command.Relics = 9
	if _, err := f.s.Apply(f.ctx, command); !errors.Is(err, assets.ErrKeyConflict) {
		t.Fatal("changed random command accepted")
	}
}
func TestIntegrationForgeRecastChestAndConcurrentConsumption(t *testing.T) {
	f := setup(t)
	id := f.gear("rod_bamboo#mythic#spd+5,skl+3")
	forged, err := f.s.Apply(f.ctx, Command{ActorID: f.owner, RequestKey: f.key(), Action: "forge", MainID: id, MaterialID: "bait_pack", Pearl: true})
	if err != nil || forged.Status != "crafted" {
		t.Fatal("forge", err)
	}
	newID, _ := strconv.ParseInt(forged.EquipmentIDs[0], 10, 64)
	var wg sync.WaitGroup
	results := make(chan assets.Result, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.s.Apply(f.ctx, Command{ActorID: f.owner, RequestKey: fmt.Sprintf("recast-race-%d", i), Action: "recast", MainID: newID, Target: 2})
			if err != nil {
				t.Error(err)
			}
			results <- r
		}()
	}
	wg.Wait()
	close(results)
	wins := 0
	for r := range results {
		if r.Status == "crafted" {
			wins++
		}
	}
	if wins != 1 {
		t.Fatal("same equipment consumed twice")
	}
	r, err := f.s.Chest(f.ctx, ChestCommand{ActorID: f.owner, RequestKey: f.key(), ChestID: "chest_king", Action: "craft", Quantity: 1})
	if err != nil || r.Status != "crafted" {
		t.Fatal("chest craft", r, err)
	}
	open := ChestCommand{ActorID: f.owner, RequestKey: f.key(), ChestID: "chest_king", Action: "open", Quantity: 1, BaseID: "rod_bamboo"}
	r, err = f.s.Chest(f.ctx, open)
	if err != nil || r.Status != "opened" {
		t.Fatal("chest open", r, err)
	}
	repeat, err := f.s.Chest(f.ctx, open)
	if err != nil || repeat.OperationID != r.OperationID {
		t.Fatal("chest duplicate")
	}
	if f.num(`SELECT count FROM fishing.player_codex WHERE owner_id=$1 AND item_id='rod_bamboo'`, f.owner) != 1 {
		t.Fatal("codex duplicate")
	}
	if f.num(`SELECT w.coins-COALESCE(sum(e.delta),0) FROM fishing.wallets w LEFT JOIN fishing.asset_entries e ON e.account_id=w.account_id WHERE w.account_id=$1 GROUP BY w.coins`, f.owner) != 0 {
		t.Fatal("craft ledger mismatch")
	}
}
