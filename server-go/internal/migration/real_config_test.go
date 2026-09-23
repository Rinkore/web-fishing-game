package migration

import (
	"bytes"
	"encoding/json"
	"testing"

	"fishing.local/server/internal/rules"
)

func TestRealCatalogPreservesEffectiveRulesAndIgnoresObsoleteGrounds(t *testing.T) {
	cfg := map[string]any{}
	if err := json.Unmarshal([]byte(`{"groundCfg":{"spots":{"map:ice":{"intervalMs":20000,"locked":false},"obsolete:dock":{"intervalMs":100}},"customSpots":{"obsolete":[{"id":"fake","pool":[]}]},"removed":{"grounds":[],"spots":[]}},"fishCfg":{"sizeModel":"custom","sizeWeights":[1,12,16,24,32,32,24,16,12,1]},"castCfg":{"baseMs":12345,"minMs":100,"speedBonus":0.01,"speedCap":90},"autoSellCfg":{"batch":37}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	c, err := buildRealCatalog(cfg, map[string]any{"priceOv": map[string]any{"crucian": map[string]any{"base": 50}}})
	if err != nil {
		t.Fatal(err)
	}
	if c.EconomyBase("crucian", 1) != 50 {
		t.Fatal("price override not active")
	}
	if c.CastRules(nil).BaseMS != 12345 || c.Runtime["autoSellBatch"] != float64(37) {
		t.Fatal("runtime settings missing")
	}
	if len(c.Grounds()) != 1 || c.Grounds()[0].ID != "map" {
		t.Fatal("obsolete grounds were resurrected")
	}
	found := false
	for _, s := range c.Grounds()[0].Spots {
		if s.ID == "ice" {
			found = true
			if s.Locked {
				t.Fatal("ice lock override missing")
			}
		}
	}
	if !found {
		t.Fatal("ice missing")
	}
}

func TestRealCatalogKeepsExpeditionsAndHidesObsoleteMallEntries(t *testing.T) {
	var cfg map[string]any
	if err := json.Unmarshal([]byte(`{"mallCfg":{"refreshTime":"05:30","items":[{"id":"tide_sand","price":4500,"limit":100},{"id":"dragon_scale","price":12000,"limit":100},{"id":"relic","price":6500,"limit":100},{"id":"dragonpearl","price":14000,"limit":200}]},"smeltCfg":{"baseRate":99,"failPerMaterial":-4}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(cfg)
	c, err := buildRealCatalog(cfg, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	mall := c.MallConfig()
	if mall.RefreshTime != "05:30" || len(mall.Items) != 2 || mall.Items[0] != (rules.MallItem{ID: "relic", Price: 6500, Limit: 100}) || mall.Items[1] != (rules.MallItem{ID: "dragonpearl", Price: 14000, Limit: 200}) {
		t.Fatal("effective mall lost applicable legacy settings")
	}
	after, _ := json.Marshal(cfg)
	if !bytes.Equal(before, after) {
		t.Fatal("source configuration was mutated")
	}
	base, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"EXPEDITION", "GEAR_SETS", "PART_AFFIXES"} {
		if len(c.Constants[key]) == 0 || !bytes.Equal(jsonBytes(c.Constants[key], nil), jsonBytes(base.Constants[key], nil)) {
			t.Fatalf("new version constant %s was erased", key)
		}
	}
	for _, id := range []string{"tide_sand", "dragon_scale", "grindstone"} {
		if item, ok := c.Item(id); !ok || !item.ExpeditionOnly || !item.NoSell {
			t.Fatalf("current material restrictions lost for %s", id)
		}
	}
	if item, ok := c.Item("rod_fiberglass"); !ok || !item.Legacy {
		t.Fatal("old equipment definition was removed")
	}
	if c.WorkshopConfig().BaseRate != 99 || c.WorkshopConfig().FailPerMaterial != -4 {
		t.Fatal("operator workshop settings changed")
	}
}

func TestRealMarketIdentityRejectsUnknownAndDuplicateRodParts(t *testing.T) {
	c, err := buildRealCatalog(map[string]any{}, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var signature, part string
	for _, it := range c.Items {
		if it.Kind == "component" && it.Part != "" {
			signature = it.ID + "#common#"
			part = it.Part
			break
		}
	}
	if k, p, err := realMarketParts(c, signature); err != nil || k != "equipment" || p[part] != signature {
		t.Fatal("equipment signature rejected")
	}
	if k, _, err := realMarketParts(c, "rodset:"+part+"="+signature); err != nil || k != "rod" {
		t.Fatal("rod rejected")
	}
	for _, id := range []string{"unknown", "rodset:" + part + "=" + signature + ";" + part + "=" + signature} {
		if _, _, err := realMarketParts(c, id); err == nil {
			t.Fatal("invalid market identity accepted")
		}
	}
}

func TestRealSeaPatchPreservesQuestKindsAndConvertsUnits(t *testing.T) {
	cfg := map[string]any{}
	if err := json.Unmarshal([]byte(`{"seaCfg":{"ship":{"names":["One","Two","Three","Four","Five"]},"sea":{"zoneTtlMin":37,"quests":[{"id":"q_ocean_catch","title":"Changed","need":21,"reward":{"coins":19}},{"id":"q_submit_scale","need":9,"submitNeed":5}]}}}`), &cfg); err != nil {
		t.Fatal(err)
	}
	c, err := buildRealCatalog(cfg, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	sea := c.SeaConfig()
	if sea.ZoneTTL != 37*60000 {
		t.Fatal("legacy minutes were not converted")
	}
	for _, q := range sea.Quests {
		if q.Kind == "" {
			t.Fatal("quest kind erased")
		}
		if q.ID == "q_ocean_catch" && (q.Kind != "catch_ocean" || q.Need != 21 || q.Reward.Coins != 19) {
			t.Fatal("quest patch missing")
		}
		if q.ID == "q_submit_scale" && (q.Kind != "submit" || q.Submit == nil || q.Submit.Count != 8 || q.Need != 1) {
			t.Fatal("submit semantics were erased")
		}
	}
	var ship struct {
		Levels []struct {
			Name string `json:"name"`
		} `json:"levels"`
	}
	if c.Constant("SHIP", &ship) != nil || ship.Levels[0].Name != "One" {
		t.Fatal("ship names not applied")
	}
}
