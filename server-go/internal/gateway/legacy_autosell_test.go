package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyAutoSellPreservesInactiveNoSellRules(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	before := f.coins(f.playerID)
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('tide_sand','material') ON CONFLICT(id) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'tide_sand','material','normal',10)`, f.playerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,rules) VALUES($1,'{"tide_sand":{"on":true,"keep":0,"slackPct":0,"slackPrice":0}}') ON CONFLICT(owner_id) DO UPDATE SET rules=excluded.rules`, f.playerID); err != nil {
		t.Fatal(err)
	}
	code, body := f.player("GET", "/api/autosell", "")
	f.expect(code, body, 200, "")
	plan := body["plan"].(map[string]any)
	if plan["pool"] != float64(0) || plan["ready"] != float64(0) || plan["blocked"] != float64(0) {
		t.Fatal("unsellable inventory appeared in automatic sale preview")
	}
	code, body = f.player("POST", "/api/autosell", `{"id":"crucian","on":true,"keep":2}`)
	f.expect(code, body, 200, "")
	code, body = f.player("POST", "/api/autosell", `{"bulk":"all","on":false}`)
	f.expect(code, body, 200, "")
	if body["items"].(map[string]any)["tide_sand"].(map[string]any)["on"] != true {
		t.Fatal("bulk action changed an imported unsellable rule")
	}
	code, body = f.player("POST", "/api/autosell", `{"id":"tide_sand","on":false}`)
	f.expect(code, body, 200, "")
	if body["items"].(map[string]any)["tide_sand"].(map[string]any)["on"] != false {
		t.Fatal("old unsellable rule could not be disabled")
	}
	for _, request := range []string{`{"id":"tide_sand","on":true}`, `{"id":"dragon_scale","on":false}`, `{"id":"dragon_scale","keep":0}`} {
		code, body = f.player("POST", "/api/autosell", request)
		f.expect(code, body, 400, "")
	}
	code, body = f.player("POST", "/api/autosell", `{"id":"tide_sand","remove":true}`)
	f.expect(code, body, 200, "")
	if _, exists := body["items"].(map[string]any)["tide_sand"]; exists {
		t.Fatal("old unsellable rule could not be removed")
	}
	var quantity int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='tide_sand'`, f.playerID).Scan(&quantity); err != nil {
		t.Fatal(err)
	}
	if quantity != 10 || f.coins(f.playerID) != before {
		t.Fatal("settings compatibility changed player assets")
	}
}

func TestIntegrationLegacyAutoSell(t *testing.T) {
	db := testdb.New(t, true)
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

	code, reg := do("POST", "/api/register", `{"username":"legacy_autosell","password":"Synthetic-Pass42","qq":"123456","name":"Auto"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)

	code, view := do("GET", "/api/autosell", "", token)
	if code != 200 || view["ok"] != true || view["items"] == nil || view["batch"] == nil || view["tier"] != false {
		t.Fatalf("autosell view: %d %v", code, view)
	}
	if view["plan"] == nil {
		t.Fatalf("autosell view missing plan: %v", view)
	}

	// Create a rule for crucian with a keep floor and no price gate.
	code, set := do("POST", "/api/autosell", `{"id":"crucian","on":true,"keep":2}`, token)
	if code != 200 || set["ok"] != true {
		t.Fatalf("autosell set: %d %v", code, set)
	}
	items := set["items"].(map[string]any)
	rule := items["crucian"].(map[string]any)
	if rule["on"] != true || rule["keep"] != float64(2) {
		t.Fatalf("autosell rule: %v", rule)
	}

	// Toggle must keep the existing thresholds.
	code, toggled := do("POST", "/api/autosell", `{"id":"crucian","on":false}`, token)
	if code != 200 {
		t.Fatalf("autosell toggle: %d %v", code, toggled)
	}
	rule = toggled["items"].(map[string]any)["crucian"].(map[string]any)
	if rule["on"] != false || rule["keep"] != float64(2) {
		t.Fatalf("autosell toggle kept thresholds: %v", rule)
	}

	// Tier switch request has its own shape.
	code, tier := do("POST", "/api/autosell", `{"tier":true}`, token)
	if code != 200 || tier["tier"] != true {
		t.Fatalf("autosell tier: %d %v", code, tier)
	}

	// Bulk scope must reject unknown scopes.
	if code, _ := do("POST", "/api/autosell", `{"bulk":"bogus"}`, token); code != 400 {
		t.Fatalf("autosell bad bulk accepted: %d", code)
	}
}
