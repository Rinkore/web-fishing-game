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

func TestIntegrationLegacyRodRoutes(t *testing.T) {
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

	code, reg := do("POST", "/api/register", `{"username":"legacy_rodroutes","password":"Synthetic-Pass42","qq":"123456","name":"RodRoutes"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	// Fund the account so the slot purchase can settle.
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "fund", Reason: "reward", RuleVersion: "test-v1", Coins: 1000000}); err != nil {
		t.Fatal(err)
	}
	// Buy a second rod slot; the first is free.
	code, bought := do("POST", "/api/rod/slot/buy", "{}", token)
	if code != 200 || bought["ok"] != true || bought["price"] != float64(10000) || bought["rodSlotsCount"] != float64(2) {
		t.Fatalf("rod slot buy: %d %v", code, bought)
	}
	if bought["nextRodSlotPrice"] != float64(50000) {
		t.Fatalf("rod slot next price: %v", bought["nextRodSlotPrice"])
	}

	// Create one rod component and equip it.
	signature := "rod_bamboo#common#"
	base, _, _, _ := c.Instance(signature)
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "gear", Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}}}); err != nil {
		t.Fatal(err)
	}
	if code, _ := do("POST", "/api/bd/set", `{"part":"rod","compId":"`+signature+`"}`, token); code != 200 {
		t.Fatalf("bd set failed: %d", code)
	}

	// Name the current assembly, save it to slot 0, then use it again.
	code, named := do("POST", "/api/rod/name", `{"name":"第一竿"}`, token)
	if code != 200 || named["ok"] != true || named["rodName"] != "第一竿" {
		t.Fatalf("rod name: %d %v", code, named)
	}
	code, saved := do("POST", "/api/rod/save", `{"slot":0}`, token)
	if code != 200 || saved["ok"] != true || saved["slot"] != float64(0) || saved["rodActiveSlot"] != float64(0) {
		t.Fatalf("rod save: %d %v", code, saved)
	}
	slots := saved["rodSlots"].([]any)
	if slots[0] == nil || slots[0].(map[string]any)["name"] != "第一竿" {
		t.Fatalf("rod slots view: %v", slots[0])
	}
	// Legacy imports with a saved active rod do not create an unsaved slot.
	// Replacing a component must lazily create that slot without activating it.
	if _, err := db.Admin.Exec(context.Background(), `DELETE FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=-1`, session.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "replacement", Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}}}); err != nil {
		t.Fatal(err)
	}
	code, replaced := do("POST", "/api/bd/set", `{"part":"rod","compId":"`+signature+`"}`, token)
	if code != 200 || replaced["ok"] != true || replaced["rodActiveSlot"] != float64(0) {
		t.Fatalf("replace imported saved rod component: %d %v", code, replaced)
	}
	if replaced["inventory"].(map[string]any)[signature] != float64(1) {
		t.Fatalf("replaced component was not returned to inventory: %v", replaced["inventory"])
	}
	code, renamed := do("POST", "/api/rod/rename", `{"slot":0,"name":"改名竿"}`, token)
	if code != 200 || renamed["rodName"] != "改名竿" {
		t.Fatalf("rod rename: %d %v", code, renamed)
	}
	code, stowed := do("POST", "/api/rod/stow", "{}", token)
	if code != 200 || stowed["ok"] != true || stowed["rodActiveSlot"] != float64(-1) {
		t.Fatalf("rod stow: %d %v", code, stowed)
	}
	code, used := do("POST", "/api/rod/use", `{"slot":0}`, token)
	if code != 200 || used["rodActiveSlot"] != float64(0) || used["rodName"] != "改名竿" {
		t.Fatalf("rod use: %d %v", code, used)
	}
	code, deleted := do("POST", "/api/rod/delete", `{"slot":0}`, token)
	if code != 200 || deleted["wasActive"] != true {
		t.Fatalf("rod delete: %d %v", code, deleted)
	}
}
