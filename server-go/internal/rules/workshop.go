package rules

import (
	"encoding/json"
	"errors"
	"math"
)

type WorkshopConfig struct {
	BaseRate             float64                         `json:"baseRate"`
	FailPerMaterial      float64                         `json:"failPerMaterial"`
	ExtraRatePerMaterial float64                         `json:"extraRatePerMaterial"`
	ExtraRatePearl       float64                         `json:"extraRatePearl"`
	ExtraRateMax         float64                         `json:"extraRateMax"`
	RateMin              float64                         `json:"rateMin"`
	RateMax              float64                         `json:"rateMax"`
	GoldBase             float64                         `json:"goldBase"`
	GoldPerMaterial      float64                         `json:"goldPerMaterial"`
	GoldPearl            float64                         `json:"goldPearl"`
	MaxMaterials         int                             `json:"maxMaterials"`
	MaxTypes             int                             `json:"maxTypes"`
	PearlRollTwice       bool                            `json:"pearlRollTwice"`
	RecastPearl          int                             `json:"recastPearl"`
	RecastGold           float64                         `json:"recastGold"`
	RecastMinValue       int                             `json:"recastMinValue"`
	RetainFormula        string                          `json:"retainFormula"`
	RetainMaxRelic       int                             `json:"retainMaxRelic"`
	SubRangeFromSub      bool                            `json:"subRangeFromSub"`
	AddAnyAffix          bool                            `json:"addAnyAffix"`
	AddAffixCap          int                             `json:"addAffixCap"`
	AddAffixExtraRange   bool                            `json:"addAffixExtraRange"`
	CatalystRanges       map[string]map[string][]float64 `json:"catalystRanges"`
	CatalystRatio        float64                         `json:"catalystRatio"`
	ForgeAnyAffix        bool                            `json:"forgeAnyAffix"`
}

func (c *Catalog) WorkshopConfig() WorkshopConfig {
	var cfg WorkshopConfig
	_ = json.Unmarshal(c.Defaults["smelt"], &cfg)
	return cfg
}

type Material struct {
	ID       string `json:"id"`
	Quantity int64  `json:"qty"`
}

var materialOrder = []string{"lure", "bait_pack", "rope", "relic", "tide_sand", "dragon_scale"}
var materialAffix = map[string]string{"lure": "skill", "bait_pack": "rare", "rope": "size", "relic": "material", "tide_sand": "speed", "dragon_scale": "double"}

func MaterialAffix(id string) string { return materialAffix[id] }

// SmeltMaterialIDs mirrors data.js smeltMaterialIds(): the ordered catalyst
// materials the workshop UI lists, in the same order as the source constant.
func SmeltMaterialIDs() []string { return append([]string(nil), materialOrder...) }

// RetainPerRelic mirrors data.js retainChancePerRelic(breakthrough): the
// per-relic retention chance compiled from the operator formula.
func (w WorkshopConfig) RetainPerRelic(breakthrough int) float64 {
	compiled, err := Compile(w.RetainFormula, []string{"breakthrough"})
	if err != nil {
		compiled, _ = Compile("10 - breakthrough * 0.5", []string{"breakthrough"})
	}
	per := compiled.Eval(map[string]float64{"breakthrough": float64(breakthrough)})
	if !finite(per) {
		per = 0
	}
	return clamp(Round(per*10)/10, 0, 100)
}
func poolHas(base Item, kind string) bool {
	for _, a := range base.Pool {
		if a.Type == kind {
			return true
		}
	}
	return false
}
func (c *Catalog) PoolRange(cfg ComponentConfig, baseID, kind string) []float64 {
	base, ok := c.Item(baseID)
	if !ok {
		return nil
	}
	for _, a := range base.Pool {
		if a.Type == kind {
			lo, hi := cfg.Range(baseID, a)
			return []float64{lo, hi}
		}
	}
	return nil
}

