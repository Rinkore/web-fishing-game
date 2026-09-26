package rules

import (
	"encoding/json"
	"errors"
	"math"
)

// HutConfig is the fish-house ("渔屋") ruleset. It lives in the same immutable
// catalog as GEAR_SYSTEM so operators can publish, diff and roll it back with
// the existing catalog release chain (see ValidateCatalog).
//
// Design contract: the only limits on offline income are time based — a fixed
// capacityHours per settlement and the 24 hours a day contains. There is no
// coin cap and no daily collection count: investing into the hut always pays
// off, while the asymptotic endless layer keeps the late-game share bounded.
type HutCost struct {
	Coins int64            `json:"coins"`
	Items map[string]int64 `json:"items,omitempty"`
}
type HutRenovateCost struct {
	Coins         float64 `json:"coins"`
	CoinsGrowth   float64 `json:"coinsGrowth"`
	StormRelic    int64   `json:"stormRelic"`
	AlloyPerLevel int64   `json:"alloyPerLevel"`
}
type HutConfig struct {
	Levels        []float64 `json:"levels"`
	CapacityHours float64   `json:"capacityHours"`
	AsymptoteRate float64   `json:"asymptoteRate"`
	EndlessTau    float64   `json:"endlessTau"`
	PetPerLevel   float64   `json:"petPerLevel"`
	PetBonusCap   float64   `json:"petBonusCap"`
	PetSlots      int       `json:"petSlots"`
	RolePerPoint  float64   `json:"rolePerPoint"`
	RoleBonusCap  float64   `json:"roleBonusCap"`
	RolePointsMax int       `json:"rolePointsMax"`

	BonusUnlockLevel    int `json:"bonusUnlockLevel"`
	BonusHalfUntilLevel int `json:"bonusHalfUntilLevel"`

	StealPerLevel        int64 `json:"stealPerLevel"`
	StealPerPickCap      int64 `json:"stealPerPickCap"`
	StealDailyCoinCap    int64 `json:"stealDailyCoinCap"`
	StealPicksPerDay     int   `json:"stealPicksPerDay"`
	RelationshipMinHours int   `json:"relationshipMinHours"`

	UpgradeCosts      []HutCost       `json:"upgradeCosts"`
	RenovateCost      HutRenovateCost `json:"renovateCost"`
	MaterialWhitelist []string        `json:"materialWhitelist"`
}

func (c *Catalog) HutConfig() HutConfig {
	var v HutConfig
	_ = c.Constant("HUT", &v)
	return v
}

func (h HutConfig) Raw() json.RawMessage { b, _ := json.Marshal(h); return b }

// MaxLevel is the level cap of the main track; beyond it the endless layer
// (renovation) takes over with an asymptotic rate.
func (h HutConfig) MaxLevel() int { return len(h.Levels) }

// Rate returns coins per hour. Levels beyond MaxLevel are reached through the
// renovation count, which approaches AsymptoteRate without ever touching it.
func (h HutConfig) Rate(level, endless int) float64 {
	if len(h.Levels) == 0 {
		return 0
	}
	if level < 1 {
		level = 1
	}
	if level < len(h.Levels) {
		return h.Levels[level-1]
	}
	base := h.Levels[len(h.Levels)-1]
	if endless <= 0 || h.EndlessTau <= 0 {
		return base
	}
	return h.AsymptoteRate - (h.AsymptoteRate-base)*math.Exp(-float64(endless)/h.EndlessTau)
}

// EffectiveHours clamps an elapsed duration to the yard capacity. Callers must
// still clamp against the server clock; this only applies the rule.
func (h HutConfig) EffectiveHours(elapsed float64) float64 {
	if elapsed <= 0 {
		return 0
	}
	if elapsed > h.CapacityHours {
		return h.CapacityHours
	}
	return elapsed
}

