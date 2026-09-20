package rules

import (
	"math"
	"time"
)

type PriceDynamics struct {
	SaleDivisor float64 `json:"saleDivisor"`
	RiseTauMin  float64 `json:"riseTauMin"`
	Floor       float64 `json:"floor"`
	Ceil        float64 `json:"ceil"`
	Target      float64 `json:"target"`
}
type SaleState struct {
	Multiplier *float64 `json:"m"`
	LastMS     int64    `json:"lastTs"`
	SoldTotal  int64    `json:"soldTotal"`
	SoldToday  int64    `json:"soldToday"`
	Day        string   `json:"day"`
}
type PriceOverride struct {
	Base, Multiplier float64
	UntilMS          int64
}

func DefaultPriceDynamics() PriceDynamics { return PriceDynamics{.0075, 60, .4, 2, 2} }
func CurrentMultiplier(s SaleState, nowMS int64, d PriceDynamics) float64 {
	last := s.LastMS
	if last == 0 {
		last = nowMS
	}
	idle := math.Max(0, float64(nowMS)-float64(last))
	m := 1.0
	if s.Multiplier != nil {
		m = *s.Multiplier
	}
	m = clamp(m, d.Floor, d.Ceil)
	return clamp(d.Target-(d.Target-m)*math.Exp(-idle/(d.RiseTauMin*60000)), d.Floor, d.Ceil)
}
func Price(base float64, state *SaleState, override PriceOverride, nowMS int64, d PriceDynamics) float64 {
	if override.UntilMS != 0 && nowMS > override.UntilMS {
		override = PriceOverride{}
	}
	if override.Base > 0 {
		base = Round(override.Base)
	}
	if override.Multiplier > 0 {
		return math.Max(1, Round(base*override.Multiplier))
	}
	if state == nil {
		return base
	}
	return math.Max(1, Round(base*CurrentMultiplier(*state, nowMS, d)))
}
func RegisterSale(s SaleState, qty int64, nowMS int64, d PriceDynamics) SaleState {
	m := math.Max(d.Floor, CurrentMultiplier(s, nowMS, d)/math.Pow(1+d.SaleDivisor, float64(qty)))
	s.Multiplier = &m
	s.LastMS = nowMS
	s.SoldTotal += qty
	day := time.UnixMilli(nowMS).UTC().Format("2006-01-02")
	if s.Day != day {
		s.Day = day
		s.SoldToday = 0
	}
	s.SoldToday += qty
	return s
}

type AutoSellRule struct {
	On         bool     `json:"on"`
	Keep       any      `json:"keep"`
	MinPct     *float64 `json:"minPct"`
	MinPrice   *float64 `json:"minPrice"`
	SlackPct   float64  `json:"slackPct"`
	SlackPrice float64  `json:"slackPrice"`
}
type AutoSellInput struct {
	ID     string       `json:"id"`
	Rule   AutoSellRule `json:"rule"`
	Normal int64        `json:"normal"`
	Large  int64        `json:"large"`
	Giant  int64        `json:"giant"`
	Base   float64      `json:"base"`
	Price  float64      `json:"price"`
}
type SalePart struct {
	ID       string  `json:"id"`
	Tier     string  `json:"tier"`
	Quantity int64   `json:"quantity"`
	Unit     float64 `json:"unit"`
	Bonus    float64 `json:"bonus"`
	Gain     float64 `json:"gain"`
}
type AutoSellPlan struct {
	Pool    int64      `json:"pool"`
	Blocked int64      `json:"blocked"`
	Batch   int64      `json:"batch"`
	Parts   []SalePart `json:"parts"`
	Gain    float64    `json:"gain"`
}

func AutoSellHit(base, price float64, r AutoSellRule) string {
	if r.MinPct == nil && r.MinPrice == nil {
		return "无条件"
	}
	if r.MinPct != nil && base > 0 && price >= base*math.Max(1, *r.MinPct-r.SlackPct)/100 {
		return "基准"
	}
	if r.MinPrice != nil && price >= math.Max(1, *r.MinPrice-r.SlackPrice) {
		return "价格"
	}
	return ""
}

// PlanAutoSell receives authoritative prices and holdings under their locks.
// It makes no writes. Parts are applied together with price state and ledgers.
func (c *Catalog) PlanAutoSell(input []AutoSellInput, includeTiers bool, batch int64) AutoSellPlan {
	if batch < 1 || batch > 10000 {
		batch = 100
	}
	plan := AutoSellPlan{Batch: batch, Parts: []SalePart{}}
	for _, x := range input {
		it, ok := c.Item(x.ID)
		if !ok || !x.Rule.On || (it.Kind != "fish" && it.Kind != "material") {
			continue
		}
		keep := math.Floor(Number(x.Rule.Keep))
		if !finite(keep) || keep < 0 {
			keep = 0
		}
		have := x.Normal
		if includeTiers {
			have += x.Large + x.Giant
		}
		if keep >= float64(have) {
			continue
		}
		excess := have - int64(keep)
		if excess <= 0 {
			continue
		}
		if AutoSellHit(x.Base, x.Price, x.Rule) == "" {
			plan.Blocked += excess
			continue
		}
		plan.Pool += excess
		quantities := []int64{x.Normal, x.Large, x.Giant}
		for i, q := range quantities {
			n := min(excess, q)
			if n <= 0 {
				continue
			}
			excess -= n
			tier := []string{"normal", "large", "giant"}[i]
			bonus := Round(x.Price * float64(n) * []float64{0, .5, 1.5}[i])
			gain := x.Price*float64(n) + bonus
			plan.Gain += gain
			plan.Parts = append(plan.Parts, SalePart{x.ID, tier, n, x.Price, bonus, gain})
		}
	}
	if plan.Pool < batch {
		plan.Parts = []SalePart{}
		plan.Gain = 0
	}
	return plan
}
