package rules

import (
	"math"
	"testing"
)

func TestHutShippedConfigIsValid(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ValidateHut(); err != nil {
		t.Fatal(err)
	}
	h := c.HutConfig()
	if h.MaxLevel() != 10 || h.CapacityHours != 8 {
		t.Fatalf("shipped hut config %+v", h)
	}
	// Lv1 → Lv10 is the documented 45/h → 98/h curve.
	if h.Rate(1, 0) != 45 || h.Rate(10, 0) != 98 {
		t.Fatalf("level curve drifted: %v → %v", h.Rate(1, 0), h.Rate(10, 0))
	}
}

func TestHutEndlessLayerIsAsymptotic(t *testing.T) {
	c, _ := Default()
	h := c.HutConfig()
	prev := h.Rate(10, 0)
	for _, r := range []int{1, 10, 100} {
		rate := h.Rate(10, r)
		if rate <= prev {
			t.Fatalf("renovation %d did not raise the rate: %v <= %v", r, rate, prev)
		}
		if rate >= h.AsymptoteRate {
			t.Fatalf("renovation %d reached the asymptote: %v", r, rate)
		}
		prev = rate
	}
	// The curve is asymptotic: even a thousand renovations stay under the line
	// (float64 saturates at the asymptote, it never crosses it).
	if deep := h.Rate(10, 1000); deep < prev || deep > h.AsymptoteRate {
		t.Fatalf("renovation 1000 = %v, want %v ≤ rate ≤ %v", deep, prev, h.AsymptoteRate)
	}
	if math.Abs(h.AsymptoteRate-prev) > 1 {
		t.Fatalf("renovation 100 is still %v away from the asymptote", h.AsymptoteRate-prev)
	}
}

func TestHutBonusOnlyCountsStationedPetsAndCooks(t *testing.T) {
	c, _ := Default()
	h := c.HutConfig()
	full := []int{10, 10, 10}
	if got := h.Bonus(4, full, map[string]int{"cook": 9}); got != 0 {
		t.Fatalf("bonus applied below the unlock level: %v", got)
	}
	if got := h.Bonus(6, full, map[string]int{"cook": 9}); math.Abs(got-(h.PetBonusCap+h.RoleBonusCap)/2) > 1e-9 {
		t.Fatalf("half bonus at Lv6 = %v", got)
	}
	// Only the first PetSlots companions and the cook track count.
	if got := h.Bonus(10, full, map[string]int{"cook": 9, "brine": 9, "trader": 9}); math.Abs(got-(h.PetBonusCap+h.RoleBonusCap)) > 1e-9 {
		t.Fatalf("full bonus = %v", got)
	}
}

func TestHutDailyCeilingStaysInsideTheShareBudget(t *testing.T) {
	c, _ := Default()
	h := c.HutConfig()
	full := h.PetBonusCap + h.RoleBonusCap
	if got := h.DailyMax(h.AsymptoteRate, full); got > 3190 {
		t.Fatalf("fully invested daily ceiling %v breaks the 5%% budget", got)
	}
	sim := c.SimulateHut()
	if len(sim.Violations) != 0 {
		t.Fatalf("shipped config violates acceptance: %v", sim.Violations)
	}
	for _, phase := range sim.Phases {
		if !phase.OK {
			t.Fatalf("phase %s failed: %+v", phase.Stage, phase)
		}
	}
}

func TestValidateHutRejectsBrokenConfigs(t *testing.T) {
	for name, mutate := range map[string]func(*HutConfig){
		"pond larger than a day": func(h *HutConfig) { h.CapacityHours = 48 },
		"descending curve":       func(h *HutConfig) { h.Levels[3] = h.Levels[2] - 1 },
		"short upgrade table":    func(h *HutConfig) { h.UpgradeCosts = h.UpgradeCosts[:8] },
		"material off whitelist": func(h *HutConfig) {
			h.UpgradeCosts[0].Items["gear_crystal"] = 1
		},
		"asymptote below cap": func(h *HutConfig) { h.AsymptoteRate = h.Levels[9] - 1 },
	} {
		t.Run(name, func(t *testing.T) {
			c, _ := Default()
			h := c.HutConfig()
			mutate(&h)
			c.Constants["HUT"] = h.Raw()
			if err := c.ValidateHut(); err == nil {
				t.Fatal("broken config accepted")
			}
		})
	}
}