// Bonus is the pet + role multiplier. It never applies before
// BonusUnlockLevel and is halved up to BonusHalfUntilLevel, so the early game
// cannot be pushed over its share budget by rushing companions.
//
// stationedAffinity holds the affinity level of each stationed pet (only the
// first PetSlots entries are counted). roles is keyed by track name; only
// "cook" feeds the coin rate — "brine" and "trader" drive the material and
// social side and deliberately do not touch gold.
func (h HutConfig) Bonus(level int, stationedAffinity []int, roles map[string]int) float64 {
	if level < h.BonusUnlockLevel {
		return 0
	}
	pet := 0.0
	for i, lv := range stationedAffinity {
		if i >= h.PetSlots {
			break
		}
		if lv > 0 {
			pet += float64(lv) * h.PetPerLevel
		}
	}
	if pet > h.PetBonusCap {
		pet = h.PetBonusCap
	}
	role := float64(roles["cook"]) * h.RolePerPoint
	if role > h.RoleBonusCap {
		role = h.RoleBonusCap
	}
	gate := 1.0
	if h.BonusHalfUntilLevel > 0 && level <= h.BonusHalfUntilLevel {
		gate = 0.5
	}
	return (pet + role) * gate
}

// Payout converts a settlement window into coins. Note the absence of a cap:
// the only bound is that hours was already clamped to CapacityHours.
func (h HutConfig) Payout(rate, hours, bonus float64) int64 {
	if rate <= 0 || hours <= 0 {
		return 0
	}
	return int64(math.Round(rate * hours * (1 + bonus)))
}

// Cost is the price of the upgrade that leaves the given level.
func (h HutConfig) Cost(level int) (HutCost, bool) {
	if level < 1 || level > len(h.UpgradeCosts) {
		return HutCost{}, false
	}
	return h.UpgradeCosts[level-1], true
}

// RenovatePrice is the coin/material price of the n-th renovation (1-based).
func (h HutConfig) RenovatePrice(n int) (int64, int64, int64) {
	if n < 1 {
		n = 1
	}
	coins := h.RenovateCost.Coins
	for i := 1; i < n; i++ {
		coins *= h.RenovateCost.CoinsGrowth
	}
	return int64(math.Round(coins)), h.RenovateCost.StormRelic, h.RenovateCost.AlloyPerLevel * int64(n)
}

// DailyMax is the structural ceiling used by the validator and the admin
// simulator: a day holds 24 hours, so the rate alone bounds the payout.
func (h HutConfig) DailyMax(rate float64, bonus float64) float64 {
	return rate * 24 * (1 + bonus)
}

func (h HutConfig) allowsMaterial(id string) bool {
	for _, ok := range h.MaterialWhitelist {
		if ok == id {
			return true
		}
	}
	return false
}

// ValidateHut mirrors ValidateGear: every failure returns a Chinese message so
// the operator console can show it verbatim.
//
// The console deliberately has no upper limits: an operator may publish any
// capacity, rate or bonus the design needs, so only lower bounds and structural
// coherence are rejected. The 5% late-game share budget is reported by
// SimulateHut as advice and no longer blocks a publication.
func (c *Catalog) ValidateHut() error {
	h := c.HutConfig()
	bad := errors.New("渔屋配置无效：检查等级曲线、晒场容量、无尽层与偷取参数")
	if len(h.Levels) != 10 {
		return bad
	}
	for i, v := range h.Levels {
		if !finite(v) || v <= 0 {
			return bad
		}
		if i > 0 && v < h.Levels[i-1] {
			return errors.New("渔屋配置无效：速率曲线必须单调不减")
		}
	}
	if !finite(h.CapacityHours) || h.CapacityHours < 1 {
		return errors.New("渔屋配置无效：晒场容量必须不小于 1 小时")
	}
	if !finite(h.EndlessTau) || h.EndlessTau <= 0 {
		return errors.New("渔屋配置无效：无尽层渐近速度必须大于 0")
	}
	if !finite(h.AsymptoteRate) || h.AsymptoteRate < h.Levels[len(h.Levels)-1] {
		return errors.New("渔屋配置无效：无尽渐近线不能低于满级速率")
	}
	if h.StealPerPickCap*int64(h.StealPicksPerDay) < h.StealDailyCoinCap {
		return errors.New("渔屋配置无效：偷取单次上限 × 每日次数 小于每日上限，参数自相矛盾")
	}
	if h.RelationshipMinHours < 24 {
		return errors.New("渔屋配置无效：好友关系时效门槛不得低于 24 小时")
	}
	if len(h.UpgradeCosts) != 9 {
		return errors.New("渔屋配置无效：升级消耗表必须正好 9 级")
	}
	for _, cost := range h.UpgradeCosts {
		if cost.Coins < 0 {
			return bad
		}
		for id, n := range cost.Items {
			if n < 0 || !h.allowsMaterial(id) {
				return errors.New("渔屋配置无效：升级消耗只能使用材料白名单内的物品（风暴遗物 / 强化合金 / 普通鱼饵材料）")
			}
		}
	}
	return nil
}

