package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyEventsRejectsUnestablishedLease(t *testing.T) {
	f := newLegacyTradeFixture(t)
	for i := range 8 {
		streamID := strings.Repeat("0", 31) + strconv.Itoa(i)
		if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 minute')`, f.id["trade_a"], streamID); err != nil {
			t.Fatal(err)
		}
	}
	code, body := f.do("GET", "/events", "", f.token["trade_a"])
	f.expect(code, body, http.StatusConflict, "stream_limit")
}

func TestIntegrationLegacyFishingHeartbeatRestoresLease(t *testing.T) {
	for _, disruption := range []string{"missing", "expired"} {
		t.Run(disruption, func(t *testing.T) {
			f := newLegacyTradeFixture(t)
			c, err := rules.Default()
			if err != nil {
				t.Fatal(err)
			}
			if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, c); err != nil {
				t.Fatal(err)
			}
			// Keep settlement deterministic while exercising the real asset and
			// SSE paths after the gateway restores the original connection.
			grounds := c.Grounds()
			grounds[0].Spots[0].BiteRate = 100
			grounds[0].Spots[0].Pool = []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}
			c.Constants["GROUNDS"], _ = json.Marshal(grounds)
			svc := fishing.NewNative(f.db.App, c)
			owner := f.id["trade_a"]
			stream := openLegacyTradeStream(t, f, "trade_a")
			defer stream.cancel()
			stream.wait(t, "init", 3*time.Second)
			f.expectPost("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, "trade_a", 200, "")

			var streamID string
			if err := f.db.Admin.QueryRow(f.ctx, `SELECT stream_id FROM fishing.gateway_streams WHERE owner_id=$1`, owner).Scan(&streamID); err != nil {
				t.Fatal(err)
			}
			if disruption == "missing" {
				_, err = f.db.Admin.Exec(f.ctx, `DELETE FROM fishing.gateway_streams WHERE owner_id=$1`, owner)
			} else {
				_, err = f.db.Admin.Exec(f.ctx, `UPDATE fishing.gateway_streams SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner); err != nil {
				t.Fatal(err)
			}
			if _, batch, err := svc.Sweep(f.ctx, fishing.Cursor{}, 100, 1); err != nil || batch.Failed != 0 {
				t.Fatalf("pause offline fishing: %+v %v", batch, err)
			}
			status, err := svc.Status(f.ctx, owner)
			if err != nil || status["state"] != "paused" {
				t.Fatalf("expired connection did not pause fishing: %v %v", status, err)
			}

			// The browser keeps this SSE connection open. Its next ten-second
			// heartbeat must reopen a missing/expired lease and resume fishing.
			deadline := time.NewTimer(12 * time.Second)
			defer deadline.Stop()
			poll := time.NewTicker(50 * time.Millisecond)
			defer poll.Stop()
			for {
				var restored bool
				err := f.db.Admin.QueryRow(f.ctx, `SELECT EXISTS(
 SELECT 1 FROM fishing.gateway_streams g
 JOIN fishing.fishing_connections c USING(owner_id)
 JOIN fishing.native_fishing_sessions n USING(owner_id)
 WHERE g.owner_id=$1 AND g.stream_id=$2 AND g.expires_at>clock_timestamp()
 AND c.expires_at>clock_timestamp() AND n.state='active')`, owner, streamID).Scan(&restored)
				if err != nil {
					t.Fatal(err)
				}
				if restored {
					break
				}
				select {
				case <-deadline.C:
					t.Fatal("SSE heartbeat did not restore the lease and resume fishing")
				case <-poll.C:
				}
			}
			if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner); err != nil {
				t.Fatal(err)
			}
			if _, batch, err := svc.Sweep(f.ctx, fishing.Cursor{}, 100, 1); err != nil || batch.Settled != 1 || batch.Failed != 0 {
				t.Fatalf("settle after lease recovery: %+v %v", batch, err)
			}
			caught := stream.wait(t, "catch", 3*time.Second)
			entry := caught["entry"].(map[string]any)
			if entry["item"].(map[string]any)["id"] != "crucian" {
				t.Fatalf("recovered catch: %v", entry)
			}
			var count int64
			if err := f.db.Admin.QueryRow(f.ctx, `SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&count); err != nil || count < 1 {
				t.Fatalf("recovered catch was not awarded: count=%d err=%v", count, err)
			}
		})
	}
}

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
	// A second tab must receive the same cast details during init.  The old
	// client renders the resumed interval directly and does not issue another
	// start request just to populate the fishing panel.
	resumeCtx, resumeCancel := context.WithCancel(context.Background())
	defer resumeCancel()
	resumeReq, err := http.NewRequestWithContext(resumeCtx, "GET", server.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resumeReq.Header.Set("Authorization", "Bearer "+token)
	resumeRes, err := client.Do(resumeReq)
	if err != nil {
		t.Fatal(err)
	}
	defer resumeRes.Body.Close()
	if resumeRes.StatusCode != 200 {
		t.Fatalf("resume events: %d", resumeRes.StatusCode)
	}
	resumeReader := bufio.NewReader(resumeRes.Body)
	for {
		line, readErr := resumeReader.ReadString('\n')
		if readErr != nil {
			t.Fatalf("read resumed init: %v", readErr)
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(line), "data: ")), &m) != nil || m["type"] != "init" {
			continue
		}
		resumed, ok := m["resumedFishing"].(map[string]any)
		if !ok || resumed["interval"].(float64) <= 0 || resumed["castInfo"] == nil {
			t.Fatalf("resumed cast details: %v", m["resumedFishing"])
		}
		break
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
