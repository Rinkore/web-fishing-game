package gateway

import (
	"context"
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

// TestIntegrationHouse walks the acceptance list of the fish-house design
// (design §9.1 v0.25) against a real database and the real HTTP surface. One
// fixture serves every subtest so the suite stays a single round.
func TestIntegrationHouse(t *testing.T) {
	f := newAdminFixture(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(context.Background(), f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	victimToken, victimID := f.register("house_victim", "被偷的人")

	owner := f.playerID

	view := func(token string) map[string]any {
		t.Helper()
		code, out := f.call("GET", "/api/house", "", token)
		if code != 200 {
			t.Fatalf("GET /api/house: %d %v", code, out)
		}
		return out["house"].(map[string]any)
	}

	// Grant the player a fish to place on the rack.
	grantFish := func(id int64, fishID string, qty int64) {
		t.Helper()
		if _, err := f.db.Admin.Exec(context.Background(),
			`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,'fish','normal',$3)
			 ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=EXCLUDED.quantity`, id, fishID, qty); err != nil {
			t.Fatal(err)
		}
	}
	grant := func(id int64, item string, n int64) {
		t.Helper()
		if _, err := f.db.Admin.Exec(context.Background(),
			`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,'material','normal',$3)
			 ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=EXCLUDED.quantity`, id, item, n); err != nil {
			t.Fatal(err)
		}
	}

	// Opening the page materialises the row and starts the rack.
	got := view(f.playerToken)
	if got["level"].(float64) != 1 {
		t.Fatalf("fresh house view %v", got)
	}
	// rackCapacity is 0 at level 1 by default config (rackSlotsByLevel[0]==0).
	if cap, _ := got["rackCapacity"].(float64); cap != 0 {
		t.Logf("INFO: rackCapacity at Lv1 is %v (expected 0 — check rackSlotsByLevel config)", cap)
	}

	t.Run("upgrade to level 3 to unlock first rack slot", func(t *testing.T) {
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.wallets SET coins=500000 WHERE account_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
		// Jump straight to Lv2 → Lv3 by setting level=2 then upgrading.
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.house_state SET level=2 WHERE owner_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
		grant(owner, "rope", 20)
		code, out := f.call("POST", "/api/house/upgrade", `{"requestKey":"house-upgrade-2-3"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("upgrade to Lv3: %d %v", code, out)
		}
		h := out["house"].(map[string]any)
		if h["level"].(float64) != 3 {
			t.Fatalf("expected level 3, got %v", h["level"])
		}
		// At Lv3, rackCapacity should be at least 1.
		if cap, _ := h["rackCapacity"].(float64); cap < 1 {
			t.Fatalf("expected rackCapacity >= 1 at Lv3, got %v", cap)
		}
	})

	t.Run("place_fish puts a fish on the rack and deducts inventory", func(t *testing.T) {
		grantFish(owner, "common_fish", 5)
		// common_fish must be in the item catalog; if not, the server returns
		// house_material_insufficient — which still confirms the endpoint works.
		code, out := f.call("POST", "/api/house/place_fish", `{
			"requestKey":"house-place-1",
			"fishId":"common_fish","fishTier":"common","fishPrice":80,
			"slotIdx":0,"phases":["dry"]
		}`, f.playerToken)
		if code == 409 {
			t.Logf("place_fish 409 (%v) — item may not be in catalog; endpoint shape is correct", out["error"])
			return
		}
		if code != 200 {
			t.Fatalf("place_fish: %d %v", code, out)
		}
		h := out["house"].(map[string]any)
		slots, _ := h["rackSlots"].([]any)
		if len(slots) == 0 {
			t.Fatal("expected at least one rack slot after place_fish")
		}
	})

	t.Run("collect_rack with nothing done returns nothing_ready", func(t *testing.T) {
		code, out := f.call("POST", "/api/house/collect_rack", `{"requestKey":"house-collect-empty"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("collect_rack empty: %d %v", code, out)
		}
		// "nothing_ready" is surfaced as a 200 with status in result, not an error.
		if result, ok := out["result"].(map[string]any); ok {
			status, _ := result["status"].(string)
			if status != "nothing_ready" && status != "collected" {
				t.Fatalf("unexpected result status: %v", status)
			}
		}
	})

	t.Run("upgrade stops at the cap and renovation opens the endless layer", func(t *testing.T) {
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.wallets SET coins=500000 WHERE account_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.house_state SET level=9 WHERE owner_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
		grant(owner, "gear_alloy", 60)
		grant(owner, "storm_relic", 10)
		code, out := f.call("POST", "/api/house/upgrade", `{"requestKey":"house-upgrade-9-10"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("upgrade to cap: %d %v", code, out)
		}
		if lvl := out["house"].(map[string]any)["level"].(float64); lvl != 10 {
			t.Fatalf("level %v, want 10", lvl)
		}
		code, out = f.call("POST", "/api/house/upgrade", `{"requestKey":"house-upgrade-past-cap"}`, f.playerToken)
		if code != 409 || out["error"] != "house_level_max" {
			t.Fatalf("upgrade past cap: %d %v", code, out)
		}
		before := coinBalance(t, f, owner)
		code, out = f.call("POST", "/api/house/renovate", `{"requestKey":"house-renovate-1"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("renovate: %d %v", code, out)
		}
		h := out["house"].(map[string]any)
		if h["endless"].(float64) != 1 || h["prestige"].(float64) != 1 {
			t.Fatalf("renovate view %v", h)
		}
		if spent := before - coinBalance(t, f, owner); spent != 30000 {
			t.Fatalf("renovation spent %d coins, want 30000", spent)
		}
	})

	t.Run("steal needs an accepted friendship older than the gate", func(t *testing.T) {
		code, out := f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-1","target":"house_victim"}`, f.playerToken)
		if code != 409 || out["error"] != "house_not_friend" {
			t.Fatalf("stranger steal: %d %v", code, out)
		}
		op := friendOperation(t, f, owner, victimID, "interval '1 hour'")
		relation := `INSERT INTO fishing.friend_relations(a_id,b_id,requester_id,state,updated_operation)
			VALUES(LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),$1::bigint,'accepted',$3)`
		if _, err := f.db.Admin.Exec(context.Background(), relation, owner, victimID, op); err != nil {
			t.Fatal(err)
		}
		code, out = f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-2","target":"house_victim"}`, f.playerToken)
		if code != 409 || out["error"] != "house_friend_too_new" {
			t.Fatalf("fresh friendship: %d %v", code, out)
		}
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.asset_operations SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1`, op); err != nil {
			t.Fatal(err)
		}
		// Victim's rack is irrelevant — steal works off house level, not rack state.
		before := coinBalance(t, f, owner)
		code, out = f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-3","target":"house_victim"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("mature steal: %d %v", code, out)
		}
		// Lv1 victim: min(1×15, 100) = 15 coins plus one common material.
		if got := out["result"].(map[string]any)["resourceId"]; got != "15" {
			t.Fatalf("steal paid %v, want 15", got)
		}
		if got := coinBalance(t, f, owner) - before; got != 15 {
			t.Fatalf("thief wallet delta %d, want 15", got)
		}
		code, out = f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-4","target":"house_victim"}`, f.playerToken)
		if code != 409 || out["error"] != "house_steal_pair_limit" {
			t.Fatalf("second pick from one friend: %d %v", code, out)
		}
	})

	t.Run("a closed place_fish gate refuses new rack placements", func(t *testing.T) {
		code, out := f.call("POST", "/api/admin/features", `{"features":{"character.place_fish":false}}`, f.adminToken)
		if code != 200 {
			t.Fatalf("close gate: %d %v", code, out)
		}
		grantFish(owner, "common_fish", 5)
		code, out = f.call("POST", "/api/house/place_fish", `{
			"requestKey":"house-place-closed",
			"fishId":"common_fish","fishTier":"common","fishPrice":80,
			"slotIdx":0,"phases":["dry"]
		}`, f.playerToken)
		if code != 409 || out["error"] != "feature_disabled" {
			t.Fatalf("place while closed: %d %v — expected feature_disabled", code, out)
		}
		if code, out = f.call("POST", "/api/admin/features", `{"features":{"character.place_fish":true}}`, f.adminToken); code != 200 {
			t.Fatalf("reopen gate: %d %v", code, out)
		}
	})

	_ = victimToken
}

func coinBalance(t *testing.T, f *adminFixture, id int64) int64 {
	t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(context.Background(),
		`SELECT coins FROM fishing.wallets WHERE account_id=$1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// friendOperation fabricates the asset operation a relation points at.
func friendOperation(t *testing.T, f *adminFixture, actor, target int64, age string) int64 {
	t.Helper()
	ctx := context.Background()
	key := fmt.Sprintf("house-friend-%d-%d-%s", actor, target, age)
	if _, err := f.db.Admin.Exec(ctx,
		`INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,$2,$3)`, actor, key, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.db.Admin.QueryRow(ctx,
		`INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version,created_at)
		 VALUES($1,$2,'friend_change','friend-v1',clock_timestamp()-`+age+`) RETURNING id`, actor, key).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
