package gateway

import (
	"encoding/json"
	"net/http"

	"fishing.local/server/internal/rules"
)

// legacyAdminWorld extends the world editor's authoritative projection with
// the other legacy console settings. Keep editable pools and release values
// on the same projection as the corresponding catalog mutation handlers.
func (a *API) legacyAdminWorld(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	grounds, err := worldGrounds(c)
	if err != nil {
		failure(w, err)
		return
	}
	view := worldView(c, grounds)
	for key, value := range map[string]any{
		"notifyLevel": "all",
		"notifyLevels": map[string]string{
			"all": "全部渔获", "uncommon": "大鱼、稀有鱼与组件", "offrange": "超出基准体型",
			"records": "破纪录", "none": "关闭全服渔获动态",
		},
		"groundCatalog":  legacyAdminGroundCatalog(c),
		"quality":        legacyConstantMap(c, "QUALITY"),
		"castCfg":        legacyCastConfig(c),
		"dropCfg":        legacyDropConfig(c),
		"rareKDefault":   2,
		"removedGrounds": []string{},
		"removedSpots":   []string{},
		"smeltCfg":       legacyDefaultObject(c, "smelt"),
		"smeltDefaults":  worldDefaults("smelt"),
		"mallCfg":        legacyDefaultObject(c, "mall"),
		"mallDefaults":   worldDefaults("mall"),
		"ship":           legacyConstantMap(c, "SHIP"),
		"sea":            c.SeaConfig(),
	} {
		view[key] = value
	}
	stored, _ := a.legacyStoredConfig(r.Context())
	seaConfig := legacyConstantMap(c, "SEA")
	seaConfig["zoneTtlMin"] = c.SeaConfig().ZoneTTL / 60000
	view["sea"] = seaConfig
	applyLegacyStoredConfig(view, stored)
	// Older saved levels have identical feed semantics; select the matching
	// current option instead of leaving the editor with no selected level.
	switch view["notifyLevel"] {
	case "rare":
		view["notifyLevel"] = "uncommon"
	case "off":
		view["notifyLevel"] = "none"
	}
	economyView, err := a.legacyEconomyConsole(r.Context(), c)
	if err != nil {
		failure(w, err)
		return
	}
	for key, value := range economyView {
		view[key] = value
	}
	fields, _, err := legacyCatalogProjection(c)
	if err != nil {
		failure(w, err)
		return
	}
	for key, value := range fields {
		if _, exists := view[key]; !exists {
			view[key] = value
		}
	}
	write(w, http.StatusOK, view)
}

func legacyConstantMap(c *rules.Catalog, key string) map[string]any {
	out := map[string]any{}
	if err := c.Constant(key, &out); err != nil {
		return map[string]any{}
	}
	return out
}

func legacyDefaultObject(c *rules.Catalog, key string) any {
	var out any
	if err := json.Unmarshal(c.Defaults[key], &out); err != nil {
		return map[string]any{}
	}
	return out
}

func legacyCastConfig(c *rules.Catalog) map[string]any {
	cast := c.CastRules(nil)
	return map[string]any{"baseMs": cast.BaseMS, "minMs": cast.MinMS, "speedBonus": cast.SpeedBonus, "speedCap": cast.SpeedCap, "formula": cast.Formula}
}

func legacyDropConfig(c *rules.Catalog) map[string]any {
	drop := c.DefaultLootConfig()
	return map[string]any{"global": drop.Global, "common": drop.Common, "big": drop.Big, "rare": drop.Rare, "material": drop.Material}
}
