package migration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

func rwFixtureFile(t *testing.T, root, name string, value any) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, rwJSON(value), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestIntegrationRealWorldAndWikiReconcile(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	user, err := identity.New(db.App, nil).Register(ctx, identity.Registration{Username: "migration_user", Name: "Migration user", Password: "Synthetic-Pass42", QQ: "000001"})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	at := time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC).UnixMilli()
	rwFixtureFile(t, root, "feedback.json", map[string]any{"feedback": []any{map[string]any{"id": "feedback-1", "key": "migration_user", "name": "original display", "kind": "bug", "text": "preserved synthetic body", "version": "v0.21.4", "status": "done", "t": at, "statusAt": at + 1000, "statusBy": "migration_user", "reward": map[string]any{"coins": 7, "total": 7}}}, "feedbackMeta": map[string]any{"migration_user": map[string]any{"lastAt": at, "nextAt": at + 86400000}, "deleted_synthetic": map[string]any{"lastAt": at - 1000, "nextAt": at}}})
	audit := map[string]any{"key": "migration_user", "name": "original display", "target": "migration_user", "action": "settings", "detail": "synthetic audit", "t": at}
	feedbackSource, err := rwRead(root, "feedback.json")
	if err != nil {
		t.Fatal(err)
	}
	rwMap(rwMap(feedbackSource["feedbackMeta"])["migration_user"])["nextAt"] = 0
	rwFixtureFile(t, root, "feedback.json", feedbackSource)
	rwFixtureFile(t, root, "admin.json", map[string]any{"adminLog": []any{audit, audit}})
	rwFixtureFile(t, root, "stats.json", map[string]any{"statMin": []any{map[string]any{"t": at, "online": 4, "fishing": 2, "listings": 3, "trades": 1, "users": 8, "grounds": map[string]any{"map": 2}, "spots": map[string]any{"map:dock": 2}}}, "statHour": []any{map[string]any{"t": at, "n": 1, "oSum": 4, "oMax": 4, "fSum": 2, "lSum": 3, "trSum": 1, "uLast": 8}}, "statPeak": map[string]any{"online": 10, "t": at - 1}})
	rwFixtureFile(t, root, "records.json", map[string]any{"bigRecords": map[string]any{}, "topCatches": map[string]any{}, "rank": map[string]any{}, "lastRec": nil})
	rwFixtureFile(t, root, "snapshots/migration_user/1790067600000.json", map[string]any{"coins": 12, "inventory": map[string]any{"crucian": 3}, "pwHash": "must-not-be-in-runtime-snapshots", "adminTotpSecret": "must-not-be-in-runtime-snapshots"})
	rwFixtureFile(t, root, "snapshots/retired_source/1790067600000.json", map[string]any{"coins": 9, "inventory": map[string]any{}})
	wiki := map[string]any{"format": 1, "integrity": "ok", "foreignKeyViolations": 0, "tables": map[string]any{
		"wiki_meta":       []any{map[string]any{"key": "official_revision", "value": "3"}, map[string]any{"key": "user_revision", "value": "2"}},
		"guides":          []any{map[string]any{"id": "synthetic-guide", "kind": "user", "status": "approved", "title": "Synthetic title", "category": "test", "summary": "summary", "tags_json": "[\"tag\"]", "aliases_json": "[]", "author_key": "migration_user", "author_name": "original display", "submitted_at": at, "reviewed_at": at + 1000, "reviewed_by": "migration_user", "review_note": "ok", "deleted_at": nil, "deleted_by": "", "delete_reason": "", "revision": 2, "sort_order": 0, "created_at": "2026-09-20", "updated_at": "2026-09-21"}},
		"guide_sections":  []any{map[string]any{"guide_id": "synthetic-guide", "ord": 0, "heading": "heading", "type": "p", "text": "body", "items_json": "[]"}},
		"updates":         []any{map[string]any{"id": "u1", "date": "2026-09-20", "title": "update title", "summary": "update body", "sort_order": 0}},
		"guide_revisions": []any{map[string]any{"id": 4, "guide_id": "synthetic-guide", "revision": 2, "action": "approve", "actor_key": "migration_user", "actor_name": "original reviewer", "snapshot_json": "{\"title\":\"before\"}", "created_at": at}},
	}}
	rwFixtureFile(t, root, "wiki-export.json", wiki)
	tx, err := db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	rc := &RealContext{Tx: tx, IDs: map[string]int64{"migration_user": user.Session.AccountID}, Root: root, Now: time.Now()}
	if err = ImportRealWorld(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ImportRealWiki(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealWorld(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealWiki(ctx, rc); err != nil {
		t.Fatal(err)
	}
	var audits int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM fishing.admin_audit`).Scan(&audits); err != nil || audits != 2 {
		t.Fatal("duplicate historical audit entries lost", err)
	}
	var snapshots string
	if err = tx.QueryRow(ctx, `SELECT string_agg(value::text,'') FROM fishing.operator_settings WHERE key LIKE 'users:snapshots:%'`).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(snapshots, "must-not") || strings.Contains(snapshots, "pwHash") || strings.Contains(snapshots, "adminTotp") {
		t.Fatal("snapshot exposes credentials")
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.feedback_entries SET body='corrupted' WHERE id='feedback-1'`); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealWorld(ctx, rc); err == nil {
		t.Fatal("changed feedback field was not detected")
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_guides SET tags='["corrupted"]' WHERE id='synthetic-guide'`); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealWiki(ctx, rc); err == nil {
		t.Fatal("changed Wiki field was not detected")
	}
}

func TestRealWikiRejectsUnverifiedExport(t *testing.T) {
	root := t.TempDir()
	rwFixtureFile(t, root, "wiki-export.json", map[string]any{"format": 1, "integrity": "failed", "foreignKeyViolations": 0})
	if err := ImportRealWiki(context.Background(), &RealContext{Root: root}); err == nil {
		t.Fatal("unverified SQLite export accepted")
	}
	if _, err := rwWikiJSON(json.Number("3"), true); err == nil {
		t.Fatal("invalid embedded JSON accepted")
	}
}
