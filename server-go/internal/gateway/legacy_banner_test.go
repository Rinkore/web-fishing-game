package gateway

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func addTestBanner(t *testing.T, f *adminFixture, content string) string {
	t.Helper()
	code, body := f.admin("POST", "/api/admin/banner/add", jsonString(map[string]any{"content": content, "duration": 3.25, "color": "#abc"}))
	f.expect(code, body, 200, "")
	b := body["banner"].(map[string]any)
	if b["duration"] != 3.3 || b["by"] != "后台管理员" {
		t.Fatalf("banner fields: %v", b)
	}
	return b["id"].(string)
}

func TestIntegrationLegacyBannerConsoleAndDelivery(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	p := &legacyBannerPush{api: &API{pool: f.db.App}}
	p.init(ctx)
	if initial := decodePersonalFrames(t, p.poll(ctx)); len(initial) != 1 || len(initial[0]["banners"].([]any)) != 0 {
		t.Fatalf("initial: %v", initial)
	}
	code, body := f.player("GET", "/api/admin/banner", "")
	if code == 200 {
		t.Fatal("player read console", body)
	}
	for _, action := range []string{"add", "update", "move", "remove", "cfg", "stop", "clear"} {
		code, body = f.player("POST", "/api/admin/banner/"+action, `{}`)
		if code == 200 {
			t.Fatalf("player mutation %s: %v", action, body)
		}
	}
	a := addTestBanner(t, f, "第一条")
	b := addTestBanner(t, f, "第二条")
	code, body = f.admin("POST", "/api/admin/banner/move", jsonString(map[string]any{"id": b, "dir": "up"}))
	f.expect(code, body, 200, "")
	if body["banners"].([]any)[0].(map[string]any)["id"] != b {
		t.Fatal("move failed", body)
	}
	code, body = f.admin("POST", "/api/admin/banner/update", jsonString(map[string]any{"id": a, "content": "更改后", "duration": 7, "color": ""}))
	f.expect(code, body, 200, "")
	code, body = f.admin("POST", "/api/admin/banner/cfg", `{"blink":true,"blinkTitle":"新公告","noticeColor":"#AABBCC","catchLevel":"fish"}`)
	f.expect(code, body, 200, "")
	frames := decodePersonalFrames(t, p.poll(ctx))
	if len(frames) != 5 || frames[4]["cfg"].(map[string]any)["blink"] != true {
		t.Fatalf("durable publications: %v", frames)
	}
	code, body = f.player("POST", "/api/banner/playing", jsonString(map[string]any{"id": a}))
	f.expect(code, body, 200, "")
	code, body = f.admin("GET", "/api/admin/banner", "")
	f.expect(code, body, 200, "")
	playing := body["playing"].([]any)
	if len(playing) != 1 || playing[0].(map[string]any)["content"] != "更改后" || playing[0].(map[string]any)["count"] != float64(1) {
		t.Fatalf("watcher: %v", playing)
	}
	code, body = f.admin("POST", "/api/admin/banner/stop", jsonString(map[string]any{"id": a}))
	f.expect(code, body, 200, "")
	frames = decodePersonalFrames(t, p.poll(ctx))
	if len(frames) != 1 || frames[0]["type"] != "bannerStop" || frames[0]["id"] != a {
		t.Fatalf("stop event: %v", frames)
	}
	code, body = f.player("GET", "/api/banner", "")
	f.expect(code, body, 200, "")
	if len(body["banners"].([]any)) != 2 {
		t.Fatal("stop deleted queue", body)
	}
	code, body = f.admin("POST", "/api/admin/banner/remove", jsonString(map[string]any{"id": b}))
	f.expect(code, body, 200, "")
	code, body = f.admin("POST", "/api/admin/banner/clear", `{}`)
	f.expect(code, body, 200, "")
	if body["cleared"] != float64(1) {
		t.Fatalf("clear count: %v", body)
	}
	frames = decodePersonalFrames(t, p.poll(ctx))
	if len(frames) != 3 || frames[2]["type"] != "bannerStop" || frames[2]["id"] != a {
		t.Fatalf("clear events: %v", frames)
	}
	code, body = f.player("POST", "/api/banner/playing", jsonString(map[string]any{"id": a}))
	f.expect(code, body, 200, "")
	if body["ignored"] != true {
		t.Fatal("unknown banner watcher", body)
	}
	var audits, events, watchers int
	if err := f.db.Admin.QueryRow(ctx, `SELECT (SELECT count(*) FROM fishing.admin_audit WHERE action LIKE 'banner/%'),(SELECT count(*) FROM fishing.banner_events),(SELECT count(*) FROM fishing.banner_watchers)`).Scan(&audits, &events, &watchers); err != nil {
		t.Fatal(err)
	}
	if audits != 8 || events != 8 || watchers != 0 {
		t.Fatal("audit/event/watch state", audits, events, watchers)
	}
}

