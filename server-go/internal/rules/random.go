package rules

import "math"

type RNG func() float64 // Each draw must be in [0,1); callers own durable seed/counter.
func Ratio(model string, rng RNG) float64 {
	switch model {
	case "normal":
		u1, u2 := rng(), rng()
		if u1 == 0 {
			u1 = 1e-9
		}
		z := math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
		return clamp(.5+z/6, 0, 1)
	case "skew":
		v := rng()
		return v * v
	default:
		return rng()
	}
}
func FishRatio(model string, weights []float64, rng RNG) float64 {
	if model != "custom" {
		return Ratio(model, rng)
	}
	valid := len(weights) == 10
	sum := 0.0
	for _, v := range weights {
		if !finite(v) || v < 0 || v > 100 {
			valid = false
		}
		sum += v
	}
	if !valid || sum <= 0 {
		weights = []float64{10, 10, 10, 10, 10, 10, 10, 10, 10, 10}
		sum = 100
	}
	x := rng() * sum
	for i, v := range weights {
		x -= v
		if x < 0 {
			return (float64(i) + rng()) / 10
		}
	}
	return 1
}
func RollAffix(lo, hi float64, model string, rng RNG) float64 {
	if hi <= lo {
		return lo
	}
	draw := func() float64 { return lo + Round(Ratio(model, rng)*(hi-lo)) }
	v := draw()
	if v == 0 {
		v = draw()
	}
	if v == 0 {
		if hi > 0 {
			return 1
		}
		if lo < 0 {
			return -1
		}
	}
	return v
}
func RollBoundary(lo, hi float64, model string, rng RNG) float64 {
	a, b := RollAffix(lo, hi, model, rng), RollAffix(lo, hi, model, rng)
	da := math.Min(math.Abs(a-lo), math.Abs(a-hi))
	db := math.Min(math.Abs(b-lo), math.Abs(b-hi))
	if db < da {
		return b
	}
	return a
}

// WeightedIndex preserves caller ordering and the legacy boundary distinction:
// equipment quality/count uses <=; fish/group selection uses <.
func WeightedIndex(weights []float64, inclusive bool, rng RNG) int {
	sum := 0.0
	for _, v := range weights {
		if finite(v) && v > 0 {
			sum += v
		}
	}
	if sum <= 0 {
		return -1
	}
	x := rng() * sum
	last := -1
	for i, v := range weights {
		if !finite(v) || v < 0 {
			v = 0
		}
		if v > 0 {
			last = i
		}
		x -= v
		if x < 0 || (inclusive && x == 0) {
			return i
		}
	}
	return last
}
func FishSize(size []float64, bonus float64, model string, weights []float64, rng RNG) float64 {
	if len(size) != 2 {
		return 0
	}
	v := size[0] + FishRatio(model, weights, rng)*(size[1]-size[0])
	if bonus != 0 {
		v = math.Max(1, v*(1+bonus/100))
	}
	return Round(v*10) / 10
}
