package gateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"

	"fishing.local/server/internal/wiki"
)

const wikiSubmission = `{"title":"投稿验证","category":"心得分享","summary":"合成测试","tags":["测试"],"sections":[{"h":"思路","type":"p","text":"合成正文"}]}`

func TestIntegrationWikiModeration(t *testing.T) {
	t.Setenv("WIKI_GUIDE_AUTO_APPROVE", "0")
	f := newAdminFixture(t)
	ctx := context.Background()
	for _, p := range []struct{ method, path string }{
		{"GET", "/api/admin/wiki/content"}, {"POST", "/api/admin/wiki/content"}, {"GET", "/api/admin/wiki/guides"},
		{"POST", "/api/admin/wiki/guides/review"}, {"POST", "/api/admin/wiki/guides/delete"},
	} {
		for _, token := range []string{"", f.playerToken} {
			code, b := f.call(p.method, p.path, `{}`, token)
			f.expect(code, b, 401, "")
		}
	}
	code, b := f.call("POST", "/api/wiki/guides/submit", wikiSubmission, "")
	f.expect(code, b, 401, "")
	code, b = f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
	f.expect(code, b, 200, "")
	id := b["guideId"].(string)
	if b["status"] != "pending" || b["autoApproved"] != false {
		t.Fatal(b)
	}
	code, b = f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
	f.expect(code, b, 429, "")
	code, b = f.player("GET", "/api/wiki/guides/"+id, "")
	f.expect(code, b, 404, "")
	code, b = f.admin("GET", "/api/admin/wiki/guides", "")
	f.expect(code, b, 200, "")
	if b["status"] != "pending" || len(b["guides"].([]any)) != 1 {
		t.Fatal("default moderation filter", b)
	}
	other, _ := f.register("wiki_other", "其他作者")
	code, b = f.call("POST", "/api/wiki/guides/delete", jsonString(map[string]any{"id": id}), other)
	f.expect(code, b, 404, "")
	code, b = f.admin("POST", "/api/admin/wiki/guides/review", jsonString(map[string]any{"id": id, "action": "approve", "expectedStatus": "pending"}))
	f.expect(code, b, 200, "")
	code, b = f.admin("POST", "/api/admin/wiki/guides/review", jsonString(map[string]any{"id": id, "action": "reject", "expectedStatus": "pending", "note": "过期操作"}))
	f.expect(code, b, 409, "")
	if b["currentStatus"] != "approved" {
		t.Fatal("missing current status", b)
	}
	code, b = f.player("GET", "/api/wiki/guides/"+id, "")
	f.expect(code, b, 200, "")
	if _, leak := b["guide"].(map[string]any)["reviewNote"]; leak {
		t.Fatal("private review leaked")
	}
	code, b = f.player("POST", "/api/wiki/guides/delete", jsonString(map[string]any{"id": id}))
	f.expect(code, b, 400, "")
	// Audit failure must roll back status, revision and the revision snapshot together.
	if _, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_wiki_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_wiki_audit BEFORE INSERT ON fishing.admin_audit FOR EACH ROW EXECUTE FUNCTION fishing.fail_wiki_audit()`); err != nil {
		t.Fatal(err)
	}
	code, b = f.admin("POST", "/api/admin/wiki/guides/delete", jsonString(map[string]any{"id": id, "reason": "删除"}))
	if code < 500 {
		t.Fatal("audit failure accepted", code, b)
	}
	code, b = f.player("GET", "/api/wiki/guides/"+id, "")
	f.expect(code, b, 200, "")
	if _, err := f.db.Admin.Exec(ctx, `DROP TRIGGER fail_wiki_audit ON fishing.admin_audit`); err != nil {
		t.Fatal(err)
	}
	code, b = f.admin("POST", "/api/admin/wiki/guides/delete", jsonString(map[string]any{"id": id, "reason": "删除"}))
	f.expect(code, b, 200, "")
	code, b = f.player("GET", "/api/wiki/guides/"+id, "")
	f.expect(code, b, 404, "")
	var revisions int
	if err := f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.wiki_revisions WHERE guide_id=$1`, id).Scan(&revisions); err != nil || revisions != 3 {
		t.Fatal("missing/partial revision trail", revisions, err)
	}
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.wiki_revisions SET action='tampered' WHERE guide_id=$1`, id); err == nil {
		t.Fatal("revision is mutable")
	}
}

func TestIntegrationWikiQuotaAndRestart(t *testing.T) {
	t.Setenv("WIKI_GUIDE_AUTO_APPROVE", "1")
	f := newAdminFixture(t)
	ctx := context.Background()
	// Two independent gateway instances must seed once and enforce one cooldown.
	other := httptest.NewServer(New(f.db.App, nil))
	defer other.Close()
	second := *f
	second.server = other
	var wg sync.WaitGroup
	codes := make([]int, 2)
	bodies := make([]map[string]any, 2)
	for i, instance := range []*adminFixture{f, &second} {
		wg.Add(1)
		go func(i int, f *adminFixture) {
			defer wg.Done()
			codes[i], bodies[i] = f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
		}(i, instance)
	}
	wg.Wait()
	if !(codes[0] == 200 && codes[1] == 429 || codes[0] == 429 && codes[1] == 200) {
		t.Fatal("concurrent seed/submit", codes, bodies)
	}
	for i := 0; i < 2; i++ {
		if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.wiki_guides SET submitted_at=clock_timestamp()-interval '11 minutes' WHERE kind='user'`); err != nil {
			t.Fatal(err)
		}
		code, b := f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
		f.expect(code, b, 200, "")
	}
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.wiki_guides SET submitted_at=clock_timestamp()-interval '11 minutes' WHERE kind='user'`); err != nil {
		t.Fatal(err)
	}
	fresh := httptest.NewServer(New(f.db.App, nil))
	defer fresh.Close()
	f.server = fresh
	code, b := f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
	f.expect(code, b, 429, "24 小时内最多提交 3 篇攻略")
	code, b = f.player("GET", "/api/wiki/guides/my", "")
	f.expect(code, b, 200, "")
	if len(b["guides"].([]any)) != 3 {
		t.Fatal("restart lost submissions", b)
	}
	// Pending quota applies even after the 24h window expires.
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.wiki_guides SET status='pending',reviewed_by='',submitted_at=clock_timestamp()-interval '25 hours' WHERE kind='user'`); err != nil {
		t.Fatal(err)
	}
	code, b = f.player("POST", "/api/wiki/guides/submit", wikiSubmission)
	f.expect(code, b, 429, "待审核攻略最多 3 篇")
}

