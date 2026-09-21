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

	// Use the same atomic inventory/revision/outbox boundary as the scheduler.
	_, err = assets.New(db.App).Run(ctx, assets.Command{ActorID: session.AccountID, RequestKey: "legacy-catch", Kind: "fishing_settle", RuleVersion: "test-v1", Players: []int64{session.AccountID}}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		if err := tx.Stacks(ctx, session.AccountID, []assets.StackDelta{{ItemID: "crucian", Tier: "normal", Quantity: 1}}); err != nil {
			return assets.Result{}, err
		}
		_, err := tx.SQL().Exec(ctx, `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at) VALUES($1,1,$2,'crucian',22,'map','dock',clock_timestamp())`, tx.OperationID(), session.AccountID)
		return assets.Result{Status: "settled"}, err
	})
	if err != nil {
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
				inventory, ok := m["inventory"].(map[string]any)
				sawAssets = ok && inventory["crucian"] == float64(1) && m["invRev"] != nil
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
	// Legacy clients do not supply command IDs. Each new start/stop must get a
	// fresh durable key, or the second start replays the first completed start.
	for i := 0; i < 2; i++ {
		if code, body := post("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, token); code != 200 {
			t.Fatalf("restart: %d %v", code, body)
		}
		var state string
		if err := db.Admin.QueryRow(ctx, `SELECT state FROM fishing.native_fishing_sessions WHERE owner_id=$1`, session.AccountID).Scan(&state); err != nil || state != "active" {
			t.Fatalf("restart state: %s %v", state, err)
		}
		if code, body := post("/api/fishing/stop", "{}", token); code != 200 {
			t.Fatalf("restop: %d %v", code, body)
		}
		if err := db.Admin.QueryRow(ctx, `SELECT state FROM fishing.native_fishing_sessions WHERE owner_id=$1`, session.AccountID).Scan(&state); err != nil || state != "stopped" {
			t.Fatalf("restop state: %s %v", state, err)
		}
	}
}
