package sea

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
	"time"
)

func TestGroundWindowClosedUsesCatalogWindowAtActionTime(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	var grounds []map[string]any
	if err := c.Constant("GROUNDS", &grounds); err != nil || len(grounds) == 0 {
		t.Fatal("default grounds missing")
	}
	now := time.UnixMilli(1_000_000)
	grounds[0]["openFrom"] = float64(now.Add(time.Hour).UnixMilli())
	raw, _ := json.Marshal(grounds)
	c.Constants["GROUNDS"] = raw
	if !groundWindowClosed(c, grounds[0]["id"].(string), now) {
		t.Fatal("future openFrom did not close ground")
	}
	grounds[0]["openFrom"] = nil
	grounds[0]["openTo"] = float64(now.Add(-time.Hour).UnixMilli())
	raw, _ = json.Marshal(grounds)
	c.Constants["GROUNDS"] = raw
	if !groundWindowClosed(c, grounds[0]["id"].(string), now) {
		t.Fatal("expired openTo did not close ground")
	}
}

func TestIntegrationChartCraftShipUpgradeAndRollback(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err := db.Admin.Exec(ctx, sql, owner); err != nil {
			t.Fatal(err)
		}
	}
	a := assets.New(db.App)
	s := New(db.App, c)
	if _, err := a.ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: "stock", Reason: "reward", RuleVersion: "test-v1", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: 6}, {ItemID: "deepscale", Tier: "normal", Quantity: 150}}}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]assets.Result, 4)
	errs := make([]error, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Apply(ctx, Command{ActorID: owner, RequestKey: fmt.Sprintf("chart-%d", i), Action: "chart"})
		}(i)
	}
	wg.Wait()
	crafted := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.Status == "crafted" {
			crafted++
		}
		again, err := s.Apply(ctx, Command{ActorID: owner, RequestKey: fmt.Sprintf("chart-%d", i), Action: "chart"})
		if err != nil || again.OperationID != r.OperationID || again.Status != r.Status {
			t.Fatal("chart retry", err)
		}
	}
	if crafted != 2 {
		t.Fatal("chart overspend", crafted)
	}
	state, err := s.View(ctx, owner)
	if err != nil || state.Charts != 2 || state.Level != 1 {
		t.Fatal("state", state, err)
	}
	r, err := s.Apply(ctx, Command{owner, "no-xp", "upgrade", 1})
	if err != nil || r.Status != "ship_experience_insufficient" {
		t.Fatal("xp guard", r, err)
	}
	// XP is seeded only in the isolated fixture; gameplay XP awaits formal catches.
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_players SET experience=560 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Apply(ctx, Command{owner, fmt.Sprintf("upgrade-%d", i), "upgrade", 1})
		}(i)
	}
	wg.Wait()
	upgraded := 0
	for i := 0; i < 2; i++ {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if results[i].Status == "upgraded" {
			upgraded++
		} else if results[i].Status != "ship_level_changed" {
			t.Fatal(results[i])
		}
	}
	if upgraded != 1 {
		t.Fatal("duplicate upgrade", upgraded)
	}
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_progress BEFORE INSERT ON fishing.sea_progress_entries FOR EACH ROW EXECUTE FUNCTION fishing.fail_progress()`); err != nil {
		t.Fatal(err)
	}
	cmd := Command{owner, "upgrade-fault", "upgrade", 2}
	if _, err := s.Apply(ctx, cmd); err == nil {
		t.Fatal("expected fault")
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_progress ON fishing.sea_progress_entries`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Apply(ctx, cmd)
	if err != nil || r.Status != "upgraded" {
		t.Fatal("retry", r, err)
	}
	state, err = s.View(ctx, owner)
	if err != nil || state.Level != 3 || state.Experience != 560 {
		t.Fatal("upgrade consumed xp", state, err)
	}
	var coins, scales int64
	if err := db.Admin.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&coins); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='deepscale' AND tier='normal'`, owner).Scan(&scales); err != nil {
		t.Fatal(err)
	}
	if coins != 900000 || scales != 130 {
		t.Fatal("upgrade cost rollback", coins, scales)
	}
	if _, err := a.ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: "more-charts", Reason: "reward", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: 6}}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := s.Apply(ctx, Command{owner, fmt.Sprintf("extra-chart-%d", i), "chart", 0}); err != nil {
			t.Fatal(err)
		}
	}
	for i := range results {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errs[i] = s.Voyage(ctx, owner, fmt.Sprintf("voyage-%d", i)) }(i)
	}
	wg.Wait()
	sailed := 0
	zoneID := ""
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.Status == "voyaged" {
			sailed++
			zoneID = r.ResourceID
		} else if r.Status != "sea_zone_limit" {
			t.Fatal(r.Status)
		}
		again, err := s.Voyage(ctx, owner, fmt.Sprintf("voyage-%d", i))
		if err != nil || again.OperationID != r.OperationID || again.Status != r.Status {
			t.Fatal("voyage replay", err)
		}
	}
	if sailed != 3 {
		t.Fatal("zone cap race", sailed)
	}
	zones, err := s.Zones(ctx, owner)
	if err != nil || len(zones) != 3 {
		t.Fatal("zones", err)
	}
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_anchor BEFORE UPDATE ON fishing.sea_zones FOR EACH ROW EXECUTE FUNCTION fishing.fail_anchor()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Anchor(ctx, owner, "anchor-fault", zoneID); err == nil {
		t.Fatal("expected anchor fault")
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_anchor ON fishing.sea_zones`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Anchor(ctx, owner, "anchor-fault", zoneID)
	if err != nil || r.Status != "anchored" {
		t.Fatal("anchor retry", r, err)
	}
	var anchored rules.SeaZone
	if err := json.Unmarshal(r.Details, &anchored); err != nil || anchored.Anchors != 1 {
		t.Fatal("anchor count", err)
	}
	for i := 0; i < 3; i++ {
		r, err := s.Anchor(ctx, owner, fmt.Sprintf("anchor-%d", i), zoneID)
		if err != nil {
			t.Fatal(err)
		}
		if i < 2 && r.Status != "anchored" || i == 2 && r.Status != "sea_anchor_limit" {
			t.Fatal("anchor limit", r.Status)
		}
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_zones SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1 AND id=$2`, owner, zoneID); err != nil {
		t.Fatal(err)
	}
	r, err = s.Anchor(ctx, owner, "expired-anchor", zoneID)
	if err != nil || r.Status != "sea_zone_expired" {
		t.Fatal("expired anchor", r, err)
	}
	r, err = s.Voyage(ctx, owner, "reuse-zone-slot")
	if err != nil || r.Status != "voyaged" {
		t.Fatal("expired zone slot", r, err)
	}
	state, err = s.View(ctx, owner)
	if err != nil || state.Charts != 0 {
		t.Fatal("chart consumption", state, err)
	}
	refreshed, err := s.QuestRefresh(ctx, owner, "quests-1")
	if err != nil || refreshed.Status != "refreshed" {
		t.Fatal("quest refresh", err)
	}
	again, err := s.QuestRefresh(ctx, owner, "quests-2")
	if err != nil || string(refreshed.Details) != string(again.Details) {
		t.Fatal("request key rerolled board", err)
	}
	// Synthetic selected board exercises submit and incomplete catch claims deterministically.
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_quest_boards SET selected='[{"id":"q_submit_scale","progress":0,"claimed":false},{"id":"q_zone_catch","progress":0,"claimed":false},{"id":"q_voyage","progress":2,"claimed":false}]' WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	r, err = s.QuestClaim(ctx, owner, "incomplete", "q_zone_catch")
	if err != nil || r.Status != "quest_incomplete" {
		t.Fatal("incomplete claim", r, err)
	}
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.selected::text LIKE '%true%' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_claim BEFORE UPDATE ON fishing.sea_quest_boards FOR EACH ROW EXECUTE FUNCTION fishing.fail_claim()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.QuestClaim(ctx, owner, "claim-fault", "q_submit_scale"); err == nil {
		t.Fatal("expected claim fault")
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_claim ON fishing.sea_quest_boards`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.QuestClaim(ctx, owner, fmt.Sprintf("claim-%d", i), "q_submit_scale")
		}(i)
	}
	wg.Wait()
	claimed := 0
	for i := 0; i < 2; i++ {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if results[i].Status == "claimed" {
			claimed++
		} else if results[i].Status != "quest_already_claimed" {
			t.Fatal(results[i])
		}
	}
	if claimed != 1 {
		t.Fatal("duplicate quest reward", claimed)
	}
	var pearls int64
	if err := db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='dragonpearl' AND tier='normal'`, owner).Scan(&pearls); err != nil || pearls != 2 {
		t.Fatal("quest reward rollback", pearls, err)
	}
	r, err = s.QuestClaim(ctx, owner, "voyage-claim", "q_voyage")
	if err != nil || r.Status != "claimed" {
		t.Fatal("voyage claim", r, err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_quest_boards SET day=day-1 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	r, err = s.QuestRefresh(ctx, owner, "new-day")
	if err != nil {
		t.Fatal(err)
	}
	var board QuestBoard
	if json.Unmarshal(r.Details, &board) != nil {
		t.Fatal("board decode")
	}
	for _, q := range board.Selected {
		if q.Claimed {
			t.Fatal("previous day claim survived reset")
		}
	}
}
