package gateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

type recordAdminFixture struct {
	*adminFixture
	sequence int
}

func newRecordAdminFixture(t *testing.T) *recordAdminFixture {
	t.Helper()
	f := &recordAdminFixture{adminFixture: newAdminFixture(t)}
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(context.Background(), f.db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	return f
}

// Additional ranking subjects are fixture data, not a test of registration
// quotas or proof challenges (covered by registration_test.go).
func (f *recordAdminFixture) register(username, name string) (string, int64) {
	f.t.Helper()
	result, err := identity.New(f.db.App, nil).Register(context.Background(), identity.Registration{
		Username: username, Password: "Synthetic-Pass42", QQ: "123456", Name: name,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return result.Token, result.Session.AccountID
}

func (f *recordAdminFixture) restart(loc *time.Location) {
	f.t.Helper()
	f.server.Close()
	f.server = httptest.NewServer(New(f.db.App, nil, loc))
	f.t.Cleanup(f.server.Close)
}

func recordTestTime() time.Time {
	now := time.Now()
	year, month, day := now.Date()
	return time.Date(year, month, day, 12, 0, 0, 0, now.Location())
}

func (f *recordAdminFixture) catch(owner int64, id string, size float64, at time.Time) {
	f.t.Helper()
	f.sequence++
	ctx := context.Background()
	tx, err := f.db.Admin.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	key := fmt.Sprintf("record-fixture-%d", f.sequence)
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,$2,decode(repeat('22',32),'hex'))`, owner, key); err != nil {
		f.t.Fatal(err)
	}
	var operation int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,'fishing_settle','test-records') RETURNING id`, owner, key).Scan(&operation); err != nil {
		f.t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at) VALUES($1,1,$2,$3,$4,'map','dock',$5)`, operation, owner, id, size, at); err != nil {
		f.t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		f.t.Fatal(err)
	}
}

func (f *recordAdminFixture) top(id, rnge, kind string) []any {
	f.t.Helper()
	code, body := f.player("GET", "/api/records/top?id="+id+"&range="+rnge+"&kind="+kind, "")
	f.expect(code, body, 200, "")
	return body["top"].([]any)
}

func (f *recordAdminFixture) records() map[string]any {
	f.t.Helper()
	code, body := f.player("GET", "/api/records", "")
	f.expect(code, body, 200, "")
	return body
}

func recordDeleteBody(id, rnge, kind string, index int, entry map[string]any) map[string]any {
	return map[string]any{"id": id, "range": rnge, "kind": kind, "index": index, "who": entry["who"], "size": entry["size"], "t": entry["t"]}
}

func (f *recordAdminFixture) count(query string) int64 {
	f.t.Helper()
	var count int64
	if err := f.db.Admin.QueryRow(context.Background(), query).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}

// Record moderation changes only projections; the catch ledger, inventory,
// codex and asset accounting must survive both successful and failed requests.
func (f *recordAdminFixture) authority() string {
	f.t.Helper()
	var snapshot string
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT jsonb_build_object(
 'catches',(SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_id,ordinal) FROM fishing.catch_records r),
 'codex',(SELECT jsonb_agg(to_jsonb(c) ORDER BY owner_id,item_id) FROM fishing.player_codex c),
 'inventory',(SELECT jsonb_agg(to_jsonb(i) ORDER BY owner_id,item_id,tier) FROM fishing.inventory_stacks i),
 'operations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM fishing.asset_operations o),
 'entries',(SELECT jsonb_agg(to_jsonb(e) ORDER BY operation_id,account_id) FROM fishing.asset_entries e),
 'players',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM fishing.player_state p),
 'wallets',(SELECT jsonb_agg(to_jsonb(w) ORDER BY account_id) FROM fishing.wallets w))::text`).Scan(&snapshot); err != nil {
		f.t.Fatal(err)
	}
	return snapshot
}

