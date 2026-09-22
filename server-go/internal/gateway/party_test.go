package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationHTTPPartyEventsAndCodexIsolation(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	svc := identity.New(db.App, nil)
	users := make([]identity.LoginResult, 3)
	for i := range users {
		var err error
		users[i], err = svc.Register(ctx, identity.Registration{Username: fmt.Sprintf("party_http_%d", i), Password: "Synthetic-party-Pass42", QQ: "123456"})
		if err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	request := func(method, path, body, token string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if method == "POST" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, out
	}
	for _, path := range []string{"/api/v1/party", "/api/v1/party/events", "/api/v1/sea", "/api/v1/codex"} {
		if code, _ := request("GET", path, "", ""); code != 401 {
			t.Fatal("anonymous access", path, code)
		}
	}
	post := func(index int, path, body, status string) map[string]any {
		t.Helper()
		code, out := request("POST", path, body, users[index].Token)
		if code != 200 || out["status"] != status {
			t.Fatal("command", path, code, out)
		}
		return out
	}
	id := func(index int) string { return strconv.FormatInt(users[index].Session.AccountID, 10) }
	post(0, "/api/v1/party", `{"requestKey":"create","action":"create"}`, "created")
	code, v := request("GET", "/api/v1/party", "", users[0].Token)
	if code != 200 {
		t.Fatal(code)
	}
	partyID := v["party"].(map[string]any)["id"].(string)
	post(0, "/api/v1/friends", `{"requestKey":"friend","action":"request","targetId":"`+id(1)+`"}`, "pending")
	post(1, "/api/v1/friends", `{"requestKey":"friend","action":"accept","targetId":"`+id(0)+`"}`, "accepted")
	post(0, "/api/v1/party", `{"requestKey":"invite","action":"invite","targetId":"`+id(1)+`"}`, "invited")
	post(1, "/api/v1/party", `{"requestKey":"accept","action":"accept","partyId":"`+partyID+`"}`, "accepted")
	code, v = request("GET", "/api/v1/party/events?limit=1", "", users[1].Token)
	if code != 200 || len(v["items"].([]any)) != 1 {
		t.Fatal("event first page", code, v)
	}
	cursor := v["nextAfter"].(string)
	code, v = request("GET", "/api/v1/party/events?after="+cursor, "", users[1].Token)
	if code != 200 || len(v["items"].([]any)) != 1 || v["items"].([]any)[0].(map[string]any)["action"] != "accept" {
		t.Fatal("event continuation", code, v)
	}
	code, v = request("GET", "/api/v1/party/events?ownerId="+id(0), "", users[2].Token)
	if code != 200 || len(v["items"].([]any)) != 0 {
		t.Fatal("event recipient isolation", code, v)
	}
	for _, path := range []string{"/api/v1/party/events?after=-1", "/api/v1/party/events?limit=101", "/api/v1/codex?limit=0"} {
		if code, _ := request("GET", path, "", users[0].Token); code != 400 {
			t.Fatal("invalid pagination", path, code)
		}
	}
	if code, _ := request("POST", "/api/v1/party", `{"requestKey":"spoof","action":"disband","actorId":"`+id(0)+`"}`, users[1].Token); code != 400 {
		t.Fatal("actor spoof accepted", code)
	}
	post(1, "/api/v1/party", `{"requestKey":"cannot-disband","action":"disband"}`, "party_leader_required")
	code, v = request("GET", "/api/v1/sea", "", users[1].Token)
	if code != 200 || len(v["memberZones"].([]any)) != 0 {
		t.Fatal("sea overview", code, v)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('codex_a','fish'),('codex_b','fish')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count) VALUES($1,'codex_a',2),($1,'codex_b',3),($2,'codex_a',9)`, users[0].Session.AccountID, users[1].Session.AccountID); err != nil {
		t.Fatal(err)
	}
	code, v = request("GET", "/api/v1/codex?limit=1", "", users[0].Token)
	if code != 200 || v["nextAfter"] != "codex_a" || v["items"].([]any)[0].(map[string]any)["count"] != float64(2) {
		t.Fatal("codex page", code, v)
	}
	code, v = request("GET", "/api/v1/codex?after=codex_a&limit=1", "", users[0].Token)
	if code != 200 || v["nextAfter"] != "" || v["items"].([]any)[0].(map[string]any)["id"] != "codex_b" {
		t.Fatal("codex continuation", code, v)
	}
	code, v = request("GET", "/api/v1/codex?ownerId="+id(0), "", users[2].Token)
	if code != 200 || len(v["items"].([]any)) != 0 {
		t.Fatal("codex owner isolation", code, v)
	}
	post(0, "/api/v1/party", `{"requestKey":"disband","action":"disband"}`, "disbanded")
	code, v = request("GET", "/api/v1/party", "", users[1].Token)
	if code != 200 || v["party"].(map[string]any)["id"] != "0" {
		t.Fatal("disband view", code, v)
	}
	if code, _ := request("POST", "/api/logout", `{}`, users[1].Token); code != 200 {
		t.Fatal("logout", code)
	}
	if code, _ := request("GET", "/api/v1/party/events", "", users[1].Token); code != 401 {
		t.Fatal("revoked event access", code)
	}
}
