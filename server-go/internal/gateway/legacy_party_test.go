package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyParty(t *testing.T) {
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()
	ctx := context.Background()

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

	register := func(name string) (string, int64) {
		code, reg := do("POST", "/api/register", `{"username":"`+name+`","password":"Synthetic-Pass42","qq":"123456","name":"`+name+`"}`, "")
		if code != 200 {
			t.Fatalf("register %s: %d %v", name, code, reg)
		}
		token := reg["token"].(string)
		session, err := identity.New(db.App, nil).Authenticate(ctx, token, false)
		if err != nil {
			t.Fatal(err)
		}
		return token, session.AccountID
	}
	tokenA, idA := register("party_a")
	tokenB, idB := register("party_b")

	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,'friend-seed',decode(repeat('22',32),'hex'))`, idA); err != nil {
		t.Fatal(err)
	}
	var friendOp int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,'friend-seed','friend_change','test-v1') RETURNING id`, idA).Scan(&friendOp); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.friend_relations(a_id,b_id,requester_id,state,updated_operation) VALUES(LEAST($1::bigint,$2::bigint),GREATEST($1::bigint,$2::bigint),$1,'accepted',$3)`, idA, idB, friendOp); err != nil {
		t.Fatal(err)
	}

	code, view := do("GET", "/api/party", "", tokenA)
	if code != 200 || view["party"] != nil || view["invite"] != nil {
		t.Fatalf("party view: %d %v", code, view)
	}

	code, created := do("POST", "/api/party", `{"action":"create"}`, tokenA)
	if code != 200 || created["ok"] != true {
		t.Fatalf("party create: %d %v", code, created)
	}
	party := created["party"].(map[string]any)
	if party["id"] == nil || party["leaderName"] != "party_a" || len(party["members"].([]any)) != 1 {
		t.Fatalf("party shape: %v", party)
	}

	code, invited := do("POST", "/api/party", `{"action":"invite","target":"party_b"}`, tokenA)
	if code != 200 || invited["ok"] != true {
		t.Fatalf("party invite: %d %v", code, invited)
	}
	code, invitee := do("GET", "/api/party", "", tokenB)
	if code != 200 {
		t.Fatalf("invitee view: %d", code)
	}
	invite, _ := invitee["invite"].(map[string]any)
	if invite == nil || invite["leaderName"] != "party_a" {
		t.Fatalf("invite shape: %v", invitee)
	}

	code, accepted := do("POST", "/api/party", `{"action":"accept"}`, tokenB)
	if code != 200 || accepted["ok"] != true {
		t.Fatalf("party accept: %d %v", code, accepted)
	}
	party = accepted["party"].(map[string]any)
	if len(party["members"].([]any)) != 2 {
		t.Fatalf("party members: %v", party)
	}

	code, left := do("POST", "/api/party", `{"action":"leave"}`, tokenB)
	if code != 200 || left["ok"] != true || left["party"] != nil {
		t.Fatalf("party leave: %d %v", code, left)
	}
	code, disbanded := do("POST", "/api/party", `{"action":"disband"}`, tokenA)
	if code != 200 || disbanded["ok"] != true {
		t.Fatalf("party disband: %d %v", code, disbanded)
	}
	if code, _ := do("POST", "/api/party", `{"action":"bogus"}`, tokenA); code != 400 {
		t.Fatalf("unknown action accepted: %d", code)
	}
}