func TestIntegrationLegacyAdminRecordsPermissionAndInput(t *testing.T) {
	f := newRecordAdminFixture(t)
	f.catch(f.playerID, "crucian", 40, recordTestTime())
	entry := f.top("crucian", "day", "big")[0].(map[string]any)
	valid := recordDeleteBody("crucian", "day", "big", 0, entry)
	before := f.authority()
	for _, path := range []string{"/api/admin/records/delete", "/api/admin/records/delone"} {
		for _, token := range []string{"", f.playerToken} {
			code, body := f.call("POST", path, jsonString(valid), token)
			f.expect(code, body, 401, "")
		}
		code, body := f.admin("POST", path, `null`)
		f.expect(code, body, 400, "")
	}

	invalid := []struct {
		field string
		value any
	}{
		{"id", ""}, {"id", "unknown_fish"}, {"id", "iron"}, {"id", 42},
		{"range", ""}, {"range", "month"}, {"range", 1},
		{"kind", ""}, {"kind", "large"}, {"kind", true},
		{"index", -1}, {"index", 10}, {"index", 0.5}, {"index", "0"},
		{"who", ""}, {"who", 42},
		{"size", 0}, {"size", -1}, {"size", "40"},
		{"t", -1}, {"t", 0.5}, {"t", "123"},
	}
	for _, field := range []string{"id", "range", "kind", "index", "who", "size", "t"} {
		for _, null := range []bool{false, true} {
			body := recordDeleteBody("crucian", "day", "big", 0, entry)
			if null {
				body[field] = nil
			} else {
				delete(body, field)
			}
			code, out := f.admin("POST", "/api/admin/records/delone", jsonString(body))
			if code != 400 {
				t.Fatalf("missing/null %s (null=%v): %d %v", field, null, code, out)
			}
		}
	}
	for _, in := range invalid {
		body := recordDeleteBody("crucian", "day", "big", 0, entry)
		body[in.field] = in.value
		code, out := f.admin("POST", "/api/admin/records/delone", jsonString(body))
		if code != 400 {
			t.Fatalf("invalid %s=%v: %d %v", in.field, in.value, code, out)
		}
	}
	for _, body := range []string{`{"id":"unknown_fish"}`, `{"id":"iron"}`, `{"id":42}`} {
		code, out := f.admin("POST", "/api/admin/records/delete", body)
		f.expect(code, out, 400, "")
	}
	for _, change := range []struct {
		field string
		value any
	}{{"who", "别的玩家"}, {"size", entry["size"].(float64) + 1}, {"t", entry["t"].(float64) + 1}, {"index", 9}} {
		body := recordDeleteBody("crucian", "day", "big", 0, entry)
		body[change.field] = change.value
		code, out := f.admin("POST", "/api/admin/records/delone", jsonString(body))
		f.expect(code, out, 409, "")
	}
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.identities SET admin=false WHERE username=$1`, f.adminKey); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/admin/records/delete", "/api/admin/records/delone"} {
		code, body := f.admin("POST", path, jsonString(valid))
		f.expect(code, body, 401, "")
	}
	if f.count(`SELECT count(*) FROM fishing.catch_record_hides`) != 0 || f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action LIKE 'records/%'`) != 0 || before != f.authority() {
		t.Fatal("rejected moderation changed records or audit")
	}
}

