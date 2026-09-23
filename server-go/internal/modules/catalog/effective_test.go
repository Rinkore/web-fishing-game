package catalog

import (
	"context"
	"encoding/json"
	"testing"

	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestChestCostOverrideReplacementRestoresDefaults(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	base, _ := c.Chest("chest_wreck")
	patch := func(value string) {
		ApplyLegacySettings(c, map[string]json.RawMessage{"legacy:settings": json.RawMessage(value)})
	}
	patch(`{"chestCfg":{"pityN":3,"costs":{"chest_wreck":{"costRelic":2,"costCoins":7}}}}`)
	patch(`{"chestCfg":{"pityN":1}}`)
	chest, _ := c.Chest("chest_wreck")
	if chest.CostRelic != 2 || chest.CostCoins != 7 {
		t.Fatal("pity-only change reset costs", chest)
	}
	patch(`{"chestCfg":{"costs":{"chest_wreck":{"costRelic":1}}}}`)
	chest, _ = c.Chest("chest_wreck")
	if chest.CostRelic != 1 || chest.CostCoins != base.CostCoins {
		t.Fatal("omitted cost did not restore default", chest)
	}
	patch(`{"chestCfg":{"costs":{}}}`)
	chest, _ = c.Chest("chest_wreck")
	if chest.CostRelic != base.CostRelic || chest.CostCoins != base.CostCoins || c.ChestPityN() != 1 {
		t.Fatal("empty costs did not restore factory recipe", chest)
	}
}

func TestIntegrationEffectiveCatalogUsesOneImmutableSource(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	settings := map[string]any{
		"chestCfg":    map[string]any{"pityN": 3, "costs": map[string]any{"chest_wreck": map[string]any{"costRelic": 2, "costCoins": 7}}},
		"dropCfg":     map[string]any{"material": 250},
		"priceCfg":    map[string]any{"saleDivisor": .02, "floorPct": 25, "ceilPct": 300, "riseTargetPct": 250},
		"autoSellCfg": map[string]any{"batch": 7},
		"rareK":       4,
		"doubleBase":  .2,
		"castBaseMs":  2400, "castMinMs": 400,
	}
	mall := map[string]any{"refreshTime": "07:15", "items": []map[string]any{{"id": "rope", "price": 3, "limit": 2}}}
	smelt := map[string]any{"baseRate": 12}
	c, _, err := Effective(ctx, db.App)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.MallConfig(); got.RefreshTime == "07:15" || len(got.Items) == 1 && got.Items[0].Price == 3 {
		t.Fatalf("unexpected operator overlay: %+v", got)
	}
	if got := c.WorkshopConfig(); got.BaseRate == 12 {
		t.Fatalf("unexpected smelt operator overlay: %+v", got)
	}
	rawMall, _ := json.Marshal(mall)
	rawSmelt, _ := json.Marshal(smelt)
	ApplyLegacySettings(c, map[string]json.RawMessage{"legacy:mall": rawMall, "legacy:smelt": rawSmelt, "legacy:settings": mustJSON(settings)})
	var mergedMall rulesMallConfigCompat
	_ = json.Unmarshal(c.Defaults["mall"], &mergedMall)
	if mergedMall.RefreshTime != "07:15" || len(mergedMall.Items) != 1 || mergedMall.Items[0].Price != 3 {
		t.Fatalf("catalog mall patch not effective: %+v", mergedMall)
	}
	if got := c.DefaultLootConfig(); got.Material != 250 {
		t.Fatalf("drop override not effective: %+v", got)
	}
	if got := c.DefaultLootConfig(); got.RareK != 4 || c.Runtime["doubleBase"] != .2 {
		t.Fatalf("rare/double override not effective: %+v runtime=%v", got, c.Runtime)
	}
	if got := c.PriceDynamicsFor("crucian"); got.SaleDivisor != .02 || got.Floor != .25 || got.Ceil != 3 || got.Target != 2.5 {
		t.Fatalf("price override not effective: %+v", got)
	}
	if got := c.Runtime["autoSellBatch"]; got != float64(7) {
		t.Fatalf("autosell batch not effective: %v", got)
	}
	if got := c.CastRules(nil).BaseMS; got != 2400 || c.CastRules(nil).MinMS != 400 {
		t.Fatalf("cast override not effective: %+v", c.CastRules(nil))
	}
	chest, ok := c.Chest("chest_wreck")
	if !ok || chest.CostRelic != 2 || chest.CostCoins != 7 || c.Runtime["chestPityN"] != float64(3) {
		t.Fatalf("chest override not effective: %+v pity=%v", chest, c.Runtime["chestPityN"])
	}
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

type rulesMallConfigCompat struct {
	RefreshTime string `json:"refreshTime"`
	Items       []struct {
		Price int64 `json:"price"`
	} `json:"items"`
}
