package gateway

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/rules"
)

// Each connection observes immutable publications. A failed load/projection
// never acknowledges the head, and a publication racing a load uses the
// revision returned WITH that load rather than the earlier wake-up revision.
type legacyConfigPush struct {
	api                              *API
	apply                            func(*rules.Catalog)
	catalogRevision, featureRevision int64
	catalogSeeded, featureSeeded     bool
	settingsDigest                   string
	settingsSeeded                   bool
	fields                           map[string]any
	frames                           []map[string]any
	pending                          []string
}

func (p *legacyConfigPush) init(ctx context.Context) map[string]any {
	p.pending = p.poll(ctx)
	return p.fields
}

func (p *legacyConfigPush) poll(ctx context.Context) []string {
	out := p.pending
	p.pending = nil
	var catalogID, featureID int64
	if err := p.api.pool.QueryRow(ctx, `SELECT COALESCE(c.release_id,0),COALESCE(f.release_id,0)
 FROM fishing.catalog_head c CROSS JOIN fishing.feature_head f WHERE c.singleton AND f.singleton`).Scan(&catalogID, &featureID); err != nil {
		return out
	}
	if p.fields == nil {
		p.fields = map[string]any{}
	}
	if !p.catalogSeeded || catalogID != p.catalogRevision {
		c, revision, err := catalog.Current(ctx, p.api.pool)
		if err == nil {
			fields, frames, err := legacyCatalogProjection(c)
			if err == nil {
				for i, frame := range frames {
					if !p.catalogSeeded || !reflect.DeepEqual(frame, p.frames[i]) {
						out = append(out, legacyFrame(frame))
					}
				}
				for k, v := range fields {
					p.fields[k] = v
				}
				if p.apply != nil {
					p.apply(c)
				}
				p.frames, p.catalogRevision, p.catalogSeeded = frames, revision, true
			}
		}
	}
	if !p.featureSeeded || featureID != p.featureRevision {
		f, err := operations.New(p.api.pool).Features(ctx)
		if err == nil {
			if p.fields == nil {
				p.fields = map[string]any{}
			}
			flags := legacyFeatureFlags(f.Flags)
			metadata := legacyFeatureMetadataRead(ctx, p.api)
			flags["adminBypass"] = metadata.AdminBypass
			order := legacyFeatureOrder(metadata)
			p.fields["features"], p.fields["featureOrder"] = flags, order
			out = append(out, legacyFrame(map[string]any{"type": "features", "features": flags, "featureOrder": order}))
			p.featureRevision, p.featureSeeded = f.Revision, true
		}
	}
	values, digest := p.api.legacyStoredConfig(ctx)
	if !p.settingsSeeded || digest != p.settingsDigest {
		if p.fields == nil {
			p.fields = map[string]any{}
		}
		applyLegacyStoredConfig(p.fields, values)
		for _, frame := range legacyStoredConfigFrames(values) {
			out = append(out, legacyFrame(frame))
		}
		p.settingsDigest, p.settingsSeeded = digest, true
	}
	return out
}

// Native flags gate actions; projecting them as legacy page flags (e.g. mall)
// would also hide unrelated actions, such as selling or the player market.
func legacyFeatureFlags(flags map[string]bool) map[string]bool {
	copyFlags := make(map[string]bool, len(flags)+11)
	for key, value := range flags {
		copyFlags[key] = value
	}
	flags = copyFlags
	// A fresh installation has no feature release yet. The legacy server
	// treated every native gate as enabled until an operator published the
	// first release, so preserve that default in every player projection.
	defaults := []string{"market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends", "sea", "party", "fishing"}
	for _, key := range defaults {
		if _, ok := flags[key]; !ok {
			flags[key] = true
		}
	}
	out := map[string]bool{}
	for native, legacy := range map[string][]string{
		"market": {"mall.list", "mall.marketbuy"}, "trade": {"ground.trade"},
		"chest": {"chest", "chest.craft", "chest.open"}, "mall": {"mall.buy"},
		"sell": {"mall.sell"}, "autosell": {"mall.autosell"},
		"sea": {"sea"}, "party": {"ground.party"}, "fishing": {"fishing.cast"},
	} {
		if enabled, ok := flags[native]; ok {
			for _, id := range legacy {
				out[id] = enabled
			}
		}
	}
	if enabled, ok := flags["sell"]; ok && !enabled {
		out["mall.autosell"] = false
	}
	for key, enabled := range flags {
		if key == "adminBypass" || key == "mail" || strings.Contains(key, ".") {
			out[key] = enabled
		}
	}
	return out
}

func legacyAdminFeatureFlags(flags map[string]bool) map[string]bool {
	out := map[string]bool{}
	// The admin editor needs every page and child present. Player projections
	// intentionally keep native group aliases out to avoid hiding unrelated
	// actions when one native gate is closed.
	for _, group := range legacyFeatureGroups {
		out[group["id"].(string)] = true
		for _, child := range group["children"].([]map[string]any) {
			out[child["id"].(string)] = true
		}
	}
	for key, value := range legacyFeatureFlags(flags) {
		out[key] = value
	}
	for native, root := range map[string]string{"fishing": "fishing", "sea": "sea"} {
		if enabled, ok := flags[native]; ok {
			out[root] = enabled
		}
	}
	if trade, ok := flags["trade"]; ok {
		if party, exists := flags["party"]; exists {
			out["ground"] = trade && party
		}
	}
	// 开箱自 v0.23.5 起是独立页面：工坊的开关不再受原生 chest 门控影响，
	// 两个入口在后台各自显示自己的发布状态（玩家投影同理，见 legacyFeatureFlags）。
	if workshop, ok := flags["workshop"]; ok {
		out["workshop"] = workshop
	}
	if mall, ok := flags["mall"]; ok {
		if sell, exists := flags["sell"]; exists {
			if market, marketExists := flags["market"]; marketExists {
				out["mall"] = mall && sell && market
			}
		}
	}
	for key, enabled := range flags {
		if key == "adminBypass" || strings.Contains(key, ".") {
			out[key] = enabled
			continue
		}
		switch key {
		case "bd", "character", "ground", "inventory", "codex", "records", "feedback", "logs", "wiki":
			out[key] = enabled
		}
	}
	return out
}