func TestIntegrationLegacyAdminRecordSingleBoardAndNewCatches(t *testing.T) {
	f := newRecordAdminFixture(t)
	_, other := f.register("record_other", "另一个玩家")
	now := recordTestTime()
	f.catch(f.playerID, "crucian", 55, now.AddDate(0, 0, -1))
	f.catch(f.playerID, "crucian", 50, now)
	f.catch(f.playerID, "crucian", 40, now.Add(time.Second))
	f.catch(other, "crucian", 30, now.Add(2*time.Second))
	before := f.authority()
	head := f.records()["records"].(map[string]any)["crucian"]
	entry := f.top("crucian", "day", "big")[0].(map[string]any)
	code, body := f.admin("POST", "/api/admin/records/delone", jsonString(recordDeleteBody("crucian", "day", "big", 0, entry)))
	f.expect(code, body, 200, "")
	if body["ok"] != true || body["id"] != "crucian" || body["range"] != "day" || body["kind"] != "big" || body["label"] == "" || body["removed"].(map[string]any)["size"] != float64(50) || body["purge"] != nil {
		t.Fatal("single-delete response", body)
	}
	if top := body["top"].([]any); len(top) != 1 || top[0].(map[string]any)["size"] != float64(30) {
		t.Fatal("deleted player's older score refilled the board", top)
	}
	for _, board := range [][2]string{{"day", "small"}, {"week", "big"}, {"week", "small"}, {"all", "big"}, {"all", "small"}} {
		if len(f.top("crucian", board[0], board[1])) != 2 {
			t.Fatal("single-board removal changed another board", board)
		}
	}
	if !reflect.DeepEqual(head, f.records()["records"].(map[string]any)["crucian"]) {
		t.Fatal("single-board removal changed record title")
	}
	// The historical all-time board also remains separate from record titles.
	entry = f.top("crucian", "all", "big")[0].(map[string]any)
	code, body = f.admin("POST", "/api/admin/records/delone", jsonString(recordDeleteBody("crucian", "all", "big", 0, entry)))
	f.expect(code, body, 200, "")
	if len(f.top("crucian", "all", "big")) != 1 || !reflect.DeepEqual(head, f.records()["records"].(map[string]any)["crucian"]) {
		t.Fatal("all-time board and record title were coupled")
	}
	if before != f.authority() {
		t.Fatal("single-board deletion mutated catch or asset authority")
	}
	// Hiding existing candidates does not permanently ban future catches.
	f.catch(f.playerID, "crucian", 45, now.Add(3*time.Second))
	if top := f.top("crucian", "day", "big"); len(top) != 2 || top[0].(map[string]any)["size"] != float64(45) {
		t.Fatal("new catch did not enter moderated board", top)
	}
	if f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action='records/delone'`) != 2 {
		t.Fatal("missing single-delete audits")
	}
	for _, raw := range f.auditLog() {
		entry := raw.(map[string]any)
		if entry["action"] == "records/delone" && (entry["name"] != "后台管理员" || entry["target"] != "crucian" || entry["detail"] == "") {
			t.Fatal("record audit omitted actor, target or detail", entry)
		}
	}
}

func TestIntegrationLegacyAdminRecordPurge(t *testing.T) {
	for _, purge := range []any{true, 1} {
		t.Run(fmt.Sprint(purge), func(t *testing.T) {
			f := newRecordAdminFixture(t)
			_, other := f.register("record_other", "另一个玩家")
			now := recordTestTime()
			f.catch(f.playerID, "crucian", 60, now)
			f.catch(f.playerID, "crucian", 60, now.Add(time.Second))
			f.catch(f.playerID, "crucian", 20, now.Add(2*time.Second))
			f.catch(other, "crucian", 40, now.Add(3*time.Second))
			before := f.authority()
			entry := f.top("crucian", "day", "big")[0].(map[string]any)
			in := recordDeleteBody("crucian", "day", "big", 0, entry)
			in["purge"] = purge
			code, body := f.admin("POST", "/api/admin/records/delone", jsonString(in))
			f.expect(code, body, 200, "")
			pg, ok := body["purge"].(map[string]any)
			if !ok || pg["boards"].(float64) < 1 || pg["big"] != float64(1) {
				t.Fatal("purge response", body)
			}
			for _, rnge := range []string{"day", "week", "all"} {
				for _, kind := range []string{"big", "small"} {
					for _, raw := range f.top("crucian", rnge, kind) {
						if raw.(map[string]any)["size"] == float64(60) {
							t.Fatal("purged catch remains visible", rnge, kind, raw)
						}
					}
				}
			}
			projection := f.records()
			if projection["records"].(map[string]any)["crucian"].(map[string]any)["size"] != float64(40) || projection["small"].(map[string]any)["crucian"].(map[string]any)["size"] != float64(20) || projection["globalMax"].(map[string]any)["size"] != float64(40) {
				t.Fatal("purge did not recompute extrema", projection)
			}
			if before != f.authority() {
				t.Fatal("purge mutated catch or asset authority")
			}
			// Same-name accounts remain distinct moderation subjects.
			_, sameName := f.register("record_same_name", "目标玩家")
			f.catch(sameName, "crucian", 65, now.Add(4*time.Second))
			f.catch(f.playerID, "crucian", 65, now.Add(5*time.Second))
			top := f.top("crucian", "all", "big")
			index := -1
			for i, raw := range top {
				if raw.(map[string]any)["playerId"] == strconv.FormatInt(f.playerID, 10) {
					index = i
				}
			}
			if index < 0 {
				t.Fatal("missing owner after new catch", top)
			}
			in = recordDeleteBody("crucian", "all", "big", index, top[index].(map[string]any))
			in["purge"] = purge
			code, body = f.admin("POST", "/api/admin/records/delone", jsonString(in))
			f.expect(code, body, 200, "")
			for _, rnge := range []string{"day", "week", "all"} {
				found := false
				for _, raw := range f.top("crucian", rnge, "big") {
					e := raw.(map[string]any)
					if e["playerId"] == strconv.FormatInt(sameName, 10) && e["size"] == float64(65) {
						found = true
					}
				}
				if !found {
					t.Fatal("purge removed a different account with the same name and size", rnge)
				}
			}
		})
	}
}

func TestIntegrationLegacyAdminRecordsDeleteFishAndAll(t *testing.T) {
	f := newRecordAdminFixture(t)
	now := recordTestTime()
	f.catch(f.playerID, "crucian", 30, now)
	f.catch(f.playerID, "carp", 70, now.Add(time.Second))
	before := f.authority()
	code, body := f.admin("POST", "/api/admin/records/delete", `{"id":"crucian"}`)
	f.expect(code, body, 200, "")
	if body["ok"] != true || body["id"] != "crucian" || body["removed"] == nil || body["last"] != nil || body["records"].(map[string]any)["crucian"] != nil || body["small"].(map[string]any)["crucian"] != nil || body["globalMax"].(map[string]any)["id"] != "carp" {
		t.Fatal("delete-fish response", body)
	}
	for _, rnge := range []string{"day", "week", "all"} {
		for _, kind := range []string{"big", "small"} {
			if len(f.top("crucian", rnge, kind)) != 0 || len(f.top("carp", rnge, kind)) != 1 {
				t.Fatal("delete fish crossed item boundary", rnge, kind)
			}
		}
	}
	code, body = f.admin("POST", "/api/admin/records/delete", `{}`)
	f.expect(code, body, 200, "")
	if body["id"] != nil || len(body["records"].(map[string]any)) != 0 || len(body["small"].(map[string]any)) != 0 || body["globalMax"] != nil || body["last"] != nil {
		t.Fatal("delete-all response", body)
	}
	if before != f.authority() {
		t.Fatal("bulk deletion mutated catch or asset authority")
	}
	if f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action='records/delete'`) != 2 {
		t.Fatal("missing bulk-delete audits")
	}
	for i := 0; i < 2; i++ {
		f.restart(time.Local)
		if got := f.records(); len(got["records"].(map[string]any)) != 0 || got["globalMax"] != nil || len(f.top("carp", "all", "big")) != 0 {
			t.Fatal("new API instance lost record moderation", i, got)
		}
	}
	// Repeat clears are successful, and future catches start a fresh projection.
	code, body = f.admin("POST", "/api/admin/records/delete", `{"id":""}`)
	f.expect(code, body, 200, "")
	f.catch(f.playerID, "crucian", 25, now.Add(2*time.Second))
	if top := f.top("crucian", "all", "big"); len(top) != 1 || top[0].(map[string]any)["size"] != float64(25) {
		t.Fatal("clear suppressed a future catch", top)
	}
}

