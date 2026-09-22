package catalog

import (
	"context"
	"encoding/json"
	"testing"

	"fishing.local/server/internal/testdb"
)

func TestIntegrationEffectiveOperatorSettingsReachRules(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	settings := map[string]any{
		"chestCfg":    map[string]any{"pityN": 3, "costs": map[string]any{"chest_wreck": map[string]any{"costRelic": 2, "costCoins": 7}}},
		"dropCfg":     map[string]any{"material": 250},
		"priceCfg":    map[string]any{"saleDivisor": .02, "floorPct": 25, "ceilPct": 300, "riseTargetPct": 250},
		"autoSellCfg": map[string]any{"batch": 7},
		"castBaseMs":  2400, "castMinMs": 400,
	}
	mall := map[string]any{"refreshTime": "07:15", "items": []map[string]any{{"id": "rope", "price": 3, "limit": 2}}}
	smelt := map[string]any{"baseRate": 12}
	for key, value := range map[string]any{"legacy:settings": settings, "legacy:mall": mall, "legacy:smelt": smelt} {
		raw, _ := json.Marshal(value)
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES($1,$2)`, key, raw); err != nil {
			t.Fatal(err)
		}
	}
	c, _, err := Effective(ctx, db.App)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.MallConfig(); got.RefreshTime != "07:15" || len(got.Items) != 1 || got.Items[0].Price != 3 {
		t.Fatalf("mall override not effective: %+v", got)
	}
	if got := c.WorkshopConfig(); got.BaseRate != 12 {
		t.Fatalf("smelt override not effective: %+v", got)
	}
	if got := c.DefaultLootConfig(); got.Material != 250 {
		t.Fatalf("drop override not effective: %+v", got)
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
