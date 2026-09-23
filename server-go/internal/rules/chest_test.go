package rules

import (
	"strings"
	"testing"
)

func TestChestBreakthroughCrossesNaturalPartPool(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	chest, ok := c.Chest("chest_king")
	if !ok {
		t.Fatal("missing breakthrough chest")
	}
	for _, base := range c.Items {
		if base.Kind != "component" || base.Legacy || base.SetID != "" || base.Part == "" || strings.HasPrefix(base.ID, "gear_") {
			continue
		}
		t.Run(base.ID, func(t *testing.T) {
			for _, forced := range []bool{false, true} {
				signature, ok := c.OpenChest(chest, "", base.ID, c.ComponentConfig(), forced, func() float64 { return .9 })
				if !ok {
					t.Fatal("open rejected")
				}
				_, quality, affixes, ok := c.Instance(signature)
				want := chest.MissCount
				if forced {
					want = chest.HitCount
				}
				if !ok || quality != "mythic" || len(affixes) != want {
					t.Fatalf("forced=%v: %s, want %d affixes", forced, signature, want)
				}
				seen := map[string]bool{}
				for _, a := range affixes {
					if seen[a.Type] {
						t.Fatalf("duplicate affix: %s", signature)
					}
					seen[a.Type] = true
					if !c.AffixAllowed(base.Part, a.Type) && (!a.Explicit || a.Source != "bt") {
						t.Fatalf("cross-part affix lost breakthrough source: %s", signature)
					}
				}
			}
		})
	}
}
