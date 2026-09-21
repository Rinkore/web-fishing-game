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

func TestIntegrationLegacySea(t *testing.T) {
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

	code, reg := do("POST", "/api/register", `{"username":"legacy_sea","password":"Synthetic-Pass42","qq":"123456","name":"Sea"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	code, view := do("GET", "/api/sea", "", token)
	if code != 200 {
		t.Fatalf("sea view: %d %v", code, view)
	}
	ship := view["ship"].(map[string]any)
	if ship["lv"] != float64(1) || ship["name"] != "木划艇" || ship["xpOk"] != false {
		t.Fatalf("sea ship: %v", ship)
	}
	if view["chartCost"] != float64(3) || view["charts"] != float64(0) {
		t.Fatalf("sea charts: %v", view)
	}
	if _, ok := view["quests"].([]any); !ok {
		t.Fatalf("sea quests shape: %v", view["quests"])
	}
	if len(view["quests"].([]any)) == 0 {
		t.Fatal("sea quests empty")
	}
	cfg := view["cfg"].(map[string]any)
	if cfg["ship"] == nil || cfg["sea"] == nil {
		t.Fatalf("sea cfg: %v", cfg)
	}

	// Chart craft requires fragments.
	if code, _ := do("POST", "/api/sea/chart", "{}", token); code != 400 {
		t.Fatalf("chart without fragments accepted: %d", code)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "sea-frag", Reason: "reward", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: 3}, {ItemID: "deepscale", Tier: "normal", Quantity: 20}}, Coins: 500000}); err != nil {
		t.Fatal(err)
	}
	code, crafted := do("POST", "/api/sea/chart", "{}", token)
	if code != 200 || crafted["ok"] != true {
		t.Fatalf("chart craft: %d %v", code, crafted)
	}
	seaView := crafted["sea"].(map[string]any)
	if seaView["charts"] != float64(1) || seaView["chartfrag"] != float64(0) {
		t.Fatalf("chart craft view: %v", seaView)
	}

	// Voyage consumes a chart and creates a zone.
	code, voyaged := do("POST", "/api/sea/voyage", "{}", token)
	if code != 200 || voyaged["ok"] != true {
		t.Fatalf("voyage: %d %v", code, voyaged)
	}
	seaView = voyaged["sea"].(map[string]any)
	zones := seaView["zones"].([]any)
	if len(zones) != 1 {
		t.Fatalf("voyage zones: %v", zones)
	}
	zone := zones[0].(map[string]any)
	if zone["groundId"] != "sea:legacy_sea:"+zone["id"].(string) {
		t.Fatalf("zone groundId: %v", zone)
	}

	// Anchor extends the zone with coins and scales.
	code, anchored := do("POST", "/api/sea/anchor", `{"zoneId":"`+zone["id"].(string)+`"}`, token)
	if code != 200 || anchored["ok"] != true {
		t.Fatalf("anchor: %d %v", code, anchored)
	}
	seaView = anchored["sea"].(map[string]any)
	zone = seaView["zones"].([]any)[0].(map[string]any)
	if zone["anchors"] != float64(1) {
		t.Fatalf("anchor count: %v", zone)
	}

	// Unknown quest is rejected.
	if code, _ := do("POST", "/api/sea/quest/claim", `{"id":"q_nope"}`, token); code != 400 {
		t.Fatalf("unknown quest accepted: %d", code)
	}
}