// ResolveAffixSources retains whether provenance was explicit. Inference is
// used for range selection only and must never turn a legacy affix into @bt.
func (c *Catalog) ResolveAffixSources(base Item, affixes []Affix, cfg ComponentConfig) []Affix {
	aa := append([]Affix{}, affixes...)
	for i := range aa {
		a := &aa[i]
		if a.Source != "" {
			continue
		}
		own := c.PoolRange(cfg, base.ID, a.Type)
		if own == nil {
			a.Source = "bt"
			continue
		}
		a.Source = base.ID
		if a.Value >= own[0] && a.Value <= own[1] {
			continue
		}
		for _, other := range c.Items {
			if other.Part != base.Part || other.ID == base.ID {
				continue
			}
			r := c.PoolRange(cfg, other.ID, a.Type)
			if r != nil && a.Value >= r[0] && a.Value <= r[1] {
				a.Source = other.ID
				break
			}
		}
	}
	return aa
}
func ScaleCatalyst(r []float64, ratio float64) []float64 {
	mid := (r[0] + r[1]) / 2
	half := (r[1] - r[0]) * (ratio / 200)
	lo, hi := Round(mid-half), Round(mid+half)
	hi += Round(mid*2) - (lo + hi)
	if hi < lo {
		lo, hi = hi, lo
	}
	return []float64{lo, hi}
}
func (c *Catalog) CatalystEnvelope(cfg ComponentConfig, part, kind string) []float64 {
	var result []float64
	for _, b := range c.Items {
		if b.Part != part {
			continue
		}
		r := c.PoolRange(cfg, b.ID, kind)
		if r == nil {
			continue
		}
		if result == nil {
			result = r
		} else {
			result[0] = math.Min(result[0], r[0])
			result[1] = math.Max(result[1], r[1])
		}
	}
	return result
}
func (c *Catalog) CatalystRange(cfg ComponentConfig, w WorkshopConfig, part, kind string, full bool) []float64 {
	r := w.CatalystRanges[part][kind]
	if !rangeOK(r) {
		r = c.CatalystEnvelope(cfg, part, kind)
	}
	if r == nil {
		lo, hi := c.ExtraRange(cfg, kind)
		r = []float64{lo, hi}
	}
	if full {
		return append([]float64{}, r...)
	}
	return ScaleCatalyst(r, w.CatalystRatio)
}
func (c *Catalog) SourceRange(cfg ComponentConfig, w WorkshopConfig, src, kind, part string) []float64 {
	if src == "ct" || src == "ct_full" {
		return c.CatalystRange(cfg, w, part, kind, src == "ct_full")
	}
	if src != "bt" {
		if r := c.PoolRange(cfg, src, kind); r != nil {
			return r
		}
	}
	lo, hi := c.ExtraRange(cfg, kind)
	return []float64{lo, hi}
}

type SmeltRange struct {
	Values   []float64
	Source   string
	Explicit bool
}

func (c *Catalog) smeltRange(cfg ComponentConfig, w WorkshopConfig, main, sub Item, kind string, a Affix) SmeltRange {
	mainHas, subHas := poolHas(main, a.Type), poolHas(sub, a.Type)
	src := a.Source
	if src == "" {
		src = "bt"
		if kind == "sub" && subHas {
			src = sub.ID
		} else if kind != "sub" && mainHas {
			src = main.ID
		}
	}
	explicit := a.Source == "" || a.Explicit || (kind == "sub" && subHas && src == sub.ID) || (kind != "sub" && mainHas && src == main.ID)
	if kind == "sub" && !w.SubRangeFromSub {
		if mainHas {
			return SmeltRange{c.PoolRange(cfg, main.ID, a.Type), main.ID, true}
		}
		lo, hi := c.ExtraRange(cfg, a.Type)
		return SmeltRange{[]float64{lo, hi}, "bt", false}
	}
	return SmeltRange{c.SourceRange(cfg, w, src, a.Type, main.Part), src, explicit}
}

type SmeltInput struct {
	MainID    string     `json:"mainId"`
	SubID     string     `json:"subId"`
	MainAffix string     `json:"mainAffix"`
	SubAffix  string     `json:"subAffix"`
	Materials []Material `json:"materials"`
	Pearl     bool       `json:"pearl"`
	Relics    int64      `json:"relics"`
}
type SmeltPlan struct {
	Main, Sub                           Item
	Quality                             string
	MainAffixes, ExtraAffixes           []Affix
	MainAffix, SubAffix                 Affix
	MainRange, SubRange, AddRange       SmeltRange
	ExtraType                           string
	Consume                             []Material
	Gold, Rate, ExtraRate, RetainChance float64
	Boundary                            bool
	Relics                              int64
	Model                               string
}

