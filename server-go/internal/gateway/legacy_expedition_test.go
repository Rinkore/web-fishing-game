package gateway

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIntegrationExpeditionHTTPIsolation(t *testing.T) {
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(context.Background(), db.Admin, c); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	do := func(path, body, token string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, out
	}
	register := func(name string) string {
		code, out := do("/api/register", `{"username":"`+name+`","password":"Synthetic-Pass42","qq":"123456","name":"Voyager"}`, "")
		if code != 200 {
			t.Fatal(code, out)
		}
		return out["token"].(string)
	}
	owner, other := register("voyager_http"), register("voyager_other")
	for _, path := range []string{"/api/sea/expedition/start", "/api/sea/expedition/claim", "/api/sea/sets/redeem", "/api/sea/sets/target"} {
		if code, _ := do(path, `{"requestKey":"no-login-key"}`, ""); code != 401 {
			t.Fatalf("unauthenticated %s: %d", path, code)
		}
	}
	start := `{"requestKey":"http-start-key","route":"trade","hours":8}`
	code, out := do("/api/sea/expedition/start", start, owner)
	if code != 200 {
		t.Fatal(code, out)
	}
	active := out["sea"].(map[string]any)["expedition"].(map[string]any)["active"].(map[string]any)
	id := active["id"].(string)
	if active["reward"] != nil {
		t.Fatal("unearned reward leaked")
	}
	code, out = do("/api/sea/expedition/start", start, owner)
	if code != 200 || out["sea"].(map[string]any)["expedition"].(map[string]any)["active"].(map[string]any)["id"] != id {
		t.Fatal("retry", code, out)
	}
	code, out = do("/api/sea/expedition/claim", `{"requestKey":"other-claim-key","id":"`+id+`"}`, other)
	if code != 400 || out["error"] != "expedition_missing" {
		t.Fatal("cross-account claim", code, out)
	}
	code, out = do("/api/sea/expedition/claim", `{"requestKey":"early-claim-key","id":"`+id+`"}`, owner)
	if code != 400 || out["error"] != "expedition_not_ready" {
		t.Fatal("early claim", code, out)
	}
	if _, err = db.Admin.Exec(context.Background(), `UPDATE fishing.sea_expeditions SET started_at=started_at-interval '9 hours',ends_at=ends_at-interval '9 hours' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	claim := `{"requestKey":"ready-claim-key","id":"` + id + `"}`
	for range 2 {
		code, out = do("/api/sea/expedition/claim", claim, owner)
		if code != 200 {
			t.Fatal("claim/retry", code, out)
		}
	}
	var count int
	if err = db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.sea_progress_entries WHERE operation_id=(SELECT claim_operation FROM fishing.sea_expeditions WHERE id=$1)`, id).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicated growth", count, err)
	}
	code, out = do("/api/sea/sets/redeem", `{"requestKey":"forged-starter","set":"harvest","part":"","starter":true}`, other)
	if code != 400 || out["error"] != "starter_unavailable" {
		t.Fatal("unearned starter", code, out)
	}
	code, out = do("/api/sea/sets/target", `{"requestKey":"invalid-target","target":"crucian"}`, other)
	if code != 400 || out["error"] != "apex_required" {
		t.Fatal("target without set", code, out)
	}
}
