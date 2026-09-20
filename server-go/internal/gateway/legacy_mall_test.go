package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyMall(t *testing.T) {
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

	code, reg := do("POST", "/api/register", `{"username":"legacy_mall","password":"Synthetic-Pass42","qq":"123456","name":"Mall"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	if _, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false); err != nil {
		t.Fatal(err)
	}

	code, view := do("GET", "/api/mall", "", token)
	if code != 200 || view["ok"] != true || view["cycleKey"] == nil || view["refreshTime"] == nil {
		t.Fatalf("mall view: %d %v", code, view)
	}
	items := view["items"].([]any)
	if len(items) == 0 {
		t.Fatal("mall items empty")
	}
	first := items[0].(map[string]any)
	itemID, _ := first["id"].(string)
	if itemID == "" || first["name"] == "" || first["price"] == nil || first["have"] == nil {
		t.Fatalf("mall item shape: %v", first)
	}
	if view["coins"] != float64(500) {
		t.Fatalf("mall coins: %v", view["coins"])
	}

	code, bought := do("POST", "/api/mall/buy", `{"id":"`+itemID+`","qty":1}`, token)
	if code != 200 || bought["ok"] != true || bought["qty"] != float64(1) || bought["cost"] == nil {
		t.Fatalf("mall buy: %d %v", code, bought)
	}
	inv := bought["inventory"].(map[string]any)
	if inv[itemID] != float64(1) {
		t.Fatalf("mall buy inventory: %v", inv)
	}
	if bought["mall"] == nil {
		t.Fatal("mall buy missing refreshed view")
	}
}
