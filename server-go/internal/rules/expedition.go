package rules

import "strings"

type ExpeditionRoute struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Level       int     `json:"level"`
	Success     float64 `json:"success"`
	Coins       int64   `json:"coins"`
	Description string  `json:"description"`
}
type Catalyst struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Affix    string `json:"affix"`
	Route    string `json:"route"`
	MinHours int    `json:"minHours"`
}
type ExpeditionConfig struct {
	Hours     []int             `json:"hours"`
	Ticket    int64             `json:"ticket"`
	Routes    []ExpeditionRoute `json:"routes"`
	Catalysts []Catalyst        `json:"catalysts"`
}
type GearSet struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Level   int    `json:"level"`
	Cost    int64  `json:"cost"`
	Effect  string `json:"effect"`
	Pending bool   `json:"pending"`
	Pieces  []struct {
		Part  string  `json:"part"`
		Name  string  `json:"name"`
		Type  string  `json:"type"`
		Value float64 `json:"value"`
	} `json:"pieces"`
}

func (c *Catalog) ExpeditionConfig() ExpeditionConfig {
	var v ExpeditionConfig
	_ = c.Constant("EXPEDITION", &v)
	return v
}
func (c *Catalog) GearSets() []GearSet { var v []GearSet; _ = c.Constant("GEAR_SETS", &v); return v }
func SetID(definition string) string {
	if !strings.HasPrefix(definition, "set_") {
		return ""
	}
	p := strings.Split(definition, "_")
	if len(p) != 3 || (p[2] != "rod" && p[2] != "charm") {
		return ""
	}
	return p[1]
}
func (c *Catalog) ActiveSet(parts map[string]string) string {
	rod, _, _, ok := c.Instance(parts["rod"])
	if !ok || rod.SetID == "" {
		return ""
	}
	charm, _, _, ok := c.Instance(parts["charm"])
	if !ok || charm.SetID != rod.SetID {
		return ""
	}
	return rod.SetID
}
func (c *Catalog) AffixAllowed(part, kind string) bool {
	var m map[string][]string
	_ = c.Constant("PART_AFFIXES", &m)
	if len(m) == 0 {
		return true
	}
	for _, v := range m[part] {
		if v == kind {
			return true
		}
	}
	return false
}
