package rules

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

type Weight struct {
	Key   string
	Value float64
}
type OrderedWeights []Weight

func (w *OrderedWeights) UnmarshalJSON(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	tok, err := d.Token()
	if err != nil {
		return err
	}
	if tok == nil {
		return nil
	}
	if tok != json.Delim('{') {
		return fmt.Errorf("weights must be an object")
	}
	*w = nil
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return err
		}
		var v any
		if err := d.Decode(&v); err != nil {
			return err
		}
		*w = append(*w, Weight{key.(string), orZero(v)})
	}
	_, err = d.Token()
	return err
}

type ComponentConfig struct {
	QualityWeights   OrderedWeights                  `json:"qualityWeights"`
	CountWeights     map[string][]float64            `json:"countWeights"`
	RollModel        string                          `json:"rollModel"`
	AffixRanges      map[string]map[string][]float64 `json:"affixRanges"`
	ExtraAffixRanges map[string][]float64            `json:"extraAffixRanges"`
}
type GenerateOptions struct {
	CountWeights []float64 `json:"countWeights"`
	MinAffixes   int       `json:"minAffixes"`
	ForceMax     bool      `json:"forceMax"`
}
type BreakthroughOptions struct {
	HitCount  *int     `json:"hitCount"`
	MissCount *int     `json:"missCount"`
	Chance    *float64 `json:"chance"`
}