func TestIntegrationLegacyAdminRecordsCalendarWindowAndSmallBoard(t *testing.T) {
	f := newRecordAdminFixture(t)
	loc := time.FixedZone("records-west", -7*60*60)
	f.restart(loc)
	now := time.Now().In(loc)
	year, month, day := now.Date()
	from := time.Date(year, month, day, 0, 0, 0, 0, loc)
	week := mondayOf(now)
	_, yesterday := f.register("record_yesterday", "昨日玩家")
	_, tomorrow := f.register("record_tomorrow", "明日玩家")
	_, oldWeek := f.register("record_old_week", "上周玩家")
	f.catch(f.playerID, "crucian", 10, from)
	f.catch(f.playerID, "crucian", 15, from.Add(time.Second))
	f.catch(yesterday, "crucian", 5, from.Add(-time.Millisecond))
	f.catch(tomorrow, "crucian", 1, from.AddDate(0, 0, 1))
	f.catch(oldWeek, "crucian", 2, week.Add(-time.Millisecond))
	dayTop := f.top("crucian", "day", "small")
	if len(dayTop) != 1 || dayTop[0].(map[string]any)["size"] != float64(10) {
		t.Fatal("day boundaries did not use configured timezone", dayTop)
	}
	weekTop := f.top("crucian", "week", "small")
	if len(weekTop) < 1 {
		t.Fatal("week board omitted in-window catch")
	}
	for _, raw := range weekTop {
		entry := raw.(map[string]any)
		stamp := int64(entry["t"].(float64))
		if stamp < week.UnixMilli() || stamp >= week.AddDate(0, 0, 7).UnixMilli() || entry["playerId"] == strconv.FormatInt(oldWeek, 10) {
			t.Fatal("week boundaries did not use configured timezone", weekTop)
		}
	}
	before := f.authority()
	in := recordDeleteBody("crucian", "day", "small", 0, dayTop[0].(map[string]any))
	code, body := f.admin("POST", "/api/admin/records/delone", jsonString(in))
	f.expect(code, body, 200, "")
	if body["kind"] != "small" || len(body["top"].([]any)) != 0 || len(f.top("crucian", "day", "big")) != 1 || !reflect.DeepEqual(weekTop, f.top("crucian", "week", "small")) || before != f.authority() {
		t.Fatal("small-day deletion changed another projection or authority", body)
	}
}

