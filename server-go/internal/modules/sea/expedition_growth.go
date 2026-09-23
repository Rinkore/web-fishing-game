package sea

import (
	"fishing.local/server/internal/modules/gear"
	"fishing.local/server/internal/rules"
	"math"
	"sort"
)

// Reward is finalized once at dispatch. No live gear or later config enters claim.
func growthExpeditionReward(c *rules.Catalog, route rules.ExpeditionRoute, hours int, snap ExpeditionSnapshot, state gear.State, rng rules.RNG) ExpeditionReward {
	cfg := c.GearConfig()
	alloc := snap.Allocations
	if alloc == nil && snap.Set != "" {
		alloc = map[string]int{snap.Set: 3}
	}
	scale := func(id string) float64 { return float64(alloc[id]) / 3 }
	fx := snap.SpecialEffects
	if snap.SpecializationEffects != nil {
		if f, ok := snap.SpecializationEffects[snap.Set]; ok {
			fx = f
		}
	}
	success := route.Success
	if alloc["storm"] > 0 && snap.Mode == "deep" && route.Level >= int(fx["minRouteLevel"]) {
		success = math.Max(0, success-fx["deepRisk"]*scale("storm"))
	}
	r := ExpeditionReward{Success: rng()*100 < success, Event: "平安返航", Items: map[string]int64{}, XP: int64(hours * 2)}
	loss := 1.0
	if !r.Success {
		loss = .5
		r.Event = "遭遇事故，损失部分货物"
		if alloc["rescue"] > 0 {
			loss = .5 + (fx["retain"]-.5)*scale("rescue")
			r.Event = "护航保全已获得货物"
		}
	}
	evacuated := alloc["rescue"] > 0 && snap.Mode == "evacuate" && !r.Success && fx["evacuate"]*scale("rescue") > 0
	if evacuated {
		loss = 1 - fx["evacuationLoss"]*scale("rescue")*scale("rescue")
		r.Event = "提前撤离：保全已有货物，放弃后续与终点奖励"
	}
	r.Coins = int64(float64(route.Coins) * float64(hours) * loss)
	r.XP = max(1, int64(float64(r.XP)*loss))
	if r.Success {
		r.Marks = map[int]int64{2: 1, 8: 5, 12: 8}[hours]
	}
	ids := []string{}
	for id := range cfg.BaseDrops[route.ID] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		base := cfg.BaseDrops[route.ID][id] * float64(hours)
		mult := 1.0
		if alloc["tide"] > 0 && id != "relic" && id != "chartfrag" {
			mult += fx["bonus"] * scale("tide")
			if snap.Focus == id {
				mult += fx["focus"] * scale("tide")
				if snap.Mode == "concentrate" {
					mult += fx["concentrate"] * scale("tide")
				}
			} else if snap.Mode == "concentrate" && fx["concentrate"] > 0 {
				mult = 1
			}
		}
		itemLoss := loss
		if alloc["rescue"] > 0 && !r.Success {
			advanced := id == "gear_fine" || id == "gear_crystal"
			if advanced && fx["advanced"]*scale("rescue") == 0 {
				itemLoss = .5
			}
			if snap.Focus == id && fx["priority"]*scale("rescue") > 0 {
				itemLoss = .5 + .5*scale("rescue")
			}
		}
		if evacuated {
			base *= .5
		} // completed portion only, never a full journey's cargo
		n := int64(math.Floor(base * mult * itemLoss))
		if alloc["tide"] > 0 && snap.Focus == id && fx["minimum"]*scale("tide") > 0 {
			n = max(n, int64(fx["minimum"]*scale("tide")))
		}
		if n > 0 {
			r.Items[id] = n
		}
	}
	r.ArchaeologyHours = state.ArchaeologyHours
	if alloc["wreck"] > 0 && route.Level >= int(fx["minRouteLevel"]) {
		thirds := state.ArchaeologyRemainder + hours*alloc["wreck"]
		effectiveHours := thirds / 3
		r.ArchaeologyRemainder = thirds % 3
		r.Items["relic"] += int64(math.Floor(float64(effectiveHours) * fx["fragmentsPerHour"] * loss))
		r.ArchaeologyHours += effectiveHours
		trials := effectiveHours
		chances := int64(0)
		pity := int(fx["pityHours"])
		if pity > 0 && r.ArchaeologyHours >= pity {
			chances = 1
			r.ArchaeologyHours %= pity
		}
		for i := 0; i < trials; i++ {
			if rng() < fx["chestChancePerHour"] {
				chances++
				r.ArchaeologyHours = 0
			}
		}
		if chances > 0 {
			chest := "chest_wreck"
			if fx["highChest"] > 0 && route.Level >= 4 {
				chest = "chest_deep"
			}
			if _, ok := c.Item(chest); !ok {
				chest = "chest_deep"
			}
			r.Items[chest] += chances
			r.Event += " · 发现完整宝匣"
		}
	}
	if alloc["storm"] > 0 && route.Level >= int(fx["minRouteLevel"]) && r.Success {
		mult := fx["bonus"] * scale("storm")
		if snap.Mode == "deep" {
			mult += fx["deepBonus"] * scale("storm")
		}
		for _, id := range ids {
			if id == "gear_fine" || id == "gear_crystal" {
				r.Items[id] += int64(math.Floor(float64(r.Items[id]) * mult))
			}
		}
		special := "storm_relic"
		if fx["choice"] > 0 && (snap.Focus == "gear_fine" || snap.Focus == "gear_crystal") {
			special = snap.Focus
		}
		r.Items[special] += max(1, int64(math.Floor(float64(hours)*fx["specialPerHour"]*scale("storm")*scale("storm"))))
		r.Event += " · 风暴专属收益"
	}
	return r
}