func legacyCatalogProjection(c *rules.Catalog) (map[string]any, []map[string]any, error) {
	grounds, err := legacyGroundCatalog(c)
	if err != nil {
		return nil, nil, err
	}
	cast := c.CastRules(nil)
	castCfg := map[string]any{"baseMs": cast.BaseMS, "minMs": cast.MinMS, "speedBonus": cast.SpeedBonus, "speedCap": cast.SpeedCap, "formula": cast.Formula}
	drop := c.DefaultLootConfig()
	dropCfg := map[string]any{"global": drop.Global, "common": drop.Common, "big": drop.Big, "rare": drop.Rare, "material": drop.Material}
	priceCfg := legacyEffectivePriceConfig(c)
	autoSellCfg := map[string]any{"batch": float64(100)}
	if batch, ok := c.Runtime["autoSellBatch"].(float64); ok && batch >= 1 && batch <= 10000 {
		autoSellCfg["batch"] = batch
	}
	chestCfg := map[string]any{"pityN": float64(0), "costs": map[string]any{}}
	if pity, ok := c.Runtime["chestPityN"].(float64); ok && pity >= 1 && pity <= 50 {
		chestCfg["pityN"] = pity
	}
	if costs, ok := chestCfg["costs"].(map[string]any); ok {
		var chests []rules.Chest
		if c.Constant("CHESTS", &chests) == nil {
			for _, chest := range chests {
				costs[chest.ID] = map[string]any{"costRelic": chest.CostRelic, "costCoins": chest.CostCoins}
			}
		}
	}
	// Keep the raw component object: OrderedWeights is a decoding helper, not
	// the JSON object shape expected by GameData.setComponentCfg.
	var component, mall any
	for _, entry := range []struct {
		name   string
		target *any
	}{{"component", &component}, {"mall", &mall}} {
		if err := json.Unmarshal(c.Defaults[entry.name], entry.target); err != nil {
			return nil, nil, err
		}
	}
	fields := map[string]any{"groundCfg": grounds, "componentCfg": component, "castCfg": castCfg, "dropCfg": dropCfg, "priceCfg": priceCfg, "autoSellCfg": autoSellCfg, "chestCfg": chestCfg}
	frames := []map[string]any{
		{"type": "componentcfg", "componentCfg": component},
		{"type": "castcfg", "baseMs": cast.BaseMS, "minMs": cast.MinMS, "speedBonus": cast.SpeedBonus, "speedCap": cast.SpeedCap, "formula": cast.Formula},
		{"type": "bitecfg", "formula": cast.BiteFormula},
		{"type": "groundcfg", "grounds": grounds},
		{"type": "pricecfg", "priceCfg": priceCfg, "dropCfg": dropCfg},
		{"type": "mallcfg", "mallCfg": mall},
		{"type": "autosellcfg", "autoSellCfg": autoSellCfg},
		{"type": "chestcfg", "chestCfg": chestCfg},
	}
	custom := []rules.Item{}
	for _, it := range c.Items {
		if len(it.ID) > 7 && it.ID[:7] == "custom_" {
			custom = append(custom, it)
		}
	}
	fields["gearConfig"] = c.GearConfig()
	frames = append(frames, map[string]any{"type": "gearcfg", "gearConfig": c.GearConfig()})
	fields["customItems"] = custom
	frames = append(frames, map[string]any{"type": "customitems", "items": custom})
	return fields, frames, nil
}

// Preserve display-only properties (position, description, etc.) while
// replacing each pool with the same zero-equipment distribution used by Node.
func legacyGroundCatalog(c *rules.Catalog) ([]map[string]any, error) {
	var grounds []map[string]any
	if err := json.Unmarshal(c.Constants["GROUNDS"], &grounds); err != nil {
		return nil, err
	}
	for _, g := range grounds {
		spots, _ := g["spots"].([]any)
		for _, value := range spots {
			s, ok := value.(map[string]any)
			if !ok {
				continue
			}
			raw, err := json.Marshal(s["pool"])
			if err != nil {
				return nil, err
			}
			var pool []rules.LootEntry
			if err := json.Unmarshal(raw, &pool); err != nil {
				return nil, err
			}
			boosted, err := c.BoostPool(pool, c.LootGroups(), rules.EmptyEffects(), c.DefaultLootConfig())
			if err != nil {
				return nil, err
			}
			s["pool"] = legacyFlattenPool(boosted)
		}
	}
	return grounds, nil
}

func legacyFlattenPool(pool []rules.LootEntry) []rules.LootEntry {
	out := []rules.LootEntry{}
	index := map[string]int{}
	var walk func([]rules.LootEntry, float64)
	walk = func(entries []rules.LootEntry, scale float64) {
		for _, e := range entries {
			if e.Weight <= 0 {
				continue
			}
			if e.Items != nil {
				total := 0.0
				for _, child := range e.Items {
					total += child.Weight
				}
				if total > 0 {
					walk(e.Items, scale*e.Weight/total)
				}
				continue
			}
			if i, ok := index[e.Pick]; ok {
				out[i].Weight += scale * e.Weight
			} else {
				index[e.Pick] = len(out)
				out = append(out, rules.LootEntry{Pick: e.Pick, Weight: scale * e.Weight})
			}
		}
	}
	walk(pool, 1)
	return out
}
