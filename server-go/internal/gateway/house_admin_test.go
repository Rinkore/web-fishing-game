package gateway

import (
	"testing"

	"fishing.local/server/internal/rules"
)

// TestHouseInvariantsMissingHutSection pins the production incident: the live
// catalog may still point at a release published before the HUT section
// existed, so HutConfig reports a zero value and the level-curve lookups used
// to walk off the slice. The console must get badges, not a dropped request.
func TestHouseInvariantsMissingHutSection(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	delete(c.Constants, "HUT")
	if len(c.HutConfig().Levels) > 0 {
		// The catalog layer already backfills built-in defaults for an absent
		// section, so emulate the same shape with an explicitly empty one.
		c.Constants["HUT"] = rules.HutConfig{}.Raw()
	}
	if len(c.HutConfig().Levels) > 0 {
		t.Fatal("precondition: want an empty HUT level curve")
	}

	rows := houseInvariants(c)
	if len(rows) == 0 {
		t.Fatal("empty HUT section rendered no invariants")
	}
	bad := 0
	for _, row := range rows {
		for _, field := range []string{"name", "ok", "detail"} {
			if row[field] == nil {
				t.Fatalf("invariant row %v is missing %q", row, field)
			}
		}
		if ok, _ := row["ok"].(bool); !ok {
			bad++
		}
	}
	if bad == 0 {
		t.Fatalf("empty HUT section reported as healthy: %v", rows)
	}
}

// TestHouseInvariantsDefaultCatalog keeps the badges honest for a healthy
// catalog: the built-in ruleset the operator console ships with must pass.
func TestHouseInvariantsDefaultCatalog(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.HutConfig().Levels) == 0 {
		t.Fatal("precondition: default catalog has no HUT level curve")
	}
	for _, row := range houseInvariants(c) {
		if ok, _ := row["ok"].(bool); !ok {
			t.Fatalf("default catalog invariant failed: %v", row)
		}
	}
}
