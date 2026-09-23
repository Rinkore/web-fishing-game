package rules

import (
	"encoding/json"
	"fmt"
	"math"
)

// QualityMeta mirrors data.js QUALITY entries used for component display.
type QualityMeta struct {
	Key  string  `json:"key"`
	Name string  `json:"name"`
	Cap  int     `json:"cap"`
	Mult float64 `json:"mult"`
	Cls  string  `json:"cls"`
}

// AdjectiveRule mirrors the ordered data.js adjective rules. The first match
// wins, and the trailing unconditional rule is the fallback display adjective.
type AdjectiveRule struct {
	Name     string   `json:"name"`
	Full     *bool    `json:"full"`
	NoNeg    *bool    `json:"noNeg"`
	NetMin   *float64 `json:"netMin"`
	NetMax   *float64 `json:"netMax"`
	MinAffix *int     `json:"minAffixes"`
	MaxAffix *int     `json:"maxAffixes"`
}

var defaultAdjectiveRules = []AdjectiveRule{
	{Name: "完美的", Full: boolPtr(true), NoNeg: boolPtr(true)},
	{Name: "饱满的", Full: boolPtr(true)},
	{Name: "精良的", NoNeg: boolPtr(true)},
	{Name: "平衡的", NetMin: floatPtr(1)},
	{Name: "粗糙的"},
}

func boolPtr(v bool) *bool        { return &v }
func floatPtr(v float64) *float64 { return &v }
func intPtr(v int) *int           { return &v }

// AdjectiveRules returns the ordered display rules from the component
// configuration, falling back to the data.js defaults when unset.
func (c *Catalog) AdjectiveRules() []AdjectiveRule {
	var cfg struct {
		AdjectiveRules []AdjectiveRule `json:"adjectiveRules"`
	}
	_ = json.Unmarshal(c.Defaults["component"], &cfg)
	if len(cfg.AdjectiveRules) == 0 {
		return append([]AdjectiveRule(nil), defaultAdjectiveRules...)
	}
	return cfg.AdjectiveRules
}

// MetaAffix is the display form of a single affix, matching data.js instanceMeta.
type MetaAffix struct {
	Type        string  `json:"type"`
	Value       float64 `json:"value"`
	Extra       bool    `json:"extra"`
	Src         *string `json:"src"`
	SrcExplicit bool    `json:"srcExplicit"`
}

// ComponentMeta is the display metadata for one component instance signature.
type ComponentMeta struct {
	ID          string       `json:"id"`
	BaseID      string       `json:"baseId"`
	BaseName    string       `json:"baseName"`
	Part        string       `json:"part"`
	Quality     string       `json:"quality"`
	QualityName string       `json:"qualityName"`
	Rarity      string       `json:"rarity"`
	RarityName  string       `json:"rarityName"`
	Name        string       `json:"name"`
	Price       float64      `json:"price"`
	Affixes     []MetaAffix  `json:"affixes"`
	Pool        []AffixRange `json:"pool"`
	MaxAffixes  int          `json:"maxAffixes"`
	Full        bool         `json:"full"`
}

func (c *Catalog) qualities() map[string]QualityMeta {
	var q map[string]QualityMeta
	_ = c.Constant("QUALITY", &q)
	return q
}

// ComponentMeta resolves an instance signature into display metadata. It does
// not change any persisted state and is safe for read-only profile projection.
func (c *Catalog) ComponentMeta(signature string) (ComponentMeta, bool) {
	base, quality, affixes, ok := c.Instance(signature)
	if !ok {
		return ComponentMeta{}, false
	}
	affixes = c.GearAffixes(signature, base, affixes)
	q, ok := c.qualities()[quality]
	if !ok {
		q = QualityMeta{Key: quality, Name: quality, Cap: 1, Mult: 1}
	}
	poolTypes := map[string]bool{}
	for _, p := range base.Pool {
		poolTypes[p.Type] = true
	}
	poolLen := len(base.Pool)
	list := make([]MetaAffix, 0, len(affixes))
	net := 0.0
	noNeg := true
	for _, a := range affixes {
		net += a.Value
		if a.Value < 0 {
			noNeg = false
		}
		var src *string
		if a.Source != "" {
			v := a.Source
			src = &v
		}
		list = append(list, MetaAffix{
			Type:        a.Type,
			Value:       a.Value,
			Extra:       !poolTypes[a.Type],
			Src:         src,
			SrcExplicit: a.Explicit,
		})
	}
	full := poolLen > 0 && len(affixes) >= poolLen
	adjective := adjectiveOf(list, net, noNeg, full, c.AdjectiveRules())
	if g, modern := Growth(signature); modern {
		adjective = fmt.Sprintf("+%d", g.Level)
		if g.Engrave != "none" {
			adjective += " · 精工"
		}
	}
	name := base.Name
	if adjective != "" {
		name = adjective + " " + base.Name
	}
	return ComponentMeta{
		ID:          signature,
		BaseID:      base.ID,
		BaseName:    base.Name,
		Part:        base.Part,
		Quality:     quality,
		QualityName: q.Name,
		Rarity:      quality,
		RarityName:  q.Name,
		Name:        name,
		Price:       math.Round(base.Price * q.Mult),
		Affixes:     list,
		Pool:        append([]AffixRange(nil), base.Pool...),
		MaxAffixes:  poolLen,
		Full:        full,
	}, true
}

func adjectiveOf(affixes []MetaAffix, net float64, noNeg, full bool, rules []AdjectiveRule) string {
	for _, r := range rules {
		if r.Full != nil && *r.Full != full {
			continue
		}
		if r.NoNeg != nil && *r.NoNeg != noNeg {
			continue
		}
		if r.NetMin != nil && net < *r.NetMin {
			continue
		}
		if r.NetMax != nil && net > *r.NetMax {
			continue
		}
		if r.MinAffix != nil && len(affixes) < *r.MinAffix {
			continue
		}
		if r.MaxAffix != nil && len(affixes) > *r.MaxAffix {
			continue
		}
		return r.Name
	}
	return ""
}
