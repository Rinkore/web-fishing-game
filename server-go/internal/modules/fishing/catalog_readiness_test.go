package fishing

import (
	"errors"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

// A schema-ready database can accept registrations and fishing starts without
// containing the definitions required to award the first catch. Exercise both
// the fish-record foreign key and the material inventory rejection paths.
func TestIntegrationMissingDefinitionsBlockFirstCatchUntilRestored(t *testing.T) {
	for _, item := range []struct {
		id, kind string
		failure  error
	}{
		{"crucian", "fish", assets.ErrUnavailable},
		{"rope", "material", assets.ErrDeferred},
	} {
		t.Run(item.kind, func(t *testing.T) {
			f := nativeSetup(t)
			f.spot([]rules.LootEntry{{Pick: item.kind + ":" + item.id, Weight: 1}}, nil, 100)
			f.exec(`DELETE FROM fishing.item_definitions WHERE id=$1`, item.id)

			// Start succeeds despite the missing definition. The fixture fixes
			// the seed and makes the first cycle due without waiting on a timer.
			candidate := f.start()
			before := f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, f.owner)
			for attempt := 0; attempt < 2; attempt++ {
				_, err := f.s.Settle(f.ctx, candidate)
				if !errors.Is(err, item.failure) {
					t.Fatalf("missing definition: want %v, got %v", item.failure, err)
				}
			}
			for _, query := range []string{
				`SELECT count(*) FROM fishing.inventory_stacks`,
				`SELECT count(*) FROM fishing.catch_records`,
				`SELECT count(*) FROM fishing.native_fishing_settlements`,
			} {
				if f.num(query) != 0 {
					t.Fatal("failed first catch committed a partial reward")
				}
			}
			if f.num(`SELECT next_seq FROM fishing.native_fishing_sessions WHERE id=$1`, candidate.SessionID) != 1 ||
				f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, f.owner) != before {
				t.Fatal("failed first catch advanced the cycle or assets revision")
			}

			// Repair only the missing definition, as the explicit catalog
			// initialization command does. Retry exactly the original cycle.
			if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, f.s.catalog); err != nil {
				t.Fatal(err)
			}
			result, err := f.s.Settle(f.ctx, candidate)
			f.want(result, err, "settled")
			if f.num(`SELECT sum(quantity) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2`, f.owner, item.id) != 1 ||
				f.num(`SELECT caught FROM fishing.native_fishing_settlements WHERE session_id=$1 AND seq=1`, candidate.SessionID) != 1 {
				t.Fatal("restored definition did not recover the original first catch")
			}
			f.reconcile()
		})
	}
}
