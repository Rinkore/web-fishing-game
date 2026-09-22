package rules

import (
	"context"
	"errors"
)

// CatchWalk is private, serializable execution state for doServerCatch's
// depth-first recursion. Each frame tracks remaining children; -1 means enter.
// No total catch cap is imposed. A step budget yields without dropping work.
// Any caller that persists this state must persist its RNG cursor and effects
// together. Native settlement currently keeps the whole walk in one transaction.
type CatchWalk struct {
	Frames []int `json:"frames"`
}

func NewCatchWalk() CatchWalk  { return CatchWalk{Frames: []int{-1}} }
func (w CatchWalk) Done() bool { return len(w.Frames) == 0 }

// CatchHooks separate legacy enter effects from auto-sell on recursive return.
// Enter's false result models missing loot/storm/whirlpool loss: no child rolls
// or return hook occur. Hooks must propagate technical errors, never turn them
// into a successful early return. On error discard state/RNG/effects together.
type CatchHooks struct {
	Enter func() (bool, error)
	Leave func() error
}

func DoubleExtra(a, base any, rng RNG) int {
	p := DoubleProbability(a, base)
	if rng() < p {
		if rng() < p {
			return 2
		}
		return 1
	}
	return 0
}

func (w *CatchWalk) Advance(ctx context.Context, budget int, a, base any, rng RNG, hooks CatchHooks) (int, error) {
	if budget < 1 || rng == nil || hooks.Enter == nil || hooks.Leave == nil {
		return 0, errors.New("invalid catch execution")
	}
	for _, n := range w.Frames {
		if n < -1 || n > 2 {
			return 0, errors.New("invalid catch frame")
		}
	}
	steps := 0
	for steps < budget && !w.Done() {
		if err := ctx.Err(); err != nil {
			return steps, err
		}
		i := len(w.Frames) - 1
		switch w.Frames[i] {
		case -1:
			caught, err := hooks.Enter()
			if err != nil {
				return steps, err
			}
			if !caught {
				w.Frames = w.Frames[:i]
			} else {
				w.Frames[i] = DoubleExtra(a, base, rng)
			}
		case 0:
			if err := hooks.Leave(); err != nil {
				return steps, err
			}
			w.Frames = w.Frames[:i]
		default:
			w.Frames[i]--
			w.Frames = append(w.Frames, -1)
		}
		steps++
	}
	return steps, nil
}
