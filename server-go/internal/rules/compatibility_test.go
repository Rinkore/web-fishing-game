package rules

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNodeOracles(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"legacy-rules.json", "native-rules.json", "economy-rules.json", "workshop-rules.json", "mall-rules.json", "chest-rules.json", "sea-rules.json"} {
		data, err := os.ReadFile("../../testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		var fixture struct {
			Version string `json:"version"`
			Cases   []struct {
				ID       string            `json:"id"`
				Function string            `json:"fn"`
				Args     []json.RawMessage `json:"args"`
				Expected any               `json:"expected"`
			} `json:"cases"`
		}
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatal(err)
		}
		// These snapshots were captured from the retired legacy server server. Keep their
		// original provenance while testing the current implementation against them.
		expectedVersion := c.Version
		if name == "legacy-rules.json" || name == "economy-rules.json" || name == "sea-rules.json" {
			expectedVersion = "v0.21.4"
		}
		if fixture.Version != expectedVersion {
			t.Fatal("catalog/oracle version mismatch")
		}
		for _, tc := range fixture.Cases {
			t.Run(name+"/"+tc.ID, func(t *testing.T) {
				var args []any
				for _, raw := range tc.Args {
					var v any
					if err := json.Unmarshal(raw, &v); err != nil {
						t.Fatal(err)
					}
					args = append(args, v)
				}
				var got any
				switch tc.Function {
				case "voyageZone":
					n, seed := 0, int(Number(args[1]))
					rng := func() float64 { v := float64((n*37+seed)%101) / 101; n++; return v }
					zone := c.VoyageZone(int64(Number(args[0])), rng)
					got = map[string]any{"zone": zone, "draws": n}
				case "seaQuests":
					n, seed := 0, int(Number(args[0]))
					rng := func() float64 { v := float64((n*37+seed)%101) / 101; n++; return v }
					quests := c.RollSeaQuests(rng)
					ids := []string{}
					for _, q := range quests {
						ids = append(ids, q.ID)
					}
					got = map[string]any{"ids": ids, "draws": n}
				case "chest":
					ch, ok := c.Chest(args[0].(string))
					if !ok {
						t.Fatal("chest missing")
					}
					n, seed := 0, int(Number(args[4]))
					rng := func() float64 { v := float64((n*37+seed)%101) / 101; n++; return v }
					id, ok := c.OpenChest(ch, args[1].(string), args[2].(string), c.ComponentConfig(), args[3].(bool), rng)
					if !ok {
						t.Fatal("chest failed")
					}
					got = map[string]any{"id": id, "draws": n}
				case "mallCycle":
					location, err := time.LoadLocation(args[2].(string))
					if err != nil {
						t.Fatal(err)
					}
					got = MallCycleOf(args[0].(string), time.UnixMilli(int64(Number(args[1]))).In(location))
				case "smelt":
					var in SmeltInput
					if err := json.Unmarshal(tc.Args[0], &in); err != nil {
						t.Fatal(err)
					}
					p, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
					if err != nil {
						t.Fatal(err)
					}
					n := 0
					seed := int(Number(args[1]))
					rng := func() float64 { v := float64((n*37+seed)%101) / 101; n++; return v }
					out := p.Roll(rng)
					got = map[string]any{"outcome": out, "draws": n, "gold": p.Gold, "rate": p.Rate, "extraRate": p.ExtraRate, "retainChance": p.RetainChance}
				case "recast":
					n := 0
					rng := func() float64 { v := float64((n*37+13)%101) / 101; n++; return v }
					id, pearls, gold, err := c.Recast(args[0].(string), int(Number(args[1])), c.ComponentConfig(), c.WorkshopConfig(), rng)
					if err != nil {
						t.Fatal(err)
					}
					got = map[string]any{"id": id, "draws": n, "pearls": pearls, "gold": gold}
				case "castInfoOf":
					var bd map[string]struct {
						CompID string `json:"compId"`
					}
					var spot Spot
					var input map[string]any
					if err := json.Unmarshal(tc.Args[0], &bd); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(tc.Args[1], &spot); err != nil {
						t.Fatal(err)
					}
					if err := json.Unmarshal(tc.Args[2], &input); err != nil {
						t.Fatal(err)
					}
					got = c.CastRules(input).Info(c.RodEffects(bd), spot)
				case "doubleProbOf":
					got = DoubleProbability(args[0], args[1])
				case "multiplier":
					var s SaleState
					var dyn PriceDynamics
					_ = json.Unmarshal(tc.Args[0], &s)
					_ = json.Unmarshal(tc.Args[2], &dyn)
					got = CurrentMultiplier(s, int64(Number(args[1])), dyn)
				case "autosell":
					var input []AutoSellInput
					_ = json.Unmarshal(tc.Args[0], &input)
					p := c.PlanAutoSell(input, args[1].(bool), int64(Number(args[2])))
					quantities := []map[string]any{}
					for _, x := range input {
						var n int64
						for _, part := range p.Parts {
							if part.ID == x.ID {
								n += part.Quantity
							}
						}
						if n > 0 {
							quantities = append(quantities, map[string]any{"id": x.ID, "quantity": n})
						}
					}
					got = map[string]any{"pool": p.Pool, "blocked": p.Blocked, "batch": p.Batch, "quantities": quantities}
				case "boost":
					var pool []LootEntry
					var groups map[string][]LootEntry
					var eff Effects
					var drop map[string]float64
					_ = json.Unmarshal(tc.Args[0], &pool)
					_ = json.Unmarshal(tc.Args[1], &groups)
					_ = json.Unmarshal(tc.Args[2], &eff)
					_ = json.Unmarshal(tc.Args[3], &drop)
					cfg := c.DefaultLootConfig()
					cfg.Global = drop["global"]
					cfg.Common = drop["common"]
					cfg.Big = drop["big"]
					cfg.Rare = drop["rare"]
					cfg.Material = drop["material"]
					var err error
					got, err = c.BoostPool(pool, groups, eff, cfg)
					if err != nil {
						t.Fatal(err)
					}
				case "pick":
					var pool []LootEntry
					_ = json.Unmarshal(tc.Args[0], &pool)
					n := 0
					draws := args[1].([]any)
					rng := func() float64 {
						if n >= len(draws) {
							t.Fatal("extra loot draw")
						}
						v := Number(draws[n])
						n++
						return v
					}
					pick := PickLoot(pool, rng)
					got = map[string]any{"pick": pick, "draws": n}
				case "generate", "breakthrough":
					n := 0
					rng := func() float64 { v := float64((n*37+13)%101) / 101; n++; return v }
					var id string
					var ok bool
					if tc.Function == "generate" {
						var opts GenerateOptions
						if err := json.Unmarshal(tc.Args[2], &opts); err != nil {
							t.Fatal(err)
						}
						id, ok = c.Generate(args[0].(string), args[1].(string), c.ComponentConfig(), opts, rng)
					} else {
						id, ok = c.Breakthrough(args[0].(string), c.ComponentConfig(), BreakthroughOptions{}, rng)
					}
					if !ok {
						t.Fatal("generation rejected")
					}
					got = map[string]any{"id": id, "draws": n}
				case "rareCommonMult":
					got = RareCommonMultiplier(Number(args[0]), Number(args[1]))
				case "number":
					got = jsonFloat(Number(args[0]))
				case "expression":
					e, err := Compile(args[0].(string), SimulationVariables)
					if err != nil {
						got = map[string]any{"ok": false}
					} else {
						v := map[string]float64{}
						for k, n := range args[1].(map[string]any) {
							v[k] = Number(n)
						}
						got = map[string]any{"ok": true, "value": jsonFloat(e.Eval(v))}
					}
				case "fishRatio", "affix", "boundary":
					draws := args[1].([]any)
					n := 0
					rng := func() float64 {
						if n >= len(draws) {
							t.Fatal("too many random draws")
						}
						v := Number(draws[n])
						n++
						return v
					}
					model := args[0].(string)
					v := 0.0
					switch tc.Function {
					case "fishRatio":
						v = FishRatio(model, []float64{0, 10, 0, 10, 0, 10, 0, 10, 0, 10}, rng)
					case "affix":
						v = RollAffix(-1, 1, model, rng)
					case "boundary":
						v = RollBoundary(-1, 1, model, rng)
					}
					got = map[string]any{"value": v, "draws": n}
				default:
					t.Fatalf("unhandled oracle %s", tc.Function)
				}
				normalized, err := json.Marshal(got)
				if err != nil {
					t.Fatal(err)
				}
				var parsed any
				if err := json.Unmarshal(normalized, &parsed); err != nil {
					t.Fatal(err)
				}
				if !equalJSON(parsed, tc.Expected) {
					t.Fatalf("got %s; want %#v", normalized, tc.Expected)
				}
			})
		}
	}
}
func jsonFloat(f float64) any {
	if !finite(f) {
		return nil
	}
	return f
}
func equalJSON(a, b any) bool {
	if x, ok := a.([]any); ok {
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !equalJSON(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	if x, ok := a.(float64); ok {
		y, ok := b.(float64)
		return ok && math.Abs(x-y) <= 1e-12*math.Max(1, math.Abs(y))
	}
	if x, ok := a.(map[string]any); ok {
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !equalJSON(v, w) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}
func TestExpressionLimits(t *testing.T) {
	for _, src := range []string{strings.Repeat("(", 100) + "1" + strings.Repeat(")", 100), strings.Repeat("1+", 600) + "1", strings.Repeat(" ", 5000) + "1", "constructor(1)", "process.exit()"} {
		if _, err := Compile(src, nil); err == nil {
			t.Fatal("accepted unbounded/unsafe expression")
		}
	}
}
func TestRounding(t *testing.T) {
	if !math.Signbit(Round(-.5)) || Round(-1.5) != -1 || Round(4503599627370495.5) != 4503599627370496 {
		t.Fatal("JS rounding mismatch")
	}
}
func TestCatalogOwnership(t *testing.T) {
	a, _ := Default()
	b, _ := Default()
	a.Constants["VERSION"] = json.RawMessage(`"bad"`)
	var v string
	if err := b.Constant("VERSION", &v); err != nil || v == "" || v != b.Version {
		t.Fatal("shared mutable catalog")
	}
	counts := map[string]int{}
	for _, i := range b.Items {
		counts[i.Kind]++
	}
	if counts["fish"] != 51 || counts["material"] != 20 {
		t.Fatalf("incomplete catalog: %v", counts)
	}
}
