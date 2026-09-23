package gear

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"math"
)

type Fishing struct {
	State   State
	Active  string
	Effect  map[string]float64
	Config  rules.GearConfig
	Key     string
	Allowed bool
}

func PrepareFishing(ctx context.Context, t *assets.Transaction, c *rules.Catalog, owner int64, key string, interval float64, first bool, pool []rules.LootEntry, eff rules.Effects) (Fishing, []rules.LootEntry, error) {
	f := Fishing{Config: c.GearConfig(), Key: key}
	var err error
	f.State, err = Read(ctx, t.SQL(), owner)
	if err != nil {
		return f, pool, err
	}
	f.Active, err = Active(ctx, t.SQL(), c, owner)
	if err != nil {
		return f, pool, err
	}
	f.Effect = f.Config.Sets[f.Active].Effect(f.State.Tiers[f.Active])
	v := &f.State
	if v.LastCast != key {
		v.LastCast = key
		v.CastHit = false
		v.CastProgressed = false
	}
	if first && f.Active == "forge" {
		seconds := f.Effect["heatSeconds"]
		if seconds > 0 {
			v.HeatMS += interval
			n := int(v.HeatMS / (seconds * 1000))
			v.HeatMS = math.Mod(v.HeatMS, seconds*1000)
			v.Heat = min(int(f.Effect["heatCap"]), v.Heat+n)
		}
	}
	if f.Active == "research" {
		eff["_ecology"] = f.Effect["uniformMix"]
	}
	var has func([]rules.LootEntry) bool
	has = func(xs []rules.LootEntry) bool {
		for _, x := range xs {
			if x.Weight > 0 && (x.Pick == "fish:"+v.Target || has(x.Items)) {
				return true
			}
		}
		return false
	}
	f.Allowed = v.Target != "" && has(pool) && !c.GearExcluded(v.Target)
	if f.Active == "apex" && f.Allowed {
		fish, _ := c.Item(v.Target)
		pity := int(f.Effect["pityCommon"])
		if fish.Rarity == "rare" {
			pity = int(f.Effect["pityRare"])
		}
		if fish.Rarity == "epic" || fish.Rarity == "mythic" {
			pity = int(f.Effect["pityEpic"])
		}
		if n := f.Config.FishPity[v.Target]; n > 0 {
			pity = n
		}
		pity = max(1, int(math.Ceil(float64(pity)*f.Effect["pityFactor"])))
		if v.Tracking >= pity-1 && !v.CastHit {
			pool = []rules.LootEntry{{Pick: "fish:" + v.Target, Weight: 1}}
		} else {
			var boost func([]rules.LootEntry)
			boost = func(xs []rules.LootEntry) {
				for i := range xs {
					if xs[i].Pick == "fish:"+v.Target {
						xs[i].Weight *= 1 + float64(min(v.Tracking, int(f.Effect["maxStacks"])))*f.Effect["weightStep"]
					}
					boost(xs[i].Items)
				}
			}
			boost(pool)
		}
	}
	return f, pool, nil
}
func (f *Fishing) Finish(ctx context.Context, t *assets.Transaction, c *rules.Catalog, owner int64, catches []rules.Catch, done bool) ([]rules.Catch, error) {
	v := &f.State
	fish := []rules.Catch{}
	for _, x := range catches {
		if x.Kind == "fish" {
			fish = append(fish, x)
		}
	}
	bonus := []rules.Catch{}
	if f.Active == "apex" && f.Allowed {
		for _, x := range fish {
			if x.ID == v.Target {
				v.CastHit = true
			}
		}
		if len(fish) > 0 && !v.CastProgressed {
			v.CastProgressed = true
			v.Tracking++
		}
		if v.CastHit {
			v.Tracking = 0
		}
		if done && v.CastHit {
			v.TargetCaught++
			if f.Effect["queue"] > 0 && len(v.TargetQueue) > 0 && v.TargetCaught >= max(1, v.TargetGoal) {
				previous := v.Target
				v.Target = v.TargetQueue[0]
				v.TargetQueue = append(v.TargetQueue[1:], previous)
				v.TargetCaught = 0
				v.Tracking = 0
			}
		}
	}
	if f.Active == "harvest" && len(fish) > 0 && !v.CastProgressed {
		v.CastProgressed = true
		eligible := []rules.Catch{}
		for _, x := range fish {
			if !c.GearExcluded(x.ID) {
				eligible = append(eligible, x)
			}
		}
		if len(eligible) > 0 {
			v.Harvest++
			candidate := eligible[0]
			v.Recent = append(v.Recent, candidate)
			limit := max(1, int(f.Effect["recent"]))
			if len(v.Recent) > limit {
				v.Recent = v.Recent[len(v.Recent)-limit:]
			}
			threshold := max(1, int(f.Effect["casts"]))
			copies := max(1, int(f.Effect["copies"]))
			if v.HarvestMode == "large" && f.Effect["largeMode"] > 0 {
				mult := max(1, int(f.Effect["largeMultiplier"]))
				threshold *= mult
				copies *= mult
			}
			if v.Harvest >= threshold {
				v.Harvest -= threshold
				if f.Effect["best"] > 0 {
					for _, x := range v.Recent {
						a, _ := c.Item(candidate.ID)
						b, _ := c.Item(x.ID)
						if b.Price > a.Price && !c.GearExcluded(x.ID) {
							candidate = x
						}
					}
				}
				candidate.Size = nil
				candidate.CodexID = ""
				for i := 0; i < copies; i++ {
					bonus = append(bonus, candidate)
				}
			}
		}
	}
	return bonus, Write(ctx, t, owner, *v)
}