func TestIntegrationWikiOfficialConflictAndRollback(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	code, b := f.admin("GET", "/api/admin/wiki/content", "")
	f.expect(code, b, 200, "")
	revision := b["officialRevision"].(float64)
	content := map[string]any{"guides": b["guides"], "updates": b["updates"]}
	payload := jsonString(map[string]any{"baseRevision": revision, "content": content})
	codes := make([]int, 2)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func(i int) { defer wg.Done(); codes[i], _ = f.admin("POST", "/api/admin/wiki/content", payload) }(i)
	}
	wg.Wait()
	if !(codes[0] == 200 && codes[1] == 409 || codes[0] == 409 && codes[1] == 200) {
		t.Fatal("official conflict", codes)
	}
	if _, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_wiki_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_wiki_snapshot BEFORE INSERT ON fishing.wiki_revisions FOR EACH ROW EXECUTE FUNCTION fishing.fail_wiki_snapshot()`); err != nil {
		t.Fatal(err)
	}
	code, b = f.admin("POST", "/api/admin/wiki/content", jsonString(map[string]any{"baseRevision": revision + 1, "reset": true}))
	if code < 500 {
		t.Fatal("snapshot failure accepted", code, b)
	}
	got, _, _, _, err := wiki.NewStore(f.db.App).Official(ctx)
	if err != nil || got != int64(revision)+1 {
		t.Fatal("partial official commit", got, err)
	}
	for i := 0; i < 2; i++ {
		var n int
		if err := f.db.Admin.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM fishing.wiki_%s`, []string{"guides", "sections"}[i])).Scan(&n); err != nil || n == 0 {
			t.Fatal("lost official content", n, err)
		}
	}
}
