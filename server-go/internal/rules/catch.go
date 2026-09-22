package rules

import (
	"encoding/json"
	"strings"
)

type Ground struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Type   string        `json:"type"`
	Locked bool          `json:"locked"`
	Spots  []FishingSpot `json:"spots"`
}
type FishingSpot struct {
	Spot
	Map     string      `json:"map"`
	MinShip int         `json:"minShip"`
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Locked  bool        `json:"locked"`
	Pool    []LootEntry `json:"pool"`
}
type Catch struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	CodexID string   `json:"codexId"`
	Tier    string   `json:"tier"`
	Size    *float64 `json:"size"`
}

func (c *Catalog) Grounds() []Ground {
	var g []Ground
	_ = c.Constant("GROUNDS", &g)
	return g
}
func (c *Catalog) FishingSpot(ground, spot string) (Ground, FishingSpot, bool) {
	for _, g := range c.Grounds() {
		if g.ID == ground {
			for _, s := range g.Spots {
				if s.ID == spot {
					return g, s, true
				}
			}
		}
	}
	return Ground{}, FishingSpot{}, false
}
func (c *Catalog) SizeTier(id string, size float64) string {
	it, ok := c.Item(id)
	if !ok || len(it.Size) != 2 || size <= 0 {
		return "normal"
	}
	if size > it.Size[1]*1.8 {
		return "giant"
	}
	if size > it.Size[1] {
		return "large"
	}
	return "normal"
}

// ResolveCatch consumes a pre-boosted pool, preserving the legacy draw order.
func (c *Catalog) ResolveCatch(pool []LootEntry, eff Effects, rng RNG) (Catch, bool) {
	pick := PickLoot(pool, rng)
	kind, id, ok := strings.Cut(pick, ":")
	if !ok {
		return Catch{}, false
	}
	if kind == "component" {
		signature, ok := c.RollComponent(id, c.ComponentConfig(), rng)
		if !ok {
			return Catch{}, false
		}
		base, _, _, ok := c.Instance(signature)
		return Catch{ID: signature, Kind: kind, CodexID: base.ID, Tier: "normal"}, ok
	}
	it, ok := c.Item(id)
	if !ok || it.Kind != kind || (kind != "fish" && kind != "material") {
		return Catch{}, false
	}
	v := Catch{ID: id, Kind: kind, CodexID: id, Tier: "normal"}
	if kind == "fish" && len(it.Size) == 2 {
		var cfg struct {
			Model   string    `json:"sizeModel"`
			Weights []float64 `json:"sizeWeights"`
		}
		_ = json.Unmarshal(c.Defaults["fish"], &cfg)
		size := FishSize(it.Size, eff["size"], cfg.Model, cfg.Weights, rng)
		v.Size = &size
		v.Tier = c.SizeTier(id, size)
	}
	return v, true
}