var ErrWorkshop = errors.New("invalid workshop plan")

func (c *Catalog) SmeltPlan(in SmeltInput, cfg ComponentConfig, w WorkshopConfig) (SmeltPlan, error) {
	main, q, ma, ok := c.Instance(in.MainID)
	if !ok {
		return SmeltPlan{}, ErrWorkshop
	}
	sub, _, sa, ok := c.Instance(in.SubID)
	if !ok || main.Part != sub.Part || in.MainAffix == in.SubAffix {
		return SmeltPlan{}, ErrWorkshop
	}
	ma = c.ResolveAffixSources(main, ma, cfg)
	sa = c.ResolveAffixSources(sub, sa, cfg)
	find := func(aa []Affix, k string) Affix {
		for _, a := range aa {
			if a.Type == k {
				return a
			}
		}
		return Affix{}
	}
	mainAffix, subAffix := find(ma, in.MainAffix), find(sa, in.SubAffix)
	if mainAffix.Type == "" || subAffix.Type == "" {
		return SmeltPlan{}, ErrWorkshop
	}
	p := SmeltPlan{Main: main, Sub: sub, Quality: q, MainAffixes: ma, MainAffix: mainAffix, SubAffix: subAffix, Relics: in.Relics, Model: cfg.RollModel, Consume: []Material{}}
	byType := map[string]int64{}
	seen := map[string]bool{}
	total, pearlCount := int64(0), int64(0)
	pearl := in.Pearl
	for _, m := range in.Materials {
		if seen[m.ID] || m.Quantity < 1 || m.Quantity > 99 {
			return p, ErrWorkshop
		}
		seen[m.ID] = true
		if m.ID == "dragonpearl" {
			pearl = true
			pearlCount += m.Quantity
			continue
		}
		kind := materialAffix[m.ID]
		if kind == "" {
			return p, ErrWorkshop
		}
		total += m.Quantity
		byType[kind] += m.Quantity
		p.Consume = append(p.Consume, m)
	}
	if pearlCount > 1 || total > int64(w.MaxMaterials) || len(byType) > w.MaxTypes || in.Relics < 0 || in.Relics > int64(w.RetainMaxRelic) {
		return p, ErrWorkshop
	}
	if pearl {
		p.Consume = append(p.Consume, Material{"dragonpearl", 1})
	}
	bt := 0
	for _, a := range ma {
		if !poolHas(main, a.Type) {
			p.ExtraAffixes = append(p.ExtraAffixes, a)
			if a.Source == "bt" && a.Explicit {
				bt++
			}
		}
	}
	if in.Relics > 0 {
		if q != "mythic" || len(p.ExtraAffixes) == 0 {
			return p, ErrWorkshop
		}
		p.Consume = append(p.Consume, Material{"relic", in.Relics})
	}
	if total > 0 {
		best := int64(0)
		for _, id := range materialOrder {
			kind := materialAffix[id]
			if byType[kind] > best {
				best = byType[kind]
				p.ExtraType = kind
			}
		}
		if p.ExtraType == in.MainAffix || p.ExtraType == in.SubAffix || w.AddAffixCap < 3 || (!w.AddAnyAffix && !poolHas(main, p.ExtraType)) {
			return p, ErrWorkshop
		}
	}
	p.Rate = Round(math.Max(w.RateMin, math.Min(w.RateMax, w.BaseRate+w.FailPerMaterial*float64(total)))*10) / 10
	extra := w.ExtraRatePerMaterial * float64(total)
	gold := w.GoldBase + w.GoldPerMaterial*float64(total)
	if pearl {
		extra += w.ExtraRatePearl
		gold += w.GoldPearl
	}
	p.ExtraRate = Round(math.Max(0, math.Min(w.ExtraRateMax, extra))*10) / 10
	p.Gold = math.Max(0, Round(gold))
	p.Boundary = pearl && w.PearlRollTwice
	per := w.RetainPerRelic(bt)
	p.RetainChance = clamp(Round(float64(in.Relics)*per*10)/10, 0, 100)
	p.MainRange = c.smeltRange(cfg, w, main, sub, "main", mainAffix)
	p.SubRange = c.smeltRange(cfg, w, main, sub, "sub", subAffix)
	if p.ExtraType != "" {
		r := w.CatalystRanges[main.Part][p.ExtraType]
		if rangeOK(r) {
			p.AddRange = SmeltRange{ScaleCatalyst(r, w.CatalystRatio), "ct", true}
		} else if !w.AddAffixExtraRange && poolHas(main, p.ExtraType) {
			p.AddRange = SmeltRange{c.PoolRange(cfg, main.ID, p.ExtraType), main.ID, true}
		} else {
			lo, hi := c.ExtraRange(cfg, p.ExtraType)
			p.AddRange = SmeltRange{[]float64{lo, hi}, "ct", true}
		}
	}
	return p, nil
}

