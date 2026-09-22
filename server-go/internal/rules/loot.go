package rules

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

type LootEntry struct {
	Pick   string      `json:"pick"`
	Weight float64     `json:"weight"`
	Items  []LootEntry `json:"items,omitempty"`
}
type LootConfig struct{ Global, Common, Big, Rare, Material, RareK, CommonComponentProbability float64 }

func (c *Catalog) DefaultLootConfig() LootConfig {
	cfg := c.ComponentConfig()
	total, common := 0.0, 0.0
	for _, w := range cfg.QualityWeights {
		v := math.Max(0, w.Value)
		total += v
		if w.Key == "common" {
			common = v
		}
	}
	p := 0.0
	if total > 0 {
		p = common / total
	}
	m, _ := c.Runtime["drop"].(map[string]any)
	return LootConfig{configNumber(m, "global", 100, 0, 10000), configNumber(m, "common", 100, 0, 10000), configNumber(m, "big", 100, 0, 10000), configNumber(m, "rare", 100, 0, 10000), configNumber(m, "material", 100, 0, 10000), configNumber(c.Runtime, "rareK", 2, 0, 100000), p}
}
func (c *Catalog) LootGroups() map[string][]LootEntry {
	groups := map[string][]LootEntry{}
	data, _ := json.Marshal(c.Runtime["lootGroups"])
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return groups
	}
	for id, value := range raw {
		var items []LootEntry
		if json.Unmarshal(value, &items) == nil {
			groups[id] = items
			continue
		}
		var wrapped struct {
			Items []LootEntry `json:"items"`
		}
		if json.Unmarshal(value, &wrapped) == nil && wrapped.Items != nil {
			groups[id] = wrapped.Items
		}
	}
	return groups
}
func (c *Catalog) FishTier(id string) string {
	return c.fishTiers[id]
}
func (c *Catalog) BoostPool(pool []LootEntry, groups map[string][]LootEntry, eff Effects, cfg LootConfig) ([]LootEntry, error) {
	return c.boost(pool, groups, eff, cfg, map[string]bool{}, 0)
}
func (c *Catalog) boost(pool []LootEntry, groups map[string][]LootEntry, eff Effects, cfg LootConfig, path map[string]bool, depth int) ([]LootEntry, error) {
	if depth > 8 || len(pool) > 1024 {
		return nil, errors.New("loot complexity limit")
	}
	out := []LootEntry{}
	cm := RareCommonMultiplier(eff["rare"], cfg.RareK)
	for _, e := range pool {
		if e.Pick == "component" {
			e.Pick = "component:"
		}
		kind, id, ok := strings.Cut(e.Pick, ":")
		if !ok || !finite(e.Weight) || e.Weight < 0 {
			return nil, errors.New("invalid loot entry")
		}
		mult := cfg.Global / 100
		if kind == "group" {
			g, exists := groups[id]
			if !exists {
				continue
			}
			if path[id] {
				return nil, errors.New("recursive loot group")
			}
			path[id] = true
			items, err := c.boost(g, groups, eff, cfg, path, depth+1)
			if err != nil {
				return nil, err
			}
			zeroMaterial := Effects{}
			for k, v := range eff {
				zeroMaterial[k] = v
			}
			zeroMaterial["material"] = 0
			baseline, err := c.boost(g, groups, zeroMaterial, cfg, path, depth+1)
			delete(path, id)
			if err != nil {
				return nil, err
			}
			before, after := 0.0, 0.0
			for _, x := range baseline {
				before += x.Weight
			}
			for _, x := range items {
				after += x.Weight
			}
			mass := 0.0
			if before > 0 && after > 0 {
				mass = after / before
			}
			out = append(out, LootEntry{e.Pick, e.Weight * mult * mass, items})
			continue
		}
		switch kind {
		case "fish":
			switch c.FishTier(id) {
			case "big":
				mult *= cfg.Big / 100
			case "rare":
				mult *= cfg.Rare / 100 * (1 + eff["rare"]/100)
			default:
				mult *= cfg.Common / 100 * cm
			}
		case "material":
			mult *= cfg.Material / 100 * math.Max(0, 1+eff["material"]/100)
			if it, ok := c.Item(id); ok && it.Rarity == "common" {
				mult *= cm
			}
		case "component":
			mult *= cfg.CommonComponentProbability*cm + (1 - cfg.CommonComponentProbability)
		default:
			return nil, errors.New("unknown loot kind")
		}
		out = append(out, LootEntry{Pick: e.Pick, Weight: e.Weight * mult})
	}
	return out, nil
}
func PickLoot(pool []LootEntry, rng RNG) string {
	weights := make([]float64, len(pool))
	for i, e := range pool {
		weights[i] = e.Weight
	}
	i := WeightedIndex(weights, false, rng)
	if i < 0 {
		return ""
	}
	if pool[i].Items != nil {
		return PickLoot(pool[i].Items, rng)
	}
	return pool[i].Pick
}
