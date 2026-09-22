package rules

type Chest struct {
	ID             string         `json:"id"`
	Mode           string         `json:"mode"`
	CostRelic      int64          `json:"costRelic"`
	CostCoins      int64          `json:"costCoins"`
	QualityWeights OrderedWeights `json:"qualityWeights"`
	MinAffixes     int            `json:"minAffixes"`
	ForceMax       bool           `json:"forceMax"`
	Extra          bool           `json:"extra"`
	HitCount       int            `json:"hitCount"`
	MissCount      int            `json:"missCount"`
	Chance         float64        `json:"chance"`
}

func (c *Catalog) Chest(id string) (Chest, bool) {
	var chests []Chest
	_ = c.Constant("CHESTS", &chests)
	for _, ch := range chests {
		if ch.ID == id {
			return ch, true
		}
	}
	return Chest{}, false
}
func (c *Catalog) OpenChest(ch Chest, part, baseID string, cfg ComponentConfig, forced bool, rng RNG) (string, bool) {
	var base Item
	if ch.Mode == "base" {
		var ok bool
		base, ok = c.Item(baseID)
		if !ok || base.Part == "" || base.Kind != "component" {
			return "", false
		}
	} else {
		choices := []Item{}
		for _, b := range c.Items {
			if b.Kind == "component" && b.Part != "" && (ch.Mode == "random" || b.Part == part) {
				choices = append(choices, b)
			}
		}
		if len(choices) == 0 {
			return "", false
		}
		base = choices[int(rng()*float64(len(choices)))]
	}
	if ch.Extra {
		chance := ch.Chance
		if forced {
			chance = 1
		}
		return c.Breakthrough(base.ID, cfg, BreakthroughOptions{HitCount: &ch.HitCount, MissCount: &ch.MissCount, Chance: &chance}, rng)
	}
	weights := ch.QualityWeights
	if len(weights) == 0 {
		weights = cfg.QualityWeights
	}
	q := weightedKey(weights, "", rng)
	if !validQuality(q) {
		q = "rare"
	}
	return c.Generate(base.ID, q, cfg, GenerateOptions{MinAffixes: ch.MinAffixes, ForceMax: ch.ForceMax}, rng)
}
