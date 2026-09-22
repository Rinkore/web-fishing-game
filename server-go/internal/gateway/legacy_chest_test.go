package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyChest(t *testing.T) {
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

	do := func(method, path, body, token string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
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

	code, reg := do("POST", "/api/register", `{"username":"legacy_chest","password":"Synthetic-Pass42","qq":"123456","name":"Chest"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	code, view := do("GET", "/api/chest", "", token)
	if code != 200 {
		t.Fatalf("chest view: %d %v", code, view)
	}
	chests := view["chests"].([]any)
	if len(chests) == 0 {
		t.Fatal("chest list empty")
	}
	first := chests[0].(map[string]any)
	if first["id"] == nil || first["name"] == nil || first["costRelic"] == nil || first["have"] == nil || first["pityNow"] == nil {
		t.Fatalf("chest entry: %v", first)
	}
	if view["relicId"] != "relic" || view["relicName"] == nil {
		t.Fatalf("chest relic info: %v", view)
	}

	// Crafting needs relics and coins.
	if code, _ := do("POST", "/api/chest/craft", `{"chestId":"chest_wreck","qty":1}`, token); code != 400 {
		t.Fatalf("craft without relics accepted: %d", code)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "chest-fund", Reason: "reward", RuleVersion: "test-v1", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "relic", Tier: "normal", Quantity: 40}}}); err != nil {
		t.Fatal(err)
	}
	code, crafted := do("POST", "/api/chest/craft", `{"chestId":"chest_wreck","qty":1}`, token)
	if code != 200 || crafted["ok"] != true || crafted["qty"] != float64(1) {
		t.Fatalf("chest craft: %d %v", code, crafted)
	}
	inv := crafted["inventory"].(map[string]any)
	if inv["chest_wreck"] != float64(1) {
		t.Fatalf("chest craft inventory: %v", inv)
	}

	code, opened := do("POST", "/api/chest/open", `{"chestId":"chest_wreck"}`, token)
	if code != 200 || opened["ok"] != true || opened["item"] == nil {
		t.Fatalf("chest open: %d %v", code, opened)
	}
	item := opened["item"].(map[string]any)
	if item["id"] == nil || item["name"] == nil || item["affixes"] == nil || item["breakthrough"] == nil {
		t.Fatalf("chest item: %v", item)
	}
	if code, _ := do("POST", "/api/chest/open", `{"chestId":"nope"}`, token); code != 400 {
		t.Fatalf("unknown chest accepted: %d", code)
	}
}
