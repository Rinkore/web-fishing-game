package gateway

import (
	"context"
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

// TestIntegrationHouse walks the acceptance list of the fish-house design
// (design §9.1) against a real database and the real HTTP surface. One fixture
// serves every subtest so the suite stays a single round.
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
	const collectKey = "house-collect-key-1"

	view := func(token string) map[string]any {
		t.Helper()
		code, out := f.call("GET", "/api/house", "", token)
		if code != 200 {
			t.Fatalf("GET /api/house: %d %v", code, out)
		}
		return out["house"].(map[string]any)
	}
	pending := func(token string) float64 { return view(token)["pending"].(float64) }
	coins := func(id int64) int64 {
		t.Helper()
		var n int64
		if err := f.db.Admin.QueryRow(context.Background(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	ageClocks := func(id int64, window string) {
		t.Helper()
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.house_state SET settled_at=clock_timestamp()-`+window+`,enabled_at=clock_timestamp()-`+window+` WHERE owner_id=$1`, id); err != nil {
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

	// Opening the page materialises the row and starts the pond.
	if got := view(f.playerToken); got["level"].(float64) != 1 || got["capacityHours"].(float64) != 8 {
		t.Fatalf("fresh house view %v", got)
	}

	var baseline int64
	t.Run("collect caps the offline window at the pond capacity", func(t *testing.T) {
		baseline = coins(owner)
		ageClocks(owner, "interval '30 days'")
		code, out := f.call("POST", "/api/house/collect", `{"requestKey":"`+collectKey+`"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("collect 30 days: %d %v", code, out)
		}
		// rate(Lv1)=45, capacity=8h, no bonus below Lv5 → 360, not 45×720.
		if got := out["result"].(map[string]any)["resourceId"]; got != "360" {
			t.Fatalf("a three-week absence paid %v, want 360 (8h pond)", got)
		}
		if got := coins(owner) - baseline; got != 360 {
			t.Fatalf("wallet delta %d, want 360", got)
		}
		if got := pending(f.playerToken); got != 0 {
			t.Fatalf("pond not emptied: %v", got)
		}
	})

	t.Run("replaying one request key pays once", func(t *testing.T) {
		before := coins(owner)
		code, out := f.call("POST", "/api/house/collect", `{"requestKey":"`+collectKey+`"}`, f.playerToken)
		if code != 200 || out["result"].(map[string]any)["resourceId"] != "360" {
			t.Fatalf("replay: %d %v", code, out)
		}
		if got := coins(owner) - before; got != 0 {
			t.Fatalf("replay paid twice: %d", got)
		}
	})

	t.Run("collections are unlimited per day and never hard-capped", func(t *testing.T) {
		before := coins(owner)
		for i := 0; i < 4; i++ {
			ageClocks(owner, "interval '8 hours'")
			key := fmt.Sprintf("house-collect-daily-%d", i)
			code, out := f.call("POST", "/api/house/collect", `{"requestKey":"`+key+`"}`, f.playerToken)
			if code != 200 {
				t.Fatalf("collect #%d: %d %v", i+1, code, out)
			}
			if got := out["result"].(map[string]any)["resourceId"]; got != "360" {
				t.Fatalf("collect #%d paid %v, want 360 (time is the only limit)", i+1, got)
			}
		}
		if got := coins(owner) - before; got != 4*360 {
			t.Fatalf("four collections paid %d, want %d", got, 4*360)
		}
	})

	t.Run("upgrade stops at the cap and renovation opens the endless layer", func(t *testing.T) {
		if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.wallets SET coins=500000 WHERE account_id=$1`, owner); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.house_state SET level=9 WHERE owner_id=$1`, owner); err != nil {
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
		before := coins(owner)
		code, out = f.call("POST", "/api/house/renovate", `{"requestKey":"house-renovate-1"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("renovate: %d %v", code, out)
		}
		house := out["house"].(map[string]any)
		if house["endless"].(float64) != 1 || house["prestige"].(float64) != 1 {
			t.Fatalf("renovate view %v", house)
		}
		if house["rate"].(float64) <= 98 {
			t.Fatalf("endless layer did not raise the rate: %v", house["rate"])
		}
		if spent := before - coins(owner); spent != 30000 {
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
		// The victim's own pond must survive the theft untouched.
		if _, err := f.db.Admin.Exec(context.Background(),
			`UPDATE fishing.house_state SET settled_at=clock_timestamp()-interval '8 hours',enabled_at=clock_timestamp()-interval '8 hours' WHERE owner_id=$1`, victimID); err != nil {
			t.Fatal(err)
		}
		pool := pending(victimToken)
		before := coins(owner)
		code, out = f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-3","target":"house_victim"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("mature steal: %d %v", code, out)
		}
		// Lv1 victim: min(1×15, 100) = 15 coins plus one common material.
		if got := out["result"].(map[string]any)["resourceId"]; got != "15" {
			t.Fatalf("steal paid %v, want 15", got)
		}
		if got := coins(owner) - before; got != 15 {
			t.Fatalf("thief wallet delta %d, want 15", got)
		}
		if got := pending(victimToken); got != pool {
			t.Fatalf("victim pond changed by theft: %v → %v", pool, got)
		}
		code, out = f.call("POST", "/api/house/steal", `{"requestKey":"house-steal-4","target":"house_victim"}`, f.playerToken)
		if code != 409 || out["error"] != "house_steal_pair_limit" {
			t.Fatalf("second pick from one friend: %d %v", code, out)
		}
	})

	t.Run("a closed collect gate never back-pays the paused window", func(t *testing.T) {
		ageClocks(owner, "interval '8 hours'")
		code, out := f.call("POST", "/api/admin/features", `{"features":{"character.collect":false}}`, f.adminToken)
		if code != 200 {
			t.Fatalf("close gate: %d %v", code, out)
		}
		var fresh bool
		if err := f.db.Admin.QueryRow(context.Background(),
			`SELECT settled_at>clock_timestamp()-interval '1 minute' AND enabled_at>clock_timestamp()-interval '1 minute' FROM fishing.house_state WHERE owner_id=$1`, owner).Scan(&fresh); err != nil {
			t.Fatal(err)
		}
		if !fresh {
			t.Fatal("closing the gate did not roll the accrual clocks forward")
		}
		code, out = f.call("POST", "/api/house/collect", `{"requestKey":"house-collect-closed"}`, f.playerToken)
		if code != 409 || out["error"] != "feature_disabled" {
			t.Fatalf("collect while closed: %d %v", code, out)
		}
		if code, out = f.call("POST", "/api/admin/features", `{"features":{"character.collect":true}}`, f.adminToken); code != 200 {
			t.Fatalf("reopen gate: %d %v", code, out)
		}
		code, out = f.call("POST", "/api/house/collect", `{"requestKey":"house-collect-reopened"}`, f.playerToken)
		if code != 200 {
			t.Fatalf("collect after reopen: %d %v", code, out)
		}
		if got := out["result"].(map[string]any)["resourceId"]; got != "0" {
			t.Fatalf("reopening paid %v for the paused window, want 0", got)
		}
	})
}

// friendOperation fabricates the asset operation a relation points at, so the
// 24h maturity rule can be exercised without waiting a day.
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
