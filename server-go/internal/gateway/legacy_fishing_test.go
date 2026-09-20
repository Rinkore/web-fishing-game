package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyFishingLifecycle(t *testing.T) {
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
	client.Timeout = 5 * time.Second

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

	code, reg := post("/api/register", `{"username":"legacy_fish","password":"Synthetic-Pass42","qq":"123456","name":"Fish"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	svc := identity.New(db.App, nil)
	session, err := svc.Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	// Without an active connection, start must be rejected.
	if code, _ := post("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, token); code != 400 {
		t.Fatalf("start without connection accepted: %d", code)
	}

	// Open a stream via /events to establish the connection lease.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	eventsReq, err := http.NewRequestWithContext(ctx, "GET", server.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	eventsReq.Header.Set("Authorization", "Bearer "+token)
	eventsRes, err := client.Do(eventsReq)
	if err != nil {
		t.Fatal(err)
	}
	defer eventsRes.Body.Close()
	if eventsRes.StatusCode != 200 {
		t.Fatalf("events: %d", eventsRes.StatusCode)
	}
	reader := bufio.NewReader(eventsRes.Body)

	// Drain until init arrives.
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read init: %v", err)
		}
		if strings.HasPrefix(line, "data: ") {
			var m map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(line), "data: ")), &m); err == nil && m["type"] == "init" {
				if m["version"] == nil || m["version"] == "" {
					t.Fatalf("init missing version: %v", m)
				}
				if _, ok := m["playersTotal"]; !ok {
					t.Fatalf("init missing playersTotal: %v", m)
				}
				if _, ok := m["grounds"]; !ok {
					t.Fatalf("init missing grounds: %v", m)
				}
				break
			}
		}
	}

	// The stream established a connection, so start succeeds.
	code, started := post("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, token)
	if code != 200 || started["ok"] != true || started["interval"] == nil || started["castInfo"] == nil {
		t.Fatalf("start: %d %v", code, started)
	}

	// Settle directly: record a catch as if the native scheduler had run it. The
	// asset_operations row requires a matching command_results dedup key.
	var opID int64
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,'legacy-catch',decode(repeat('00',32),'hex'))`, session.AccountID); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(context.Background(), `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,'legacy-catch','fishing_settle','test-v1') RETURNING id`, session.AccountID).Scan(&opID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at)
	 VALUES($1,1,$2,'crucian',22,'map','dock',clock_timestamp())`, opID, session.AccountID); err != nil {
		t.Fatal(err)
	}

	// The SSE loop should emit a catch event within its 250ms tick.
	deadline := time.Now().Add(3 * time.Second)
	sawCatch := false
	sawAssets := false
	for time.Now().Before(deadline) && !(sawCatch && sawAssets) {
		line, err := reader.ReadString('\n')
		if err != nil {
			continue
		}
		if strings.HasPrefix(line, "data: ") {
			var m map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(line), "data: ")), &m); err == nil && m["type"] == "catch" {
				sawCatch = true
				entry := m["entry"].(map[string]any)
				item := entry["item"].(map[string]any)
				if item["id"] != "crucian" || item["name"] == "" || entry["who"] != "Fish" {
					t.Fatalf("catch entry: %v", entry)
				}
			} else if err == nil && m["type"] == "assets" {
				sawAssets = true
				invAdd := m["invAdd"].(map[string]any)
				if invAdd["crucian"] != float64(1) {
					t.Fatalf("assets invAdd: %v", m)
				}
			}
		}
	}
	if !sawCatch {
		t.Fatal("no catch event observed")
	}
	if !sawAssets {
		t.Fatal("no assets event observed")
	}

	if code, _ := post("/api/fishing/stop", "{}", token); code != 200 {
		t.Fatalf("stop: %d", code)
	}
	_ = assets.Result{}
}
