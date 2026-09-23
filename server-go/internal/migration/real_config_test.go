package migration

import (
	"encoding/json"
	"testing"
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
