package house

import "fishing.local/server/internal/rules"

// petFeedItem is the common bait material spent on feeding a companion and
// handed over with a successful steal. It is part of the published material
// whitelist, so it can never drift away from the catalog.
const petFeedItem = "bait_pack"

func petIDValid(id string) bool {
	if id == "" || len(id) > 32 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func trackValid(track string) bool {
	switch track {
	case "cook", "brine", "trader":
		return true
	}
	return false
}

func containsPet(list []string, id string) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

func removePet(list []string, id string) []string {
	out := list[:0]
	for _, v := range list {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// petRoleFor returns the role archetype ("guard", "production", "collect", "scout")
// for the given pet id. Returns "" if the id is not found in the catalog.
func petRoleFor(h rules.HutConfig, petID string) string {
	for _, def := range h.PetDefs {
		if def.ID == petID {
			return def.Role
		}
	}
	return ""
}

// petRoleConfig returns the PetRoleConfig for a given role id, with ok=false
// when the role is not configured.
func petRoleConfig(h rules.HutConfig, role string) (rules.PetRoleConfig, bool) {
	for _, rc := range h.PetRoles {
		if rc.ID == role {
			return rc, true
		}
	}
	return rules.PetRoleConfig{}, false
}

// rackStageConfig returns the RackStageConfig for a given stage id.
func rackStageConfig(h rules.HutConfig, stageID string) (rules.RackStageConfig, bool) {
	for _, s := range h.RackStages {
		if s.ID == stageID {
			return s, true
		}
	}
	return rules.RackStageConfig{}, false
}

// rackCapacityFor returns the number of rack slots for a given house level.
func rackCapacityFor(h rules.HutConfig, level int) int {
	if level < 1 || len(h.RackSlotsByLevel) == 0 {
		return 0
	}
	idx := level - 1
	if idx >= len(h.RackSlotsByLevel) {
		idx = len(h.RackSlotsByLevel) - 1
	}
	return h.RackSlotsByLevel[idx]
}

// dryStageConfig returns the mandatory dry stage config, or false if not found.
func dryStageConfig(h rules.HutConfig) (rules.RackStageConfig, bool) {
	return rackStageConfig(h, PhaseDry)
}

// stationedGuardAffinity returns the total affinity of stationed guard-role pets.
func stationedGuardAffinity(h rules.HutConfig, stationed []string, pets Pets) int {
	total := 0
	for _, id := range stationed {
		if petRoleFor(h, id) == "guard" {
			total += pets[id]
		}
	}
	return total
}

// stationedProductionAffinity returns the total affinity of stationed production-role pets.
func stationedProductionAffinity(h rules.HutConfig, stationed []string, pets Pets) int {
	total := 0
	for _, id := range stationed {
		if petRoleFor(h, id) == "production" {
			total += pets[id]
		}
	}
	return total
}

// stationedCollectPetID returns the first stationed collect-role pet id, or "".
func stationedCollectPetID(h rules.HutConfig, stationed []string) string {
	for _, id := range stationed {
		if petRoleFor(h, id) == "collect" {
			return id
		}
	}
	return ""
}

// fishTierMultiplier returns the base value multiplier for a given fish rarity tier.
func fishTierMultiplier(h rules.HutConfig, tier string) float64 {
	if h.FishTierMultipliers != nil {
		if m, ok := h.FishTierMultipliers[tier]; ok {
			return m
		}
	}
	return 1.0
}

// batchCoins computes the coin value of a completed batch.
// fishPrice × tierMult × product-of-stage-multipliers × (1 + roleBonus + prodPetBonus)
// If premium is true, an additional premiumMultiplier is applied.
func batchCoins(h rules.HutConfig, fishPrice int64, fishTier string, phases []RackPhase,
	cookPoints int, prodAffinity int, premium bool) int64 {
	if fishPrice <= 0 {
		return 0
	}
	value := float64(fishPrice) * fishTierMultiplier(h, fishTier)

	// Stage multipliers
	for _, phase := range phases {
		if sc, ok := rackStageConfig(h, phase); ok {
			if sc.Multiplier > 0 {
				value *= sc.Multiplier
			}
		}
	}

	// Cook role bonus (same formula as old rate bonus but applied per-batch)
	roleBonus := float64(cookPoints) * h.RolePerPoint
	if roleBonus > h.RoleBonusCap {
		roleBonus = h.RoleBonusCap
	}

	// Production pet speed/premium bonus applies to value too
	prodBonus := 0.0
	if prodAffinity > 0 {
		for _, rc := range h.PetRoles {
			if rc.ID == "production" && rc.SpeedBonus > 0 {
				prodBonus = float64(prodAffinity) * rc.SpeedBonus
				break
			}
		}
	}

	value *= (1.0 + roleBonus + prodBonus)

	if premium {
		mult := h.PremiumBatchMultiplier
		if mult <= 1.0 {
			mult = 3.0 // safe default
		}
		value *= mult
	}

	return int64(value + 0.5)
}

// batchTotalHours returns the wall-clock duration (in hours) for a complete
// processing chain, reduced by the production pet speed bonus.
func batchTotalHoursFrom(h rules.HutConfig, phases []RackPhase, prodAffinity int) float64 {
	total := 0.0
	for _, phase := range phases {
		if sc, ok := rackStageConfig(h, phase); ok {
			total += sc.Hours
		}
	}
	// Speed bonus: each affinity level reduces total time
	if prodAffinity > 0 {
		for _, rc := range h.PetRoles {
			if rc.ID == "production" && rc.SpeedBonus > 0 {
				speedFrac := float64(prodAffinity) * rc.SpeedBonus
				if speedFrac > 0.5 {
					speedFrac = 0.5 // cap at 50% reduction
				}
				total *= (1.0 - speedFrac)
				break
			}
		}
	}
	return total
}

// premiumChance returns the probability of a premium batch outcome.
func premiumChance(h rules.HutConfig, prodAffinity int) float64 {
	base := h.PremiumBatchBaseChance
	if base <= 0 {
		base = 0.05
	}
	bonus := 0.0
	if prodAffinity > 0 {
		for _, rc := range h.PetRoles {
			if rc.ID == "production" && rc.PremiumBonus > 0 {
				bonus = float64(prodAffinity) * rc.PremiumBonus
				break
			}
		}
	}
	p := base + bonus
	if p > 0.5 {
		p = 0.5
	}
	return p
}