func TestIntegrationLegacyAdminRecordsAuditRollback(t *testing.T) {
	f := newRecordAdminFixture(t)
	f.catch(f.playerID, "crucian", 40, recordTestTime())
	before := f.authority()
	entry := f.top("crucian", "day", "big")[0].(map[string]any)
	ctx := context.Background()
	if _, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_record_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_record_audit BEFORE INSERT ON fishing.admin_audit FOR EACH ROW EXECUTE FUNCTION fishing.fail_record_audit()`); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ path, body string }{
		{"/api/admin/records/delete", `{"id":"crucian"}`},
		{"/api/admin/records/delone", jsonString(recordDeleteBody("crucian", "day", "big", 0, entry))},
	} {
		code, body := f.admin("POST", request.path, request.body)
		if code != 503 {
			t.Fatal("audit failure was not exposed", request.path, code, body)
		}
		if f.count(`SELECT count(*) FROM fishing.catch_record_hides`) != 0 || f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action LIKE 'records/%'`) != 0 || len(f.top("crucian", "day", "big")) != 1 || before != f.authority() {
			t.Fatal("failed audit left a partial moderation", request.path)
		}
	}
	if _, err := f.db.Admin.Exec(ctx, `DROP TRIGGER fail_record_audit ON fishing.admin_audit`); err != nil {
		t.Fatal(err)
	}
	code, body := f.admin("POST", "/api/admin/records/delone", jsonString(recordDeleteBody("crucian", "day", "big", 0, entry)))
	f.expect(code, body, 200, "")
	if f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action='records/delone'`) != 1 {
		t.Fatal("retry did not leave exactly one audit")
	}
}

func TestIntegrationLegacyAdminRecordsConcurrentDeleteOne(t *testing.T) {
	f := newRecordAdminFixture(t)
	_, other := f.register("record_other", "另一个玩家")
	now := recordTestTime()
	f.catch(f.playerID, "crucian", 50, now)
	f.catch(other, "crucian", 30, now.Add(time.Second))
	before := f.authority()
	entry := f.top("crucian", "day", "big")[0].(map[string]any)
	in := jsonString(recordDeleteBody("crucian", "day", "big", 0, entry))
	var codes [2]int
	var bodies [2]map[string]any
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i], bodies[i] = f.admin("POST", "/api/admin/records/delone", in)
		}(i)
	}
	close(start)
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[1] == 200 && codes[0] == 409)) {
		t.Fatal("concurrent delete results", codes, bodies)
	}
	if top := f.top("crucian", "day", "big"); len(top) != 1 || top[0].(map[string]any)["size"] != float64(30) {
		t.Fatal("concurrent delete removed the next player's score", top)
	}
	if f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action='records/delone'`) != 1 || before != f.authority() {
		t.Fatal("concurrent delete duplicated audit or changed authority")
	}
	for _, statement := range []string{`DELETE FROM fishing.catch_records`, `UPDATE fishing.catch_records SET size=size+1`, `DELETE FROM fishing.catch_record_hides`} {
		if _, err := f.db.App.Exec(context.Background(), statement); err == nil {
			t.Fatal("runtime can mutate immutable moderation history", statement)
		}
	}
}