func (c *Catalog) ComponentConfig() ComponentConfig {
	var cfg ComponentConfig
	_ = json.Unmarshal(c.Defaults["component"], &cfg)
	return cfg
}
func qualityCap(q string) int {
	switch q {
	case "rare":
		return 2
	case "epic":
		return 3
	case "mythic":
		return 4
	default:
		return 1
	}
}
func validQuality(q string) bool { return q == "common" || q == "rare" || q == "epic" || q == "mythic" }
func rangeOK(r []float64) bool   { return len(r) == 2 && finite(r[0]) && finite(r[1]) && r[1] >= r[0] }
func (cfg ComponentConfig) Range(base string, a AffixRange) (float64, float64) {
	if r := cfg.AffixRanges[base][a.Type]; rangeOK(r) {
		return r[0], r[1]
	}
	return a.Min, a.Max
}
func (c *Catalog) ExtraRange(cfg ComponentConfig, kind string) (float64, float64) {
	if r := cfg.ExtraAffixRanges[kind]; rangeOK(r) {
		return r[0], r[1]
	}
	var m map[string][]float64
	_ = c.Constant("DEFAULT_EXTRA_AFFIX_RANGES", &m)
	if r := m[kind]; rangeOK(r) {
		return r[0], r[1]
	}
	return 1, 3
}
func weightedKey(weights OrderedWeights, fallback string, rng RNG) string {
	w := make([]float64, len(weights))
	for i, v := range weights {
		w[i] = v.Value
	}
	i := WeightedIndex(w, true, rng)
	if i < 0 {
		return fallback
	}
	return weights[i].Key
}
func (cfg ComponentConfig) Quality(rng RNG) string {
	return weightedKey(cfg.QualityWeights, "common", rng)
}
func affixCount(quality string, upper int, cfg ComponentConfig, o GenerateOptions, rng RNG) int {
	if o.ForceMax {
		return upper
	}
	w := o.CountWeights
	if len(w) == 0 {
		w = cfg.CountWeights[quality]
	}
	n := 0
	if len(w) > 0 {
		weights := make([]float64, upper)
		copy(weights, w)
		n = WeightedIndex(weights, true, rng) + 1
	}
	if n == 0 {
		n = 1 + int(math.Floor(rng()*float64(max(1, upper))))
	}
	return min(upper, max(n, max(1, min(o.MinAffixes, upper))))
}
func (c *Catalog) Generate(baseID, quality string, cfg ComponentConfig, o GenerateOptions, rng RNG) (string, bool) {
	base, ok := c.Item(baseID)
	if !ok || base.Part == "" || base.Kind != "component" {
		return "", false
	}
	if !validQuality(quality) {
		quality = "common"
	}
	n := affixCount(quality, min(len(base.Pool), qualityCap(quality)), cfg, o, rng)
	indices := make([]int, len(base.Pool))
	for i := range indices {
		indices[i] = i
	}
	for i := len(indices) - 1; i > 0; i-- {
		j := int(rng() * float64(i+1))
		indices[i], indices[j] = indices[j], indices[i]
	}
	indices = indices[:n]
	sort.Ints(indices)
	affixes := []Affix{}
	for _, i := range indices {
		a := base.Pool[i]
		lo, hi := cfg.Range(baseID, a)
		affixes = append(affixes, Affix{Type: a.Type, Value: RollAffix(lo, hi, cfg.RollModel, rng)})
	}
	return InstanceID(base, quality, affixes), true
}
func (c *Catalog) Breakthrough(baseID string, cfg ComponentConfig, o BreakthroughOptions, rng RNG) (string, bool) {
	base, ok := c.Item(baseID)
	if !ok || base.Part == "" || base.Kind != "component" {
		return "", false
	}
	hit, miss, chance := 4, 3, .5
	if o.HitCount != nil {
		hit = *o.HitCount
	}
	if o.MissCount != nil {
		miss = *o.MissCount
	}
	if o.Chance != nil {
		chance = *o.Chance
	}
	target := miss
	if len(base.Pool) >= hit || rng() < chance {
		target = hit
	}
	target = max(len(base.Pool), min(4, target))
	aa := []Affix{}
	used := map[string]bool{}
	for _, a := range base.Pool {
		lo, hi := cfg.Range(baseID, a)
		aa = append(aa, Affix{Type: a.Type, Value: RollBoundary(lo, hi, cfg.RollModel, rng)})
		used[a.Type] = true
	}
	if need := target - len(aa); need > 0 {
		var types []string
		_ = c.Constant("AFFIX_TYPES", &types)
		candidates := []string{}
		for _, k := range types {
			if !used[k] && (base.Legacy || c.AffixAllowed(base.Part, k)) {
				candidates = append(candidates, k)
			}
		}
		for i := len(candidates) - 1; i > 0; i-- {
			j := int(rng() * float64(i+1))
			candidates[i], candidates[j] = candidates[j], candidates[i]
		}
		for _, k := range candidates[:min(need, len(candidates))] {
			lo, hi := c.ExtraRange(cfg, k)
			aa = append(aa, Affix{Type: k, Value: RollBoundary(lo, hi, cfg.RollModel, rng), Source: "bt", Explicit: true})
		}
	}
	return InstanceID(base, "mythic", aa), true
}
func (c *Catalog) RollComponent(selector string, cfg ComponentConfig, rng RNG) (string, bool) {
	// Catalog item order preserves COMPONENT_BASES order.
	choices := []Item{}
	for _, b := range c.Items {
		if b.Kind == "component" && !b.Legacy && b.SetID == "" && b.Part != "" && (selector == "" || selector == "part/"+b.Part || selector == "base/"+b.ID) {
			choices = append(choices, b)
		}
	}
	if len(choices) == 0 {
		return "", false
	}
	base := choices[int(rng()*float64(len(choices)))]
	return c.Generate(base.ID, cfg.Quality(rng), cfg, GenerateOptions{}, rng)
}
func InstanceID(base Item, quality string, affixes []Affix) string {
	aa := append([]Affix(nil), affixes...)
	order := map[string]int{}
	for i, a := range base.Pool {
		order[a.Type] = i
	}
	rank := func(s string) int {
		if n, ok := order[s]; ok {
			return n
		}
		return 99
	}
	sort.SliceStable(aa, func(i, j int) bool {
		a, b := rank(aa[i].Type), rank(aa[j].Type)
		if a == b {
			return aa[i].Type < aa[j].Type
		}
		return a < b
	})
	tokens := []string{}
	codes := map[string]string{"speed": "spd", "skill": "skl", "rare": "rare", "material": "mat", "size": "size", "double": "dbl", "stability": "stb", "resonance": "res", "settle": "stl"}
	for _, a := range aa {
		sign := ""
		if a.Value >= 0 {
			sign = "+"
		}
		token := codes[a.Type] + sign + strconv.FormatFloat(a.Value, 'f', -1, 64)
		if a.Explicit && a.Source != "" && a.Source != base.ID {
			token += "@" + a.Source
		}
		tokens = append(tokens, token)
	}
	return base.ID + "#" + quality + "#" + strings.Join(tokens, ",")
}
