package rules

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var SimulationVariables = []string{"speed", "skill", "big", "rare", "material", "size", "double", "interval"}

type Effects map[string]float64
type Buff struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}
type Spot struct {
	IntervalMS any    `json:"intervalMs"`
	BiteRate   any    `json:"biteRate"`
	Buffs      []Buff `json:"buffs"`
}
type CastRules struct {
	BaseMS, MinMS, SpeedBonus, SpeedCap float64
	Formula, BiteFormula                string
	cast, bite                          *Expression
}
type CastInfo struct {
	BaseMS       float64  `json:"baseMs"`
	MinMS        float64  `json:"minMs"`
	GlobalBonus  float64  `json:"globalBonus"`
	Cap          float64  `json:"cap"`
	AffixSpeed   float64  `json:"affixSpeed"`
	BuffSpeed    float64  `json:"buffSpeed"`
	RawSpeed     float64  `json:"rawSpeed"`
	EffSpeed     float64  `json:"effSpeed"`
	SpotMult     float64  `json:"spotMult"`
	Formula      string   `json:"formula"`
	IntervalMS   *float64 `json:"intervalMs"`
	Interval     float64  `json:"interval"`
	BiteRate     float64  `json:"biteRate"`
	BiteOverride bool     `json:"biteOverride"`
}

