package gateway

import (
	"encoding/json"
	"testing"

	"fishing.local/server/internal/rules"
)

func TestAdminWorldComponentPools(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	// Empty pools must still be JSON arrays for the editor's map/find calls.
	c.Items = append(c.Items, rules.Item{ID: "empty_pool", Kind: "component"})
	view := worldView(c, nil)
	rows := view["catalog"].(map[string]any)["components"].([]map[string]any)
	seen := 0
	for _, it := range c.Items {
		if it.Kind != "component" {
			continue
		}
		row := rows[seen]
		seen++
		pool, ok := row["pool"].([]rules.AffixRange)
		if !ok || pool == nil {
			t.Fatalf("component %s has no array-valued pool: %v", it.ID, row["pool"])
		}
		if len(pool) != len(it.Pool) {
			t.Fatalf("component %s lost affix ranges", it.ID)
		}
		for i, p := range it.Pool {
			if pool[i] != p {
				t.Fatalf("component %s affix %d: got %+v, want %+v", it.ID, i, pool[i], p)
			}
		}
	}
	if seen < 2 {
		t.Fatal("expected default components and an empty-pool component")
	}
}

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
	levels, ok := world["notifyLevels"].(map[string]any)
	if !ok || len(levels) != 5 || world["notifyLevel"] != "all" {
		t.Fatalf("notification editor missing defaults: %v / %v", levels, world["notifyLevel"])
	}
	for _, level := range []string{"all", "uncommon", "offrange", "records", "none"} {
		if label, ok := levels[level].(string); !ok || label == "" {
			t.Fatalf("notification level %s has no label", level)
		}
	}
	catalog, ok := world["catalog"].(map[string]any)
	if !ok || len(catalog["fish"].([]any)) == 0 {
		t.Fatalf("world catalog: %v", world["catalog"])
	}
	for _, raw := range catalog["components"].([]any) {
		component := raw.(map[string]any)
		if _, ok := component["pool"].([]any); !ok {
			t.Fatalf("component %v pool is not a JSON array", component["id"])
		}
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

func TestIntegrationLegacyAdminNotificationEditorReload(t *testing.T) {
	f := newAdminFixture(t)
	for _, tc := range []struct{ saved, selected string }{
		{"records", "records"}, {"none", "none"}, {"rare", "uncommon"}, {"off", "none"}, {"all", "all"},
	} {
		code, result := f.admin("POST", "/api/admin/settings", `{"notifyLevel":"`+tc.saved+`"}`)
		f.expect(code, result, 200, "")
		code, world := f.admin("GET", "/api/admin/world", "")
		f.expect(code, world, 200, "")
		if world["notifyLevel"] != tc.selected {
			t.Fatalf("saved %s: selected %v, want %s", tc.saved, world["notifyLevel"], tc.selected)
		}
		if world["notifyLevels"].(map[string]any)[tc.selected] == nil {
			t.Fatalf("selected level %s has no option", tc.selected)
		}
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
	savedPool := post("/api/admin/spot/pool", map[string]any{"groundId": groundID, "spotId": spotID, "pool": pool})
	if jsonString(savedPool["pool"]) != jsonString(pool) {
		t.Fatalf("spot pool mutation did not publish the requested pool: got %v, want %v", savedPool["pool"], pool)
	}
	buffs := []any{map[string]any{"type": "speed", "value": 17.5}}
	savedBuffs := post("/api/admin/spot/buffs", map[string]any{"groundId": groundID, "spotId": spotID, "buffs": buffs})
	if jsonString(savedBuffs["buffs"]) != jsonString(buffs) {
		t.Fatalf("spot buffs mutation did not publish the requested buffs: got %v, want %v", savedBuffs["buffs"], buffs)
	}
	added := post("/api/admin/spot/add", map[string]any{"groundId": groundID, "id": "baseline_spot", "name": "基线新增钓点", "preset": "rare", "fill": true})
	addedSpot, ok := added["spot"].(map[string]any)
	if !ok || addedSpot["id"] != "baseline_spot" || addedSpot["name"] != "基线新增钓点" || added["filled"] != true || added["preset"] != "rare" {
		t.Fatalf("spot add did not publish the requested spot: %v", added)
	}
	if values, ok := addedSpot["pool"].([]any); !ok || len(values) == 0 {
		t.Fatalf("spot add did not retain the requested preset pool: %v", addedSpot)
	}
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
	foundSpot, foundAddedSpot := false, false
	for _, value := range after["grounds"].([]any) {
		g := value.(map[string]any)
		if g["id"] != groundID {
			continue
		}
		for _, value := range g["spots"].([]any) {
			s := value.(map[string]any)
			if s["id"] == "baseline_spot" {
				foundAddedSpot = true
				if jsonString(s) != jsonString(addedSpot) {
					t.Fatalf("world editor changed the newly published spot: got %v, want %v", s, addedSpot)
				}
			}
			if s["id"] == spotID {
				foundSpot = true
				if jsonString(s["pool"]) != jsonString(pool) {
					t.Fatalf("admin world flattened the editable group reference or changed its weight: got %v, want %v", s["pool"], pool)
				}
				if jsonString(s["buffs"]) != jsonString(buffs) {
					t.Fatalf("world editor lost the published spot buffs: got %v, want %v", s["buffs"], buffs)
				}
			}
		}
	}
	if !foundSpot {
		t.Fatal("world editor lost the updated spot")
	}
	if !foundAddedSpot {
		t.Fatal("world editor lost the newly published spot")
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
