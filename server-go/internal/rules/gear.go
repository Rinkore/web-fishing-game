package rules

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

type GearCost struct {
	Coins    int64            `json:"coins"`
	Items    map[string]int64 `json:"items"`
	Receipts int64            `json:"receipts"`
	Heat     int              `json:"heat"`
	Cores    int              `json:"cores"`
}
type GearPart struct {
	Name       string    `json:"name"`
	Main       string    `json:"main"`
	Subs       []string  `json:"subs"`
	MainValues []float64 `json:"mainValues"`
	SubValues  []float64 `json:"subValues"`
}
type GearAbility struct {
	Name           string                        `json:"name"`
	Description    string                        `json:"description"`
	CoreAttributes map[string]map[string]float64 `json:"coreAttributes,omitempty"`
	Stages         []map[string]float64          `json:"stages"`
}
type GearCosts struct {
	Upgrade     []GearCost `json:"upgrade"`
	Tune        GearCost   `json:"tune"`
	Engrave     GearCost   `json:"engrave"`
	HeatEngrave GearCost   `json:"heatEngrave"`
	Transfer    GearCost   `json:"transfer"`
	Convert     GearCost   `json:"convert"`
	Preset      GearCost   `json:"preset"`
	Unlock      GearCost   `json:"unlock"`
	Stage       []GearCost `json:"stage"`
}
type GearConfig struct {
	Enabled               bool                          `json:"enabled"`
	MaxLevel              int                           `json:"maxLevel"`
	SubUnlock             int                           `json:"subUnlock"`
	BoundLevel            int                           `json:"boundLevel"`
	ReceiptHours          int                           `json:"receiptHours"`
	EngraveLevel          int                           `json:"engraveLevel"`
	MainEngrave           float64                       `json:"mainEngrave"`
	SubEngrave            float64                       `json:"subEngrave"`
	Parts                 map[string]GearPart           `json:"parts"`
	Costs                 GearCosts                     `json:"costs"`
	Sets                  map[string]GearAbility        `json:"sets"`
	Specializations       map[string]GearAbility        `json:"specializations"`
	FishPity              map[string]int                `json:"fishPity"`
	ExcludedFish          []string                      `json:"excludedFish"`
	BaseDrops             map[string]map[string]float64 `json:"baseDrops"`
	LegacyConvertReceipts map[string]int64              `json:"legacyConvertReceipts"`
}

func (c *Catalog) GearConfig() GearConfig {
	var v GearConfig
	_ = c.Constant("GEAR_SYSTEM", &v)
	return v
}
func (g GearAbility) Effect(stage int) map[string]float64 {
	if len(g.Stages) == 0 {
		return map[string]float64{}
	}
	return g.Stages[min(max(0, stage), len(g.Stages)-1)]
}

type GearGrowth struct {
	Level   int    `json:"level"`
	Engrave string `json:"engrave"`
	Presets int    `json:"presets"`
}

var growthToken = regexp.MustCompile(`@g([0-9]+)_(none|main|sub)_([0-3])(?:,|$)`)

