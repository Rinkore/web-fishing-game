package gateway

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/social"
	"fishing.local/server/internal/rules"
)

func setupAdminParty(t *testing.T, f *adminFixture) (int64, string, int64) {
	t.Helper()
	ctx := context.Background()
	guest, guestID := f.register("party_guest", "队友")
	s := social.New(f.db.App)
	for _, cmd := range []social.FriendCommand{{ActorID: f.playerID, TargetID: guestID, RequestKey: "party-friend-request", Action: "request"}, {ActorID: guestID, TargetID: f.playerID, RequestKey: "party-friend-accept", Action: "accept"}} {
		if _, err := s.Friend(ctx, cmd); err != nil {
			t.Fatal(err)
		}
	}
	code, body := f.player("POST", "/api/party", `{"action":"create"}`)
	f.expect(code, body, 200, "")
	id := int64(body["party"].(map[string]any)["id"].(float64))
	code, body = f.player("POST", "/api/party", `{"action":"invite","target":"party_guest"}`)
	f.expect(code, body, 200, "")
	code, body = f.call("POST", "/api/party", `{"action":"accept"}`, guest)
	f.expect(code, body, 200, "")
	return id, guest, guestID
}

func TestIntegrationLegacyAdminPartyAndSeaEviction(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	party, guest, guestID := setupAdminParty(t, f)
	code, body := f.player("GET", "/api/admin/parties", "")
	if code == 200 {
		t.Fatal("player read admin parties", body)
	}
	code, body = f.player("POST", "/api/admin/party/disband", jsonString(map[string]any{"id": party}))
	if code == 200 {
		t.Fatal("player disbanded via admin", body)
	}
	code, body = f.admin("GET", "/api/admin/parties", "")
	f.expect(code, body, 200, "")
	p := body["parties"].([]any)[0].(map[string]any)
	if p["leader"] != f.playerKey || p["members"].([]any)[1].(map[string]any)["id"] != "party_guest" {
		t.Fatalf("legacy identities: %v", p)
	}
	// Install a synthetic zone, then use the actual old HTTP start route with
	// its username identity to enter it as a guest.
	z := rules.SeaZone{ID: "shared", Name: "共享海域", Mood: "calm", Expire: time.Now().Add(time.Hour).UnixMilli(), Spots: []rules.SeaSpot{{ID: "z1", Name: "测试钓点", Pool: []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}}}}
	raw, _ := json.Marshal(z)
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.sea_zones(owner_id,id,data,expires_at,created_operation)
 SELECT $1,'shared',$2,clock_timestamp()+interval '1 hour',created_operation FROM fishing.parties WHERE id=$3`, f.playerID, raw, party); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/party", "/api/sea"} {
		code, view := f.call("GET", path, "", guest)
		f.expect(code, view, 200, "")
		key := "memberZones"
		if path == "/api/sea" {
			key = "partyZones"
		}
		zone := view[key].([]any)[0].(map[string]any)
		if zone["owner"] != f.playerKey || zone["groundId"] != "sea:"+f.playerKey+":shared" {
			t.Fatal("shared identity", path, zone)
		}
	}
	fixture := &legacyTradeFixture{server: f.server, client: f.server.Client(), token: map[string]string{"guest": guest}}
	feed := openLegacyTradeStream(t, fixture, "guest")
	defer feed.cancel()
	feed.wait(t, "init", 10*time.Second)
	code, body = f.call("POST", "/api/fishing/start", `{"groundId":"sea:console_target:shared","spotId":"z1"}`, guest)
	f.expect(code, body, 200, "")
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()+interval '1 hour' WHERE owner_id=$1`, guestID); err != nil {
		t.Fatal(err)
	}
	// A second tab must see the old username form during resume as well.
	second := openLegacyTradeStream(t, fixture, "guest")
	defer second.cancel()
	init := second.wait(t, "init", 10*time.Second)
	if init["resumedFishing"].(map[string]any)["groundId"] != "sea:console_target:shared" {
		t.Fatal("resume identity", init)
	}
	code, body = f.admin("POST", "/api/admin/party/disband", jsonString(map[string]any{"id": strconv.FormatInt(party, 10), "expectedRevision": p["revision"]}))
	f.expect(code, body, 200, "")
	// This is the same bounded sweep run every second by NativeService.Run;
	// eviction does not wait for the hour-long synthetic cast to become due.
	_, count, err := fishing.NewLiveNative(f.db.App, time.UTC).SweepZoneGuests(ctx, 0, 100)
	if err != nil || count != 1 {
		t.Fatal("immediate eviction", count, err)
	}
	seen := map[string]bool{}
	deadline := time.After(10 * time.Second)
	for !seen["seaEvict"] || !seen["notice"] {
		select {
		case event := <-feed.events:
			if event["type"] == "seaEvict" {
				seen["seaEvict"] = true
			}
			if event["type"] == "notice" && event["msg"] == "🛡 管理员解散了编队。" {
				seen["notice"] = true
			}
		case <-deadline:
			t.Fatal("missing notices", seen)
		}
	}
	code, body = f.call("GET", "/api/party", "", guest)
	f.expect(code, body, 200, "")
	if body["party"] != nil || len(body["memberZones"].([]any)) != 0 {
		t.Fatal("sharing survived disband", body)
	}
	code, body = f.call("POST", "/api/fishing/start", `{"groundId":"sea:console_target:shared","spotId":"z1"}`, guest)
	f.expect(code, body, 409, "sea_membership_required")
	var audits, events int
	if err := f.db.Admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM fishing.admin_audit WHERE action='party/disband'),(SELECT count(*) FROM fishing.party_events WHERE action='admin_disband')`).Scan(&audits, &events); err != nil || audits != 1 || events != 1 {
		t.Fatal("admin audit/event", audits, events, err)
	}
}

func TestIntegrationLegacyAdminPartyRollbackAndConcurrentDisband(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	party, _, _ := setupAdminParty(t, f)
	if _, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_party_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_party_audit BEFORE INSERT ON fishing.admin_audit FOR EACH ROW EXECUTE FUNCTION fishing.fail_party_audit()`); err != nil {
		t.Fatal(err)
	}
	code, body := f.admin("POST", "/api/admin/party/disband", jsonString(map[string]any{"id": party}))
	if code == 200 {
		t.Fatal("audit fault accepted", body)
	}
	var members int
	if err := f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.party_members WHERE party_id=$1`, party).Scan(&members); err != nil || members != 2 {
		t.Fatal("members lost on rollback", members, err)
	}
	if _, err := f.db.Admin.Exec(ctx, `DROP TRIGGER fail_party_audit ON fishing.admin_audit`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var codes [2]int
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = f.admin("POST", "/api/admin/party/disband", jsonString(map[string]any{"id": party}))
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 404) || (codes[1] == 200 && codes[0] == 404)) {
		t.Fatal("concurrent disband", codes)
	}
	code, body = f.admin("GET", "/api/admin/parties", "")
	f.expect(code, body, 200, "")
	if body["total"] != float64(0) {
		t.Fatal("inactive party in list", body)
	}
}
