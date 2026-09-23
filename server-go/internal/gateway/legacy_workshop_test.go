package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// TestIntegrationLegacyWorkshop verifies that the default gear system retires
// the original workshop endpoints without charging or consuming equipment.
func TestIntegrationLegacyWorkshop(t *testing.T) {
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
	code, reg := do("POST", "/api/register", `{"username":"legacy_ws","password":"Synthetic-Pass42","qq":"123456","name":"Workshop"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: session.AccountID, RequestKey: "fund", Reason: "reward", RuleVersion: "test-v1",
		Coins: 1000000, Stacks: []assets.StackDelta{
			{ItemID: "dragonpearl", Tier: "normal", Quantity: 6},
			{ItemID: "relic", Tier: "normal", Quantity: 10},
			{ItemID: "boneash", Tier: "normal", Quantity: 5},
		},
	}); err != nil {
		t.Fatal(err)
	}
	gear := func(key, signature string) {
		t.Helper()
		base, _, _, ok := c.Instance(signature)
		if !ok {
			t.Fatalf("bad fixture signature %s", signature)
		}
		attrs, _ := json.Marshal(map[string]any{"signature": signature})
		if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
			ActorID: session.AccountID, RequestKey: key, Reason: "reward", RuleVersion: "test-v1",
			Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	inventory := func() map[string]any {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["inventory"].(map[string]any)
	}
	coins := func() float64 {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["coins"].(float64)
	}

	mythic := "rod_bamboo#mythic#skl+20,size+30"
	mainSig := "rod_bamboo#common#spd+5"
	subSig := "rod_bamboo#epic#skl+7,mat+3"
	gear("mythic", mythic)
	gear("smelt-main", mainSig)
	gear("smelt-sub", subSig)
	beforeInventory, beforeCoins := inventory(), coins()
	for _, endpoint := range []struct{ method, path, body string }{
		{"GET", "/api/workshop", ""},
		{"POST", "/api/workshop/recast", `{"id":"` + mythic + `"}`},
		{"POST", "/api/workshop/forge", `{"id":"` + mainSig + `","materialId":"boneash"}`},
		{"POST", "/api/workshop/smelt", `{"mainId":"` + mainSig + `","subId":"` + subSig + `","mainAffix":"speed","subAffix":"skill","materials":[{"id":"boneash","qty":2}],"pearl":false,"relics":0}`},
	} {
		t.Run(endpoint.path, func(t *testing.T) {
			code, body := do(endpoint.method, endpoint.path, endpoint.body, token)
			if code != http.StatusBadRequest || body["code"] != "legacy_workshop_retired" {
				t.Fatalf("retired endpoint: %d %v", code, body)
			}
			if coins() != beforeCoins || !reflect.DeepEqual(inventory(), beforeInventory) {
				t.Fatal("retired workshop changed player assets")
			}
		})
	}
}