func TestIntegrationLegacyBannerRollbackConflictAndRetry(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	a := addTestBanner(t, f, "保留内容")
	for _, body := range []string{
		`{"id":"` + a + `","content":"被拒绝内容","color":"javascript:alert(1)"}`,
		`{"id":"` + a + `","content":"","duration":1}`,
		`{"id":"` + a + `","duration":0}`,
	} {
		code, result := f.admin("POST", "/api/admin/banner/update", body)
		f.expect(code, result, 400, "")
	}
	// Two edits based on the same revision cannot both publish.
	var codes [2]int
	var results [2]map[string]any
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], results[i] = f.admin("POST", "/api/admin/banner/update", jsonString(map[string]any{"id": a, "content": fmt.Sprintf("编辑%d", i), "expectedRevision": 1}))
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[1] == 200 && codes[0] == 409)) {
		t.Fatal("conflict", codes, results)
	}
	if _, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_banner_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_banner_audit BEFORE INSERT ON fishing.admin_audit FOR EACH ROW EXECUTE FUNCTION fishing.fail_banner_audit()`); err != nil {
		t.Fatal(err)
	}
	code, body := f.admin("POST", "/api/admin/banner/clear", `{}`)
	if code == 200 {
		t.Fatal("injected audit failure accepted", body)
	}
	state, err := readLegacyBanners(ctx, f.db.App, false)
	if err != nil || state.Revision != 2 || len(state.Banners) != 1 {
		t.Fatal("partial commit", state, err)
	}
	var count int
	if err := f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.banner_events`).Scan(&count); err != nil || count != 2 {
		t.Fatal("orphan publication", count, err)
	}
	if _, err := f.db.Admin.Exec(ctx, `DROP TRIGGER fail_banner_audit ON fishing.admin_audit`); err != nil {
		t.Fatal(err)
	}
	p := &legacyBannerPush{api: &API{pool: f.db.App}}
	p.init(ctx)
	p.poll(ctx)
	// A slow stream drains all stop operations, including the tail after 16.
	for i := 0; i < 18; i++ {
		code, body = f.admin("POST", "/api/admin/banner/stop", jsonString(map[string]any{"id": a}))
		f.expect(code, body, 200, "")
	}
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(ctx, "REVOKE SELECT ON fishing.banner_events FROM "+role); err != nil {
		t.Fatal(err)
	}
	if frames := p.poll(ctx); len(frames) != 0 || p.revision != 2 {
		t.Fatal("read failure acknowledged", frames, p.revision)
	}
	if _, err := f.db.Admin.Exec(ctx, "GRANT SELECT ON fishing.banner_events TO "+role); err != nil {
		t.Fatal(err)
	}
	if frames := p.poll(ctx); len(frames) != 16 {
		t.Fatal("first page", len(frames))
	}
	if frames := p.poll(ctx); len(frames) != 2 {
		t.Fatal("tail page", len(frames))
	}
	if frames := p.poll(ctx); len(frames) != 0 {
		t.Fatal("duplicate page", len(frames))
	}
	reconnect := &legacyBannerPush{api: &API{pool: f.db.App}}
	reconnect.init(ctx)
	if frames := decodePersonalFrames(t, reconnect.poll(ctx)); len(frames) != 1 || frames[0]["type"] != "banner" {
		t.Fatal("reconnect replayed historical stops", frames)
	}
	if _, err := f.db.Admin.Exec(ctx, "UPDATE fishing.banner_events SET frames='[]' WHERE revision=1"); err == nil {
		t.Fatal("publication is mutable")
	}
}

func TestIntegrationLegacyBannerLiveStreamAndInitWindow(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	p := &legacyBannerPush{api: &API{pool: f.db.App}}
	p.init(ctx)
	id := addTestBanner(t, f, "连接中发布")
	if frames := decodePersonalFrames(t, p.poll(ctx)); len(frames) != 2 || frames[1]["banners"].([]any)[0].(map[string]any)["id"] != id {
		t.Fatal("init window lost publication", frames)
	}
	fixture := &legacyTradeFixture{server: f.server, client: f.server.Client(), token: map[string]string{"viewer": f.playerToken}}
	feed := openLegacyTradeStream(t, fixture, "viewer")
	defer feed.cancel()
	feed.wait(t, "init", 10*time.Second)
	first := feed.wait(t, "banner", 10*time.Second)
	if len(first["banners"].([]any)) != 1 {
		t.Fatal("stream lacks current banners", first)
	}
	code, body := f.admin("POST", "/api/admin/banner/stop", jsonString(map[string]any{"id": id}))
	f.expect(code, body, 200, "")
	stop := feed.wait(t, "bannerStop", 10*time.Second)
	if stop["id"] != id {
		t.Fatal("live stop", stop)
	}
	code, body = f.player("POST", "/api/banner/playing", jsonString(map[string]any{"id": id}))
	f.expect(code, body, 200, "")
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.banner_watchers SET last_at=clock_timestamp()-interval '16 seconds'`); err != nil {
		t.Fatal(err)
	}
	code, body = f.admin("GET", "/api/admin/banner", "")
	f.expect(code, body, 200, "")
	if len(body["playing"].([]any)) != 0 {
		t.Fatal("expired viewer counted", body)
	}
}
