package gateway

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
)

// saveSnapshot follows the console read/edit contract. Conflict tests pass
// their explicit stale revision through admin instead.
func (f *adminFixture) saveSnapshot(body string) (int, map[string]any) {
	f.t.Helper()
	var request map[string]any
	if err := json.Unmarshal([]byte(body), &request); err != nil {
		f.t.Fatal(err)
	}
	code, view := f.admin("GET", "/api/admin/users/snapshot?key="+request["target"].(string), "")
	f.expect(code, view, 200, "")
	request["expectedInvRev"] = view["invRev"]
	raw, _ := json.Marshal(request)
	return f.admin("POST", "/api/admin/users/snapshot", string(raw))
}

func TestIntegrationLegacySnapshotTierEditsAndRevisionConflicts(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('snapshot_fish','fish'),('snapshot_ore','material')`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'snapshot_fish','fish','normal',1),($1,'snapshot_fish','fish','large',2),($1,'snapshot_fish','fish','giant',3)`, f.playerID); err != nil {
		t.Fatal(err)
	}
	assertTiers := func(view map[string]any, normal, large, giant float64) {
		t.Helper()
		tiers := view["inventoryTiers"].(map[string]any)["snapshot_fish"].(map[string]any)
		if tiers["normal"] != normal || tiers["large"] != large || tiers["giant"] != giant {
			t.Fatalf("tier projection: %v", tiers)
		}
	}
	code, view := f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
	f.expect(code, view, 200, "")
	assertTiers(view, 1, 2, 3)
	code, result := f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"snapshot_fish":6}}`)
	f.expect(code, result, 200, "")
	assertTiers(result, 1, 2, 3)
	code, result = f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"snapshot_fish":8},"inventoryTiers":{"snapshot_fish":{"normal":2,"large":5,"giant":1}}}`)
	f.expect(code, result, 200, "")
	assertTiers(result, 2, 5, 1)
	code, result = f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"snapshot_fish":0},"inventoryTiers":{"snapshot_fish":{"normal":0,"large":0,"giant":0}}}`)
	f.expect(code, result, 200, "")
	if len(result["inventory"].(map[string]any)) != 0 || len(result["inventoryTiers"].(map[string]any)) != 0 {
		t.Fatalf("zero tier edit retained fish: %v", result)
	}
	staleRevision := result["invRev"]
	change, err := assets.New(f.db.App).ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: "snapshot-newer-assets", Reason: "reward", RuleVersion: "snapshot-test", Coins: 100, Stacks: []assets.StackDelta{{ItemID: "snapshot_ore", Tier: "normal", Quantity: 1}}})
	if err != nil || change.Status != "applied" {
		t.Fatalf("newer assets: %+v %v", change, err)
	}
	raw, _ := json.Marshal(map[string]any{"target": f.playerKey, "expectedInvRev": staleRevision, "coins": 500, "inventory": map[string]int64{}})
	code, result = f.admin("POST", "/api/admin/users/snapshot", string(raw))
	f.expect(code, result, 409, "资产已更新，请刷新后重试")
	code, view = f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
	f.expect(code, view, 200, "")
	if view["coins"] != float64(600) || view["inventory"].(map[string]any)["snapshot_ore"] != float64(1) {
		t.Fatalf("stale save changed newer assets: %v", view)
	}
	if code, _ := f.admin("POST", "/api/admin/users/snapshot", `{"target":"`+f.playerKey+`","coins":1}`); code != 400 {
		t.Fatalf("missing revision accepted: %d", code)
	}

	// Two editors based on the same snapshot cannot both commit.
	var group sync.WaitGroup
	codes := make(chan int, 2)
	for _, coins := range []int{700, 800} {
		raw, _ := json.Marshal(map[string]any{"target": f.playerKey, "expectedInvRev": view["invRev"], "coins": coins})
		group.Add(1)
		go func(body string) {
			defer group.Done()
			code, _ := f.admin("POST", "/api/admin/users/snapshot", body)
			codes <- code
		}(string(raw))
	}
	group.Wait()
	close(codes)
	accepted, conflicted := 0, 0
	for code := range codes {
		switch code {
		case 200:
			accepted++
		case 409:
			conflicted++
		default:
			t.Fatalf("concurrent save: %d", code)
		}
	}
	if accepted != 1 || conflicted != 1 {
		t.Fatalf("concurrent saves accepted=%d conflicted=%d", accepted, conflicted)
	}
}

func TestIntegrationLegacySnapshotEditsActiveSavedRod(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES('rod_bamboo','equipment','rod'),('rod_fiberglass','equipment','rod') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	code, result := f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"rod_bamboo#common#":1},"bd":{"rod":{"compId":"rod_bamboo#common#"}}}`)
	f.expect(code, result, 200, "")
	res, err := assets.New(f.db.App).ChangeRod(ctx, assets.RodCommand{ActorID: f.playerID, RequestKey: "snapshot-save-active-rod", Action: "save", Slot: 0})
	if err != nil || res.Status != "rod_updated" {
		t.Fatalf("save rod: %+v %v", res, err)
	}
	if _, err := f.db.Admin.Exec(ctx, `DELETE FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=-1`, f.playerID); err != nil {
		t.Fatal(err)
	}
	var original int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=0 AND part='rod'`, f.playerID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	code, result = f.saveSnapshot(`{"target":"` + f.playerKey + `","bd":{"rod":{"compId":"rod_bamboo#common#"}}}`)
	f.expect(code, result, 200, "")
	for _, signature := range []string{"rod_bamboo#mythic#spd12", "rod_fiberglass#rare#spd5"} {
		code, result = f.saveSnapshot(`{"target":"` + f.playerKey + `","bd":{"rod":{"compId":"` + signature + `"}}}`)
		f.expect(code, result, 200, "")
		if result["bd"].(map[string]any)["rod"].(map[string]any)["compId"] != signature {
			t.Fatalf("installed affix edit: %v", result)
		}
	}
	var active, available, temp, consumed, created int
	if err := f.db.Admin.QueryRow(ctx, `SELECT (SELECT slot FROM fishing.rod_loadouts WHERE owner_id=$1 AND active),(SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'),(SELECT count(*) FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=-1),(SELECT count(*) FROM fishing.equipment_entries WHERE equipment_id=$2 AND action='consume'),(SELECT count(*) FROM fishing.equipment_entries l JOIN fishing.equipment_instances e ON e.id=l.equipment_id WHERE e.owner_id=$1 AND e.lifecycle='available' AND l.action='create')`, f.playerID, original).Scan(&active, &available, &temp, &consumed, &created); err != nil {
		t.Fatal(err)
	}
	if active != 0 || available != 1 || temp != 0 || consumed != 1 || created != 1 {
		t.Fatalf("replacement/active slot ledger: %d %d %d %d %d", active, available, temp, consumed, created)
	}
}
