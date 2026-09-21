package gateway

import (
	"context"
	"encoding/json"
	"reflect"

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
			flags := legacyFeatureFlags(f.Flags)
			p.fields["features"], p.fields["featureOrder"] = flags, map[string]any{}
			out = append(out, legacyFrame(map[string]any{"type": "features", "features": flags, "featureOrder": map[string]any{}}))
			p.featureRevision, p.featureSeeded = f.Revision, true
		}
	}
	return out
}

// Native flags gate actions; projecting them as legacy page flags (e.g. mall)
// would also hide unrelated actions, such as selling or the player market.
func legacyFeatureFlags(flags map[string]bool) map[string]bool {
	out := map[string]bool{}
	for native, legacy := range map[string][]string{
		"market": {"mall.list", "mall.marketbuy"}, "trade": {"ground.trade"},
		"workshop": {"workshop.smelt", "workshop.recast", "workshop.forge"},
		"chest":    {"workshop.craft", "workshop.open"}, "mall": {"mall.buy"},
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
	// Keep the raw component object: OrderedWeights is a decoding helper, not
	// the JSON object shape expected by GameData.setComponentCfg.
	var component, smelt, mall any
	for _, entry := range []struct {
		name   string
		target *any
	}{{"component", &component}, {"smelt", &smelt}, {"mall", &mall}} {
		if err := json.Unmarshal(c.Defaults[entry.name], entry.target); err != nil {
			return nil, nil, err
		}
	}
	fields := map[string]any{"groundCfg": grounds, "componentCfg": component, "smeltCfg": smelt, "castCfg": castCfg, "dropCfg": dropCfg}
	frames := []map[string]any{
		{"type": "componentcfg", "componentCfg": component},
		{"type": "smeltcfg", "smeltCfg": smelt},
		{"type": "castcfg", "baseMs": cast.BaseMS, "minMs": cast.MinMS, "speedBonus": cast.SpeedBonus, "speedCap": cast.SpeedCap, "formula": cast.Formula},
		{"type": "bitecfg", "formula": cast.BiteFormula},
		{"type": "groundcfg", "grounds": grounds},
		{"type": "pricecfg", "dropCfg": dropCfg},
		{"type": "mallcfg", "mallCfg": mall},
	}
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