// HutPhase is one row of the operator-facing balance report.
type HutPhase struct {
	Stage    string  `json:"stage"`
	Daily    int64   `json:"daily"`
	Baseline int64   `json:"baseline"`
	Pct      float64 `json:"pct"`
	OK       bool    `json:"ok"`
}
type HutSimulation struct {
	Phases       []HutPhase `json:"phases"`
	EndlessTotal int64      `json:"endlessTotal"`
	Violations   []string   `json:"violations"`
}

// HutBaselines are the reference daily incomes the design is calibrated
// against. Early is the measured rookie baseline (see the design doc §2.6);
// mid/late come from the growth-curve rework profile.
const (
	hutBaselineEarly = 4292
	hutBaselineMid   = 24000
	hutBaselineLate  = 68000
)

// SimulateHut recomputes the acceptance table from the current config. It is
// the same arithmetic the design doc used, exposed so the operator console can
// show how a draft compares with the 5% share budget. Publishing is never
// blocked by it: the console has no upper limits, the table is advice.
func (c *Catalog) SimulateHut() HutSimulation {
	h := c.HutConfig()
	full := []int{h.PetSlots, 10}
	half := []int{h.PetSlots, 6}
	out := HutSimulation{Phases: []HutPhase{}, Violations: []string{}}

	add := func(stage string, level int, affinities []int, cook int, baseline int64) {
		bonus := h.Bonus(level, affinities, map[string]int{"cook": cook})
		daily := h.Payout(h.Rate(level, 0), 24, bonus)
		pct := float64(daily) / float64(baseline) * 100
		out.Phases = append(out.Phases, HutPhase{Stage: stage, Daily: daily, Baseline: baseline, Pct: pct})
	}
	// 前期只吃等级收益（加成 Lv5 才解锁），中期吃半效加成，后期满配。
	add("early", 1, nil, 0, hutBaselineEarly)
	add("mid", 6, half, 2, hutBaselineMid)
	add("late", 10, full, 3, hutBaselineLate)

	// 验收：前期 15~30%、占比单调下降、后期 ≤5%
	early, mid, late := &out.Phases[0], &out.Phases[1], &out.Phases[2]
	early.OK = early.Pct >= 15 && early.Pct <= 30
	mid.OK = mid.Pct < early.Pct && mid.Pct <= 10
	late.OK = late.Pct <= 5
	if !early.OK {
		out.Violations = append(out.Violations, "前期占比不在 15%~30% 区间内")
	}
	if !mid.OK {
		out.Violations = append(out.Violations, "中期占比没有比前期下降，或超过 10%")
	}
	if !late.OK {
		out.Violations = append(out.Violations, "后期占比超过 5%")
	}

	// 满无尽 + 偷取的总账：这是设计里唯一还保留的金额硬顶（偷取部分）。
	fullBonus := 1 + h.PetBonusCap + h.RoleBonusCap
	hutMax := int64(math.Round(h.AsymptoteRate * 24 * fullBonus))
	out.EndlessTotal = hutMax + h.StealDailyCoinCap
	if out.EndlessTotal > hutBaselineLate/20 {
		out.Violations = append(out.Violations, "满无尽 + 偷取合计超过后期钓鱼收入的 5%")
	}
	return out
}
