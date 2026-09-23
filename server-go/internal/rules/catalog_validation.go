package rules

import (
	"errors"
	"strings"
)

// ValidateCatalog rejects unusable snapshots before publication. Default
// source fixtures remain independently checked against the Node oracle.
func ValidateCatalog(c *Catalog) error {
	bad := errors.New("invalid catalog configuration")
	if c == nil || len(c.Version) > 32 || strings.ContainsAny(c.Version, " :\r\n") || len(c.Items) > 4096 {
		return bad
	}
	if err := c.ValidateGear(); err != nil {
		return err
	}
	base, err := Default()
	if err != nil {
		return err
	}
	for k := range base.Constants {
		if len(c.Constants[k]) == 0 {
			return bad
		}
	}
	for k := range base.Defaults {
		if len(c.Defaults[k]) == 0 {
			return bad
		}
	}
	for _, it := range c.Items {
		if len(it.ID) > 128 || strings.ContainsAny(it.ID, ": \r\n") || (it.Kind != "fish" && it.Kind != "material" && it.Kind != "component" && it.Kind != "chest") {
			return bad
		}
		if it.Kind == "fish" && (!rangeOK(it.Size) || it.Size[0] <= 0) {
			return bad
		}
		for _, a := range it.Pool {
			if !finite(a.Min) || !finite(a.Max) || a.Max < a.Min {
				return bad
			}
		}
	}
	cast := c.CastRules(nil)
	if cast.cast == nil || cast.bite == nil {
		return bad
	}
	for k, v := range c.Runtime {
		switch k {
		case "cast", "biteFormula", "drop", "lootGroups", "rareK", "doubleBase", "price", "autoSellBatch", "chestPityN":
		default:
			return bad
		}
		if k == "doubleBase" && (!finite(Number(v)) || Number(v) < 0 || Number(v) > 1) {
			return bad
		}
		if k == "rareK" && (!finite(Number(v)) || Number(v) <= 0 || Number(v) > 100000) {
			return bad
		}
		if k == "autoSellBatch" && (!finite(Number(v)) || Number(v) < 1 || Number(v) > 10000) {
			return bad
		}
		if k == "chestPityN" && (!finite(Number(v)) || Number(v) < 1 || Number(v) > 50) {
			return bad
		}
	}
	seen := map[string]bool{}
	for _, g := range c.Grounds() {
		if g.ID == "" || seen[g.ID] || len(g.Spots) > 512 {
			return bad
		}
		seen[g.ID] = true
		spots := map[string]bool{}
		for _, s := range g.Spots {
			if s.ID == "" || spots[s.ID] || s.MinShip < 0 || s.MinShip > 5 {
				return bad
			}
			spots[s.ID] = true
			if _, err = c.BoostPool(s.Pool, c.LootGroups(), EmptyEffects(), c.DefaultLootConfig()); err != nil {
				return bad
			}
			info := cast.Info(EmptyEffects(), s.Spot)
			if !finite(info.Interval) || info.Interval < 100 || info.Interval > 3600000 {
				return bad
			}
		}
	}
	if len(seen) == 0 {
		return bad
	}
	cfg := c.SeaConfig()
	if cfg.ChartCost < 1 || cfg.ZoneMax < 1 || cfg.ZoneMax > 100 || cfg.ZoneTTL < 1000 || len(cfg.Names) == 0 || len(cfg.Moods) < 2 || cfg.QuestResetHour < 0 || cfg.QuestResetHour > 23 {
		return bad
	}
	for _, p := range []float64{cfg.Events.Storm, cfg.Events.Whirlpool, cfg.Events.Bounty, cfg.Events.School, cfg.Events.Wreck, cfg.Events.BountyDouble} {
		if !finite(p) || p < 0 || p > 100 {
			return bad
		}
	}
	for _, q := range cfg.Quests {
		if q.ID == "" || q.Need <= 0 || q.Reward.Coins < 0 {
			return bad
		}
	}
	var ship struct{ XP, Coins, Scales []int64 }
	var sc struct {
		XP     []int64 `json:"xpNeed"`
		Coins  []int64 `json:"upCoins"`
		Scales []int64 `json:"upScale"`
	}
	if c.Constant("SHIP", &sc) != nil {
		return bad
	}
	ship.XP, ship.Coins, ship.Scales = sc.XP, sc.Coins, sc.Scales
	for _, values := range [][]int64{ship.XP, ship.Coins, ship.Scales} {
		if len(values) != 5 {
			return bad
		}
		for _, n := range values {
			if n < 0 {
				return bad
			}
		}
	}
	comp := c.ComponentConfig()
	if len(comp.QualityWeights) == 0 {
		return bad
	}
	for _, w := range comp.QualityWeights {
		if !validQuality(w.Key) || !finite(w.Value) || w.Value < 0 {
			return bad
		}
	}
	return nil
}