// Number accepts the JSON value domain used by legacy configuration. Missing
// properties are handled separately, because Number(undefined) != Number(null).
func Number(v any) float64 {
	switch n := v.(type) {
	case nil:
		return 0
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case json.Number:
		f, _ := n.Float64()
		return f
	case bool:
		if n {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return 0
		}
		if s == "Infinity" || s == "+Infinity" {
			return math.Inf(1)
		}
		if s == "-Infinity" {
			return math.Inf(-1)
		}
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") || strings.HasPrefix(s, "0b") || strings.HasPrefix(s, "0B") || strings.HasPrefix(s, "0o") || strings.HasPrefix(s, "0O") {
			x, err := strconv.ParseUint(s[2:], map[byte]int{'x': 16, 'X': 16, 'b': 2, 'B': 2, 'o': 8, 'O': 8}[s[1]], 64)
			if err == nil {
				return float64(x)
			}
			return math.NaN()
		}
		// Go also accepts Inf and hexadecimal floats; JavaScript Number does not.
		if !decimalNumber.MatchString(s) {
			return math.NaN()
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && !math.IsInf(f, 0) {
			return math.NaN()
		}
		return f
	case []any:
		if len(n) == 0 {
			return 0
		}
		if len(n) == 1 {
			if n[0] == nil {
				return 0
			}
			switch n[0].(type) {
			case string, float64, json.Number, []any:
				return Number(n[0])
			}
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

var decimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func orZero(v any) float64 {
	n := Number(v)
	if math.IsNaN(n) {
		return 0
	}
	return n
}
func configNumber(m map[string]any, k string, def, lo, hi float64) float64 {
	v, ok := m[k]
	if !ok {
		return def
	}
	n := Number(v)
	if !finite(n) || n < lo || n > hi {
		return def
	}
	return n
}
func jsString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case nil:
		return "null"
	case bool:
		if s {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(s, 'f', -1, 64)
	default:
		return "[object Object]"
	}
}
func (c *Catalog) CastRules(input map[string]any) CastRules {
	if input == nil {
		input = c.Runtime
	}
	var castDefault, biteDefault string
	_ = c.Constant("CAST_FORMULA_DEFAULT", &castDefault)
	_ = c.Constant("BITE_FORMULA_DEFAULT", &biteDefault)
	m, _ := input["cast"].(map[string]any)
	r := CastRules{BaseMS: configNumber(m, "baseMs", 10000, 200, 3600000), MinMS: configNumber(m, "minMs", 800, 100, 3600000), SpeedBonus: configNumber(m, "speedBonus", 0, -100, 500), SpeedCap: configNumber(m, "speedCap", 100, 0, 10000), Formula: castDefault, BiteFormula: biteDefault}
	if v := m["formula"]; v != nil {
		r.Formula = jsString(v)
	}
	if v := input["biteFormula"]; v != nil {
		r.BiteFormula = jsString(v)
	}
	r.cast, _ = Compile(r.Formula, SimulationVariables)
	r.bite, _ = Compile(r.BiteFormula, SimulationVariables)
	return r
}
func EmptyEffects() Effects {
	return Effects{"speed": 0, "skill": 0, "rare": 0, "material": 0, "size": 0, "double": 0, "stability": 0, "resonance": 0, "settle": 0}
}
func MergeEffects(rod Effects, spot Spot) (Effects, float64) {
	eff := EmptyEffects()
	for k := range eff {
		eff[k] = rod[k]
	}
	speed := 0.0
	for _, b := range spot.Buffs {
		if b.Type == "speed" {
			speed += orZero(b.Value)
		} else if _, ok := eff[b.Type]; ok {
			eff[b.Type] += orZero(b.Value)
		}
	}
	return eff, speed
}
func spotBite(spot Spot) *float64 {
	if spot.BiteRate == nil || spot.BiteRate == "" {
		return nil
	}
	n := Number(spot.BiteRate)
	if !finite(n) {
		return nil
	}
	n = clamp(n, 0, 100)
	return &n
}
func (r CastRules) Bite(eff Effects, interval float64, spot Spot) float64 {
	if n := spotBite(spot); n != nil {
		return *n
	}
	if r.bite == nil {
		return 100
	}
	vars := map[string]float64{"big": 0, "interval": interval}
	for _, k := range SimulationVariables {
		if k != "big" && k != "interval" {
			vars[k] = eff[k]
		}
	}
	p := r.bite.Eval(vars)
	if !finite(p) {
		if p > 0 {
			return 100
		}
		return 0
	}
	return clamp(p, 0, 100)
}
func (r CastRules) Info(rod Effects, spot Spot) CastInfo {
	eff, spotSpeed := MergeEffects(rod, spot)
	speed := clamp(eff["speed"]+r.SpeedBonus, 0, r.SpeedCap)
	mult := 1 - clamp(spotSpeed, -100, 95)/100
	base := r.BaseMS
	fixed := Number(spot.IntervalMS)
	if spot.IntervalMS != nil && spot.IntervalMS != "" && finite(fixed) && fixed >= 100 {
		base = fixed
	}
	vars := map[string]float64{"big": 0, "interval": base * mult}
	for k, v := range eff {
		vars[k] = v
	}
	vars["speed"] = speed
	ms := base * mult / (1 + speed/100)
	if r.cast != nil {
		if n := r.cast.Eval(vars); finite(n) && n > 0 {
			ms = n
		}
	}
	ms = math.Max(r.MinMS, math.Min(3600000, Round(ms)))
	bite := r.Bite(eff, ms, spot)
	override := spotBite(spot) != nil
	if !override {
		bite = Round(bite*10) / 10
	}
	var raw *float64
	if spot.IntervalMS != nil && spot.IntervalMS != "" {
		n := Round(fixed)
		if finite(n) {
			raw = &n
		}
	}
	return CastInfo{base, r.MinMS, r.SpeedBonus, r.SpeedCap, rod["speed"], spotSpeed, Round((eff["speed"]+r.SpeedBonus)*10) / 10, Round(speed*10) / 10, mult, r.Formula, raw, ms, bite, override}
}

// DoubleProbability is the per-edge probability. Legacy recursive catches
// apply it again to each successful child (confirmed compatibility behavior).
func DoubleProbability(a, base any) float64 {
	x := math.Max(0, orZero(a))
	p := x / (x + 100)
	b := clamp(orZero(base), 0, 1)
	if b > 0 {
		p = 1 - (1-b)*(1-p)
	}
	return clamp(p, 0, 1)
}
func RareCommonMultiplier(rare, k float64) float64 {
	if !finite(k) || k <= 0 {
		k = 2
	}
	if !finite(rare) || rare <= 0 {
		return 1
	}
	return math.Max(0, k/(k+rare))
}

var affixToken = regexp.MustCompile(`^(spd|skl|rare|mat|size|dbl|big|stb|res|stl)([+-]?[0-9]+(?:\.[0-9]+)?)(?:@([A-Za-z0-9_]+))?$`)
var codeType = map[string]string{"spd": "speed", "skl": "skill", "big": "skill", "rare": "rare", "mat": "material", "size": "size", "dbl": "double", "stb": "stability", "res": "resonance", "stl": "settle"}

type Affix struct {
	Type     string  `json:"type"`
	Value    float64 `json:"value"`
	Source   string  `json:"src,omitempty"`
	Explicit bool    `json:"srcExplicit"`
}

func (c *Catalog) Instance(id string) (Item, string, []Affix, bool) {
	parts := strings.Split(id, "#")
	if len(parts) != 3 {
		return Item{}, "", nil, false
	}
	it, ok := c.Item(parts[0])
	if !ok || it.Kind != "component" || it.Part == "" {
		return Item{}, "", nil, false
	}
	if parts[1] != "common" && parts[1] != "rare" && parts[1] != "epic" && parts[1] != "mythic" {
		return Item{}, "", nil, false
	}
	list := []Affix{}
	if parts[2] != "" {
		for _, t := range strings.Split(parts[2], ",") {
			m := affixToken.FindStringSubmatch(t)
			if m == nil {
				return Item{}, "", nil, false
			}
			v, _ := strconv.ParseFloat(m[2], 64)
			list = append(list, Affix{codeType[m[1]], v, m[3], m[3] != ""})
		}
	}
	return it, parts[1], list, true
}
func (c *Catalog) RodEffects(bd map[string]struct {
	CompID string `json:"compId"`
}) Effects {
	e := EmptyEffects()
	for _, part := range []string{"rod", "line", "hook", "bait", "reel", "accessory", "charm"} {
		base, _, aa, ok := c.Instance(bd[part].CompID)
		if ok {
			aa = c.GearAffixes(bd[part].CompID, base, aa)
			for _, a := range aa {
				e[a.Type] += a.Value
			}
		}
	}
	return e
}