func Growth(signature string) (GearGrowth, bool) {
	m := growthToken.FindStringSubmatch(signature)
	if m == nil {
		return GearGrowth{}, false
	}
	n, _ := strconv.Atoi(m[1])
	p, _ := strconv.Atoi(m[3])
	return GearGrowth{n, m[2], p}, true
}
func (c *Catalog) GearSignature(baseID string, level int, sub, engrave string, presets int) (string, error) {
	b, ok := c.Item(baseID)
	cfg := c.GearConfig()
	p, exists := cfg.Parts[b.Part]
	if !ok || !exists || b.SetID != "" || level < 0 || level > cfg.MaxLevel || level >= len(p.MainValues) || level >= len(p.SubValues) || (engrave != "none" && engrave != "main" && engrave != "sub") || presets < 0 || presets > 3 {
		return "", errors.New("invalid_gear")
	}
	if level >= cfg.SubUnlock {
		valid := false
		for _, s := range p.Subs {
			valid = valid || s == sub
		}
		if !valid {
			return "", errors.New("choose_secondary")
		}
	}
	mainValue := p.MainValues[level]
	subValue := p.SubValues[level]
	if engrave == "main" {
		mainValue *= 1 + cfg.MainEngrave
	}
	if engrave == "sub" {
		subValue *= 1 + cfg.SubEngrave
	}
	aa := []Affix{{Type: p.Main, Value: math.Round(mainValue*100) / 100, Source: fmt.Sprintf("g%d_%s_%d", level, engrave, presets), Explicit: true}}
	if level >= cfg.SubUnlock {
		aa = append(aa, Affix{Type: sub, Value: math.Round(subValue*100) / 100})
	}
	return InstanceID(b, "common", aa), nil
}
func (c *Catalog) GearAffixes(signature string, base Item, existing []Affix) []Affix {
	cfg := c.GearConfig()
	if !cfg.Enabled {
		return existing
	}
	if set, ok := cfg.Sets[base.SetID]; ok {
		aa := []Affix{}
		for _, t := range []string{"speed", "skill", "double", "size"} {
			if v, ok := set.CoreAttributes[base.Part][t]; ok {
				aa = append(aa, Affix{Type: t, Value: v})
			}
		}
		return aa
	}
	g, ok := Growth(signature)
	if !ok {
		return existing
	}
	p, ok := cfg.Parts[base.Part]
	if !ok {
		return existing
	}
	sub := ""
	for _, a := range existing {
		if a.Type != p.Main {
			sub = a.Type
		}
	}
	sig, err := c.GearSignature(base.ID, min(g.Level, cfg.MaxLevel), sub, g.Engrave, g.Presets)
	if err != nil {
		return existing
	}
	_, _, aa, ok := c.Instance(sig)
	if !ok {
		return existing
	}
	return aa
}
func (c *Catalog) ValidateGear() error {
	g := c.GearConfig()
	if !g.Enabled {
		return nil
	}
	bad := errors.New("装备配置无效：检查属性、成长数组、材料、阶段效果与消耗上限")
	if g.MaxLevel < 1 || g.MaxLevel > 100 || g.SubUnlock < 1 || g.SubUnlock > g.MaxLevel || g.BoundLevel < 1 || g.BoundLevel > g.MaxLevel || g.EngraveLevel < g.SubUnlock || g.EngraveLevel > g.MaxLevel || g.ReceiptHours < 1 || g.ReceiptHours > 168 || !finite(g.MainEngrave) || g.MainEngrave < 0 || g.MainEngrave > 1 || !finite(g.SubEngrave) || g.SubEngrave < 0 || g.SubEngrave > 1 {
		return bad
	}
	validAttr := func(k string) bool { return k == "speed" || k == "skill" || k == "double" || k == "size" }
	if len(g.Parts) != 5 || len(g.Sets) != 4 || len(g.Specializations) != 4 || len(g.Costs.Upgrade) != g.MaxLevel || len(g.Costs.Stage) != 3 {
		return bad
	}
	for _, part := range []string{"line", "hook", "bait", "reel", "accessory"} {
		p, ok := g.Parts[part]
		if !ok || !validAttr(p.Main) || len(p.Subs) < 1 || len(p.Subs) > 3 || len(p.MainValues) != g.MaxLevel+1 || len(p.SubValues) != g.MaxLevel+1 {
			return bad
		}
		seen := map[string]bool{p.Main: true}
		for _, s := range p.Subs {
			if !validAttr(s) || seen[s] {
				return bad
			}
			seen[s] = true
		}
		for _, values := range [][]float64{p.MainValues, p.SubValues} {
			for i, v := range values {
				if !finite(v) || v < 0 || v > 1000 || (i > 0 && v < values[i-1]) {
					return bad
				}
			}
		}
	}
	costs := append([]GearCost{}, g.Costs.Upgrade...)
	costs = append(costs, g.Costs.Stage...)
	costs = append(costs, g.Costs.Tune, g.Costs.Engrave, g.Costs.HeatEngrave, g.Costs.Transfer, g.Costs.Convert, g.Costs.Preset, g.Costs.Unlock)
	for _, v := range costs {
		if v.Coins < 0 || v.Coins > 1000000000 || v.Receipts < 0 || v.Receipts > 10000 || v.Heat < 0 || v.Heat > 10000 || v.Cores < 0 || v.Cores > 100 {
			return bad
		}
		for id, n := range v.Items {
			it, ok := c.Item(id)
			if !ok || it.Kind != "material" || n < 1 || n > 1000000 {
				return bad
			}
		}
	}
	def, _ := Default()
	base := def.GearConfig()
	for _, pair := range [][2]map[string]GearAbility{{g.Sets, base.Sets}, {g.Specializations, base.Specializations}} {
		for id, b := range pair[1] {
			v, ok := pair[0][id]
			if !ok || len(v.Name) == 0 || len([]rune(v.Name)) > 40 || len(v.Stages) != 4 {
				return bad
			}
			for i, stage := range v.Stages {
				if len(stage) != len(b.Stages[i]) {
					return bad
				}
				for k, orig := range b.Stages[i] {
					x, ok := stage[k]
					if !ok || !finite(x) || x < 0 || x > 100000 {
						return bad
					}
					_ = orig
					switch k {
					case "presets", "best", "largeMode", "queue", "highChest", "choice", "priority", "advanced", "evacuate":
						if x != 0 && x != 1 {
							return bad
						}
					case "copies":
						if x < 1 || x > 20 || math.Trunc(x) != x {
							return bad
						}
					case "deepRisk":
						if x > 100 {
							return bad
						}
					case "uniformMix":
						if x > .15 {
							return bad
						}
					case "retain", "bonus", "focus", "concentrate", "deepBonus", "chestChancePerHour", "evacuationLoss":
						if x > 1 {
							return bad
						}
					case "heatSeconds", "casts", "pityCommon", "pityRare", "pityEpic", "largeMultiplier", "recent":
						if x < 1 || math.Trunc(x) != x {
							return bad
						}
					case "heatCap":
						if x < 1 || x > 10000 || math.Trunc(x) != x {
							return bad
						}
					case "pityFactor":
						if x <= 0 || x > 1 {
							return bad
						}
					case "minRouteLevel":
						if x < 1 || x > 5 || math.Trunc(x) != x {
							return bad
						}
					}
				}
			}
			if _, isFishing := g.Sets[id]; isFishing {
				if len(v.CoreAttributes) != 2 {
					return bad
				}
				for _, part := range []string{"rod", "charm"} {
					attrs := v.CoreAttributes[part]
					if len(attrs) < 1 || len(attrs) > 4 {
						return bad
					}
					for k, x := range attrs {
						if !validAttr(k) || !finite(x) || x < 0 || x > 1000 {
							return bad
						}
					}
				}
			}
		}
	}
	for fish, n := range g.FishPity {
		it, ok := c.Item(fish)
		if !ok || it.Kind != "fish" || n < 1 || n > 100000 {
			return bad
		}
	}
	for _, id := range g.ExcludedFish {
		it, ok := c.Item(id)
		if !ok || it.Kind != "fish" {
			return bad
		}
	}
	routes := map[string]bool{}
	for _, r := range c.ExpeditionConfig().Routes {
		routes[r.ID] = true
	}
	for route, items := range g.BaseDrops {
		if !routes[route] {
			return bad
		}
		for id, n := range items {
			it, ok := c.Item(id)
			if !ok || it.Kind != "material" || !finite(n) || n < 0 || n > 10000 {
				return bad
			}
		}
	}
	for q, n := range g.LegacyConvertReceipts {
		if !validQuality(q) || n < 0 || n > 100 {
			return bad
		}
	}
	return nil
}
func (c *Catalog) GearCoreSignature(setID, part string) (string, bool) {
	b, ok := c.Item("set_" + setID + "_" + part)
	if !ok {
		return "", false
	}
	s, ok := c.GearConfig().Sets[setID]
	if !ok {
		return "", false
	}
	aa := []Affix{}
	for _, k := range []string{"speed", "skill", "size", "double"} {
		if v, ok := s.CoreAttributes[part][k]; ok {
			aa = append(aa, Affix{Type: k, Value: v})
		}
	}
	return InstanceID(b, "epic", aa), true
}
func (c *Catalog) GearExcluded(id string) bool {
	for _, v := range c.GearConfig().ExcludedFish {
		if v == id {
			return true
		}
	}
	return strings.HasPrefix(id, "unique_")
}
func (g GearConfig) Raw() json.RawMessage { b, _ := json.Marshal(g); return b }
