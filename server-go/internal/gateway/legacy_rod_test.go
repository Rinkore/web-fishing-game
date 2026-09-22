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

func TestIntegrationLegacyBdSet(t *testing.T) {
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

	post := func(path, body, token string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
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

	code, reg := post("/api/register", `{"username":"legacy_rod","password":"Synthetic-Pass42","qq":"123456","name":"Rod"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	svc := identity.New(db.App, nil)
	session, err := svc.Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	// Create a rod component instance in inventory.
	signature := "rod_bamboo#common#"
	base, _, _, ok := c.Instance(signature)
	if !ok {
		t.Fatal("bad signature")
	}
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "gear", Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}}}); err != nil {
		t.Fatal(err)
	}

	code, result := post("/api/bd/set", `{"part":"rod","compId":"rod_bamboo#common#"}`, token)
	if code != 200 || result["ok"] != true {
		t.Fatalf("bd set: %d %v", code, result)
	}
	bd := result["bd"].(map[string]any)
	rodPart := bd["rod"].(map[string]any)
	if rodPart["compId"] != signature {
		t.Fatalf("bd rod part: %v", rodPart)
	}
	if result["rodActiveSlot"] != float64(-1) {
		t.Fatalf("rodActiveSlot: %v", result["rodActiveSlot"])
	}

	// Uninstall returns the component to inventory.
	code, result = post("/api/bd/set", `{"part":"rod"}`, token)
	if code != 200 || result["ok"] != true {
		t.Fatalf("bd unset: %d %v", code, result)
	}
	bd = result["bd"].(map[string]any)
	if len(bd) != 0 {
		t.Fatalf("bd after unset: %v", bd)
	}
}
