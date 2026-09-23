package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
)

func legacyLeaseContext(t *testing.T, f *legacyTradeFixture) context.Context {
	t.Helper()
	session, err := identity.New(f.db.App, nil).Authenticate(f.ctx, f.token["trade_a"], false)
	if err != nil {
		t.Fatal(err)
	}
	return assets.WithSession(f.ctx, session.AccountID, session.Hash, false)
}

// Expire the durable lease, then let a real settlement observe the player as
// offline. Legacy start initially sets resume_enabled=false; recovery must also
// work after that path has changed the fishing session to paused.
func pauseLegacyExpiredLease(t *testing.T, f *legacyTradeFixture, missing bool) {
	t.Helper()
	owner := f.id["trade_a"]
	statement := `UPDATE fishing.gateway_streams SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`
	if missing {
		statement = `DELETE FROM fishing.gateway_streams WHERE owner_id=$1`
	}
	if _, err := f.db.Admin.Exec(f.ctx, statement, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	candidate := fishing.Candidate{OwnerID: owner}
	var resume bool
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT id,generation,next_seq,resume_enabled FROM fishing.native_fishing_sessions WHERE owner_id=$1`, owner).Scan(&candidate.SessionID, &candidate.Generation, &candidate.Sequence, &resume); err != nil {
		t.Fatal(err)
	}
	if resume {
		t.Fatal("fixture must cover a fresh legacy session with resume_enabled=false")
	}
	result, err := fishing.NewLiveNative(f.db.App, time.Local).Settle(f.ctx, candidate)
	if err != nil || result.Status != "paused" {
		t.Fatalf("offline settlement: status=%q err=%v", result.Status, err)
	}
}

func TestIntegrationLegacyExpiredStreamResultAndExplicitRecovery(t *testing.T) {
	for _, mode := range []string{"expired", "missing"} {
		t.Run(mode, func(t *testing.T) {
			f := newLegacyTradeFixture(t)
			ctx := legacyLeaseContext(t, f)
			svc := fishing.NewLiveNative(f.db.App, time.Local)
			streamID := strings.Repeat("a", 32)
			result, err := svc.Stream(ctx, f.id["trade_a"], "lease-test-open", streamID, "open")
			if err != nil || result.Status != "connected" {
				t.Fatalf("open: status=%q err=%v", result.Status, err)
			}
			f.expectPost("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, "trade_a", http.StatusOK, "")
			pauseLegacyExpiredLease(t, f, mode == "missing")

			result, err = svc.Stream(ctx, f.id["trade_a"], "lease-test-heartbeat", streamID, "heartbeat")
			// A business rejection is intentionally a result, not a Go error.
			// The HTTP heartbeat loop must inspect both parts of this contract.
			if err != nil || result.Status != "connection_expired" {
				t.Fatalf("expired heartbeat: status=%q err=%v", result.Status, err)
			}
			result, err = svc.Stream(ctx, f.id["trade_a"], "lease-test-reopen", streamID, "open")
			if err != nil || result.Status != "connected" {
				t.Fatalf("reopen: status=%q err=%v", result.Status, err)
			}
			var active, resumable, online bool
			if err := f.db.Admin.QueryRow(f.ctx, `SELECT n.state='active',n.resume_enabled,c.expires_at>clock_timestamp() FROM fishing.native_fishing_sessions n JOIN fishing.fishing_connections c USING(owner_id) WHERE n.owner_id=$1`, f.id["trade_a"]).Scan(&active, &resumable, &online); err != nil {
				t.Fatal(err)
			}
			if !active || !resumable || !online {
				t.Fatalf("reopen failed to restore fishing: active=%v resumable=%v online=%v", active, resumable, online)
			}
		})
	}
}

func TestIntegrationLegacySSERecoversExpiredFishingLease(t *testing.T) {
	f := newLegacyTradeFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.token["trade_a"])
	response, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("events: HTTP %d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read init: %v", err)
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(line), "data: ")), &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "init" {
			break
		}
	}
	f.expectPost("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, "trade_a", http.StatusOK, "")
	pauseLegacyExpiredLease(t, f, false)

	// Keep this exact SSE connection open: reconnecting it manually would mask
	// the regression. One server heartbeat (10 seconds) must renew the lease
	// and resume the cast without another user command or browser refresh.
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(13 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-ticker.C:
			var recovered bool
			if err := f.db.Admin.QueryRow(ctx, `SELECT n.state='active' AND n.resume_enabled AND c.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM fishing.gateway_streams g WHERE g.owner_id=n.owner_id AND g.expires_at>clock_timestamp()) FROM fishing.native_fishing_sessions n JOIN fishing.fishing_connections c USING(owner_id) WHERE n.owner_id=$1`, f.id["trade_a"]).Scan(&recovered); err != nil {
				t.Fatal(err)
			}
			if recovered {
				return
			}
		case <-deadline.C:
			t.Fatal("SSE stayed connected but its expired lease was not reopened and fishing remained paused")
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestIntegrationLegacySSERejectsStreamLimit(t *testing.T) {
	f := newLegacyTradeFixture(t)
	ctx := legacyLeaseContext(t, f)
	svc := fishing.NewLiveNative(f.db.App, time.Local)
	for i := 0; i < 8; i++ {
		id := fmt.Sprintf("%032d", i)
		result, err := svc.Stream(ctx, f.id["trade_a"], "limit-open-"+id, id, "open")
		if err != nil || result.Status != "connected" {
			t.Fatalf("open %d: status=%q err=%v", i, result.Status, err)
		}
	}
	// Keep the fixture deterministic even on slow database runners.
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.gateway_streams SET expires_at=clock_timestamp()+interval '1 minute' WHERE owner_id=$1`, f.id["trade_a"]); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodGet, f.server.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.token["trade_a"])
	response, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("stream limit established an unleased SSE connection: HTTP %d", response.StatusCode)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil || body.Code != "stream_limit" {
		t.Fatalf("stream limit response: code=%q err=%v", body.Code, err)
	}
}
