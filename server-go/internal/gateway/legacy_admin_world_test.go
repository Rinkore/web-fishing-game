package gateway

import (
	"encoding/json"
	"testing"
)

func TestIntegrationLegacyAdminWorldReadRoutes(t *testing.T) {
	f := newAdminFixture(t)
	if code, _ := f.call("GET", "/api/admin/world", "", ""); code != 401 {
		t.Fatalf("anonymous world: %d", code)
	}
	if code, _ := f.player("GET", "/api/admin/loot/groups", ""); code != 401 {
		t.Fatalf("player loot groups: %d", code)
	}
	code, world := f.admin("GET", "/api/admin/world", "")
	f.expect(code, world, 200, "")
	if world["ok"] != true || len(world["grounds"].([]any)) == 0 {
		t.Fatalf("world projection: %v", world)
	}
	catalog, ok := world["catalog"].(map[string]any)
	if !ok || len(catalog["fish"].([]any)) == 0 {
		t.Fatalf("world catalog: %v", world["catalog"])
	}
	code, groups := f.admin("GET", "/api/admin/loot/groups", "")
	f.expect(code, groups, 200, "")
	if groups["ok"] != true {
		t.Fatalf("loot groups response: %v", groups)
	}
	code, spots := f.admin("GET", "/api/admin/loot/spots", "")
	f.expect(code, spots, 200, "")
	if spots["ok"] != true || len(spots["spots"].([]any)) == 0 {
		t.Fatalf("loot spots response: %v", spots)
	}
}

func TestIntegrationLegacyAdminWorldPreservesEditorState(t *testing.T) {
	f := newAdminFixture(t)
	code, before := f.admin("GET", "/api/admin/world", "")
	f.expect(code, before, 200, "")
	componentDefaults, fishDefaults := jsonString(before["componentDefaults"]), jsonString(before["fishDefaults"])
	fishID := before["catalog"].(map[string]any)["fish"].([]any)[0].(map[string]any)["id"].(string)
	ground := before["grounds"].([]any)[0].(map[string]any)
	spot := ground["spots"].([]any)[0].(map[string]any)
	groundID, spotID := ground["id"].(string), spot["id"].(string)

	post := func(path string, body any) map[string]any {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		status, response := f.admin("POST", path, string(raw))
		f.expect(status, response, 200, "")
		return response
	}
	component := post("/api/admin/component/config", map[string]any{
		"qualityWeights": map[string]any{"common": 7, "rare": 2, "epic": 1},
	})
	fish := post("/api/admin/fish/config", map[string]any{
		"sizeModel": "custom", "sizeWeights": []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
	})
	group := map[string]any{"id": "baseline_group", "name": "基线掉落组", "weight": 37,
		"items": []any{map[string]any{"pick": "fish:" + fishID, "weight": 9}}}
	post("/api/admin/loot/group", map[string]any{"group": group})
	pool := []any{map[string]any{"pick": "group:baseline_group", "weight": 13}}
	post("/api/admin/spot/pool", map[string]any{"groundId": groundID, "spotId": spotID, "pool": pool})
	post("/api/admin/smelt/config", map[string]any{"baseRate": 1})

	code, after := f.admin("GET", "/api/admin/world", "")
	f.expect(code, after, 200, "")
	if jsonString(after["componentCfg"]) != jsonString(component["componentCfg"]) || jsonString(after["fishCfg"]) != jsonString(fish["fishCfg"]) {
		t.Fatal("world editor lost the published component or fish configuration")
	}
	if jsonString(after["componentDefaults"]) != componentDefaults || jsonString(after["fishDefaults"]) != fishDefaults {
		t.Fatal("editing configuration changed the world's reset defaults")
	}
	if len(after["poolPresets"].(map[string]any)) == 0 {
		t.Fatal("world editor lost the pool presets")
	}
	for _, key := range []string{"castFormula", "biteFormula"} {
		if _, exists := after[key]; !exists {
			t.Fatalf("world editor lost %s", key)
		}
	}
	if after["smeltCfg"].(map[string]any)["baseRate"] != float64(1) {
		t.Fatal("world editor lost the additional legacy settings")
	}
	foundSpot := false
	for _, value := range after["grounds"].([]any) {
		g := value.(map[string]any)
		if g["id"] != groundID {
			continue
		}
		for _, value := range g["spots"].([]any) {
			s := value.(map[string]any)
			if s["id"] == spotID {
				foundSpot = true
				if jsonString(s["pool"]) != jsonString(pool) {
					t.Fatal("admin world flattened the editable group reference or changed its weight")
				}
			}
		}
	}
	if !foundSpot {
		t.Fatal("world editor lost the updated spot")
	}
	code, groups := f.admin("GET", "/api/admin/loot/groups", "")
	f.expect(code, groups, 200, "")
	for _, values := range []any{after["lootGroups"], groups["groups"]} {
		found := false
		for _, value := range values.([]any) {
			row := value.(map[string]any)
			if row["id"] == "baseline_group" {
				found = true
				if jsonString(row) != jsonString(group) {
					t.Fatalf("world editor lost group metadata: %v", row)
				}
			}
		}
		if !found {
			t.Fatal("world editor lost the published group")
		}
	}
}