type SmeltOutcome struct {
	Success      bool    `json:"success"`
	ExtraOK      bool    `json:"extraOk"`
	RetainOK     bool    `json:"retainOk"`
	Retained     []Affix `json:"retained"`
	ProtectAffix bool    `json:"protectAffix"`
	RemovedAffix *string `json:"removedAffix"`
	ResultID     *string `json:"resultId"`
	MainAfterID  *string `json:"mainAfterId"`
}

func (p SmeltPlan) Roll(rng RNG) SmeltOutcome {
	out := SmeltOutcome{Success: rng()*100 < p.Rate, Retained: []Affix{}}
	aa := []Affix{}
	roll := func(kind string, r SmeltRange) Affix {
		v := 0.0
		if p.Boundary {
			v = RollBoundary(r.Values[0], r.Values[1], p.Model, rng)
		} else {
			v = RollAffix(r.Values[0], r.Values[1], p.Model, rng)
		}
		return Affix{kind, v, r.Source, r.Explicit}
	}
	if out.Success {
		aa = append(aa, roll(p.MainAffix.Type, p.MainRange), roll(p.SubAffix.Type, p.SubRange))
		if p.ExtraType != "" {
			out.ExtraOK = rng()*100 < p.ExtraRate
			if out.ExtraOK {
				aa = append(aa, roll(p.ExtraType, p.AddRange))
			}
		}
		if p.Relics > 0 {
			out.RetainOK = rng()*100 < p.RetainChance
			if out.RetainOK {
				have := map[string]bool{}
				for _, a := range aa {
					have[a.Type] = true
				}
				for _, a := range p.ExtraAffixes {
					if !have[a.Type] {
						have[a.Type] = true
						aa = append(aa, a)
						out.Retained = append(out.Retained, a)
					}
				}
			}
		}
		id := InstanceID(p.Main, p.Quality, aa)
		out.ResultID = &id
	} else {
		out.ProtectAffix = p.Relics > 0
		if !out.ProtectAffix {
			removed := p.MainAffix.Type
			out.RemovedAffix = &removed
		}
		for _, a := range p.MainAffixes {
			if out.ProtectAffix || a.Type != p.MainAffix.Type {
				aa = append(aa, a)
			}
		}
		id := InstanceID(p.Main, p.Quality, aa)
		out.MainAfterID = &id
	}
	return out
}
func (c *Catalog) Recast(id string, target int, cfg ComponentConfig, w WorkshopConfig, rng RNG) (string, int, float64, error) {
	base, q, aa, ok := c.Instance(id)
	if !ok || q != "mythic" || len(aa) == 0 || target >= len(aa) || target < -1 {
		return "", 0, 0, ErrWorkshop
	}
	aa = c.ResolveAffixSources(base, aa, cfg)
	for i, a := range aa {
		if target >= 0 && target != i {
			continue
		}
		r := c.SourceRange(cfg, w, a.Source, a.Type, base.Part)
		v := RollAffix(r[0], r[1], cfg.RollModel, rng)
		if w.RecastMinValue != 0 {
			v = math.Max(v, a.Value)
		}
		aa[i].Value = v
	}
	pearls := max(0, w.RecastPearl)
	if target >= 0 {
		pearls += target + 1
	}
	return InstanceID(base, q, aa), pearls, math.Max(0, Round(w.RecastGold*float64(pearls))), nil
}