func TestIntegrationLegacyAdminRecordsConcurrentRankShift(t *testing.T) {
	f := newRecordAdminFixture(t)
	_, second := f.register("record_second", "第二名玩家")
	_, third := f.register("record_third", "第三名玩家")
	now := recordTestTime()
	f.catch(f.playerID, "crucian", 50, now)
	f.catch(second, "crucian", 40, now.Add(time.Second))
	f.catch(third, "crucian", 30, now.Add(2*time.Second))
	before := f.authority()
	top := f.top("crucian", "day", "big")
	firstRequest := jsonString(recordDeleteBody("crucian", "day", "big", 0, top[0].(map[string]any)))
	secondRequest := jsonString(recordDeleteBody("crucian", "day", "big", 1, top[1].(map[string]any)))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := f.db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `SELECT revision FROM fishing.catch_record_moderation_guard WHERE singleton FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	var codes [2]int
	var bodies [2]map[string]any
	var wg sync.WaitGroup
	waitForBlocked := func(want int) {
		t.Helper()
		// Observe actual lock waiters rather than using a delay to guess when
		// each request has established its transaction snapshot.
		for {
			var count int
			if err := f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
 WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'
 AND query LIKE '%UPDATE fishing.catch_record_moderation_guard%'`, f.db.Role).Scan(&count); err != nil {
				t.Fatal("cannot observe record moderation lock waiters", err)
			}
			if count >= want {
				return
			}
			if ctx.Err() != nil {
				t.Fatal("record moderation never reached the guarded transaction", want, count, ctx.Err())
			}
		}
	}
	for i, body := range []string{firstRequest, secondRequest} {
		wg.Add(1)
		go func(i int, request string) {
			defer wg.Done()
			codes[i], bodies[i] = f.admin("POST", "/api/admin/records/delone", request)
		}(i, body)
		waitForBlocked(i + 1)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if codes[0] != 200 || codes[1] != 409 {
		t.Fatal("queued rank edits did not reject the outdated snapshot", codes, bodies)
	}
	current := f.top("crucian", "day", "big")
	if len(current) != 2 || current[0].(map[string]any)["size"] != float64(40) || current[1].(map[string]any)["size"] != float64(30) {
		t.Fatal("concurrent rank movement deleted the wrong score", current)
	}
	responseTop := bodies[0]["top"].([]any)
	if len(responseTop) != len(current) {
		t.Fatal("successful moderation returned a stale board", responseTop, current)
	}
	for i, raw := range responseTop {
		entry, latest := raw.(map[string]any), current[i].(map[string]any)
		for _, field := range []string{"size", "who", "t", "playerId"} {
			if entry[field] != latest[field] {
				t.Fatal("successful moderation returned a stale board", responseTop, current)
			}
		}
	}
	if f.count(`SELECT count(*) FROM fishing.admin_audit WHERE action='records/delone'`) != 1 || before != f.authority() {
		t.Fatal("rank conflict leaked audit or modified authority")
	}
}
