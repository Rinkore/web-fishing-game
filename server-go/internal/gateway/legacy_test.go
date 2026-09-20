package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyProfileShape(t *testing.T) {
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(context.Background(), db.Admin, c); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second

	request := func(method, path, body, cookie string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, value
	}

	code, value := request("POST", "/api/register", `{"username":"legacy_profile","password":"Synthetic-Pass42","qq":"123456","name":"Legacy"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, value)
	}
	// Registration defaults to Bearer mode; use the returned token directly.
	token := value["token"].(string)
	svc := identity.New(db.App, nil)
	session, err := svc.Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	// Seed fish across all three tiers plus one material, and codex entries.
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: session.AccountID, RequestKey: "seed-fish", Reason: "reward", RuleVersion: "test-v1",
		Stacks: []assets.StackDelta{
			{ItemID: "crucian", Tier: "normal", Quantity: 3},
			{ItemID: "crucian", Tier: "large", Quantity: 2},
			{ItemID: "crucian", Tier: "giant", Quantity: 1},
			{ItemID: "bait_pack", Tier: "normal", Quantity: 5},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at,min_size,max_size,best_tier) VALUES($1,'crucian',6,clock_timestamp(),12,48,'large')`, session.AccountID); err != nil {
		t.Fatal(err)
	}

	get := func(path string) (int, map[string]any) {
		r, err := http.NewRequest("GET", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+token)
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, value
	}

	code, profile := get("/api/me")
	if code != 200 {
		t.Fatalf("legacy me: %d", code)
	}
	if profile["username"] != "legacy_profile" || profile["name"] != "Legacy" || profile["coins"] != float64(500) {
		t.Fatalf("identity fields: %v", profile)
	}
	if profile["catchCount"] != float64(0) {
		t.Fatalf("catchCount: %v", profile["catchCount"])
	}
	if profile["listingCap"] != float64(40) {
		t.Fatalf("listingCap: %v", profile["listingCap"])
	}
	inv := profile["inventory"].(map[string]any)
	if inv["crucian"] != float64(6) || inv["bait_pack"] != float64(5) {
		t.Fatalf("inventory flattening: %v", inv)
	}
	bf := profile["bigfish"].(map[string]any)
	crucian := bf["crucian"].(map[string]any)
	if crucian["L"] != float64(2) || crucian["G"] != float64(1) {
		t.Fatalf("bigfish split: %v", crucian)
	}
	codex := profile["codex"].(map[string]any)
	entry := codex["crucian"].(map[string]any)
	if entry["count"] != float64(6) || entry["tier"] != "L" || entry["max"] != float64(48) || entry["min"] != float64(12) {
		t.Fatalf("codex mapping: %v", entry)
	}
	if profile["rodSlotsCount"] != float64(1) || profile["rodSlotsMax"] != float64(8) || profile["rodActiveSlot"] != float64(-1) {
		t.Fatalf("rod defaults: %v", profile)
	}
	if profile["nextRodSlotPrice"] != float64(10000) || profile["freeRodSlots"] != float64(0) {
		t.Fatalf("rod pricing: %v", profile)
	}

	code, ver := get("/api/version")
	if code != 200 || ver["version"] == nil || ver["version"] == "" {
		t.Fatalf("legacy version: %d %v", code, ver)
	}
}
