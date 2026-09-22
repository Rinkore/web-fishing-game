package rules

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

func oracleRNG(seed uint32, draws *int) RNG {
	x := seed + 1
	return func() float64 { *draws++; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return float64(x) / 4294967296 }
}

func TestCatchNodeOracle(t *testing.T) {
	data, err := os.ReadFile("../../testdata/catch-rules.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version string
		Resolve []struct {
			Ground, Spot string
			Seed         uint32
			Effects      Effects
			Expected     struct {
				Value Catch
				Draws int
			}
		}
		Walks []struct {
			A        float64
			Seed     uint32
			Missing  bool
			Expected struct {
				Value []string
				Draws int
			}
		}
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if fixture.Version != c.Version {
		t.Fatal("oracle version drift")
	}
	for i, tc := range fixture.Resolve {
		t.Run(fmt.Sprintf("resolve-%d", i), func(t *testing.T) {
			_, spot, ok := c.FishingSpot(tc.Ground, tc.Spot)
			if !ok {
				t.Fatal("unknown spot")
			}
			pool, err := c.BoostPool(spot.Pool, nil, tc.Effects, c.DefaultLootConfig())
			if err != nil {
				t.Fatal(err)
			}
			draws := 0
			got, ok := c.ResolveCatch(pool, tc.Effects, oracleRNG(tc.Seed, &draws))
			if !ok || !reflect.DeepEqual(got, tc.Expected.Value) || draws != tc.Expected.Draws {
				t.Fatalf("got %+v draws %d; want %+v draws %d", got, draws, tc.Expected.Value, tc.Expected.Draws)
			}
		})
	}
	longest := 0
	for i, tc := range fixture.Walks {
		t.Run(fmt.Sprintf("walk-%d", i), func(t *testing.T) {
			draws := 0
			rng := oracleRNG(tc.Seed, &draws)
			trace := []string{}
			walk := NewCatchWalk()
			hooks := CatchHooks{Enter: func() (bool, error) {
				threshold := 0.
				if tc.Missing {
					threshold = .2
				}
				ok := rng() >= threshold
				if ok {
					trace = append(trace, "enter")
				} else {
					trace = append(trace, "missing")
				}
				return ok, nil
			}, Leave: func() error { trace = append(trace, "leave"); return nil }}
			for !walk.Done() {
				if _, err := walk.Advance(context.Background(), 3, tc.A, 0, rng, hooks); err != nil {
					t.Fatal(err)
				}
				// Verify serialization can suspend at any traversal boundary.
				raw, _ := json.Marshal(walk)
				if err := json.Unmarshal(raw, &walk); err != nil {
					t.Fatal(err)
				}
			}
			if !reflect.DeepEqual(trace, tc.Expected.Value) || draws != tc.Expected.Draws {
				t.Fatalf("trace/draw mismatch: %v (%d), expected %v (%d)", trace, draws, tc.Expected.Value, tc.Expected.Draws)
			}
			longest = max(longest, len(trace))
		})
	}
	if longest <= 6 {
		t.Fatal("fixtures never exercise more than three catches")
	}
}

func TestCatchWalkLongChainAndCancellation(t *testing.T) {
	// A 20,000-level one-child chain proves this does not use Go recursion or
	// truncate total catches. Each entry makes exactly one child until the leaf.
	const depth = 20000
	entries, leaves, draw := 0, 0, 0
	w := NewCatchWalk()
	rng := func() float64 {
		draw++
		if entries < depth && draw%2 == 1 {
			return 0
		}
		return .99
	}
	hooks := CatchHooks{Enter: func() (bool, error) { entries++; return true, nil }, Leave: func() error { leaves++; return nil }}
	for !w.Done() {
		if _, err := w.Advance(context.Background(), 127, 100, 0, rng, hooks); err != nil {
			t.Fatal(err)
		}
	}
	if entries != depth || leaves != depth {
		t.Fatalf("truncated %d/%d", entries, leaves)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w = NewCatchWalk()
	if _, err := w.Advance(ctx, 1, 100, 0, rng, hooks); err != context.Canceled {
		t.Fatal(err)
	}
	seed := []byte("fixed private fixture seed")
	all := Stream(seed, "test")
	var cursor uint64
	first := StreamAt(seed, "test", &cursor)
	for i := 0; i < 10; i++ {
		if all() != first() {
			t.Fatal("prefix drift")
		}
	}
	resumed := StreamAt(seed, "test", &cursor)
	for i := 0; i < 10; i++ {
		if all() != resumed() {
			t.Fatal("resume drift")
		}
	}
}
