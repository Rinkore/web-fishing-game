package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
)

// This fixture exercises the orchestrator, not SQLite itself. The production
// preparer validates SQLite and exports it before this command may run.
func completeRealSafetyFixture(t *testing.T, alias bool, extraConfig bool) string {
	t.Helper()
	root := t.TempDir()
	at := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	accountKey := "fixture_user"
	if alias {
		accountKey = "source_file_alias"
	}
	rwFixtureFile(t, root, "accounts/"+accountKey+".json", map[string]any{"username": "fixture_user", "id": "old-public-id", "name": "Synthetic account", "qq": "000001", "pwHash": strings.Repeat("a", 64), "salt": "synthetic-salt", "coins": 123, "createdAt": at, "inventory": map[string]any{"crucian": 3}, "bd": map[string]any{}, "rodSlots": []any{}, "codex": map[string]any{}, "catchCount": 3})
	config := map[string]any{"bannerSeq": 1, "banners": []any{}, "bannerCfg": map[string]any{}}
	if extraConfig {
		config["unknownFutureConfiguration"] = map[string]any{"enabled": true}
	}
	rwFixtureFile(t, root, "config.json", config)
	rwFixtureFile(t, root, "market.json", map[string]any{"listingSeq": 1, "listings": []any{}})
	rwFixtureFile(t, root, "economy.json", map[string]any{"shopSales": map[string]any{}, "priceLog": map[string]any{}, "tradeLog": map[string]any{}, "marketLog": []any{}, "economyLog": []any{}, "priceOv": map[string]any{}})
	rwFixtureFile(t, root, "records.json", map[string]any{"bigRecords": map[string]any{}, "smallRecords": map[string]any{}, "topCatches": map[string]any{}, "topSmall": map[string]any{}, "rank": map[string]any{}, "globalMax": nil, "lastRec": nil})
	rwFixtureFile(t, root, "feedback.json", map[string]any{"feedback": []any{map[string]any{"id": "synthetic-feedback", "key": "fixture_user", "name": "Synthetic account", "kind": "bug", "text": "Synthetic body", "version": "v0.21.4", "status": "done", "t": at, "statusAt": at + 1000, "statusBy": "fixture_user"}}, "feedbackMeta": map[string]any{}})
	rwFixtureFile(t, root, "admin.json", map[string]any{"adminLog": []any{}})
	rwFixtureFile(t, root, "stats.json", map[string]any{"statMin": []any{}, "statHour": []any{}, "statPeak": map[string]any{"online": 0, "t": at}})
	rwFixtureFile(t, root, "sessions.json", map[string]any{"synthetic_token": map[string]any{"key": "fixture_user", "expires": at + 60000}})
	rwFixtureFile(t, root, "wiki-export.json", map[string]any{"format": 1, "integrity": "ok", "foreignKeyViolations": 0, "tables": map[string]any{"wiki_meta": []any{map[string]any{"key": "official_revision", "value": "1"}, map[string]any{"key": "user_revision", "value": "0"}}, "guides": []any{}, "guide_sections": []any{}, "updates": []any{}, "guide_revisions": []any{}}})
	if err := os.WriteFile(filepath.Join(root, "wiki.db"), []byte("synthetic non-executable SQLite fixture placeholder"), 0600); err != nil {
		t.Fatal(err)
	}
	writeRealSafetyManifest(t, root)
	return root
}
func writeRealSafetyManifest(t *testing.T, root string) {
	t.Helper()
	files := []realFile{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Name() == "snapshot-manifest.json" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, realFile{filepath.ToSlash(rel), int64(len(raw)), hex.EncodeToString(sum[:])})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	rwFixtureFile(t, root, "snapshot-manifest.json", files)
}
func realSafetyOptions(root string) RealOptions {
	return RealOptions{Root: root, SourceVersion: "v0.21.4-synthetic", MFAKey: []byte(strings.Repeat("s", 32))}
}

func TestIntegrationRealImportRollbackAndIdempotence(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	root := completeRealSafetyFixture(t, false, false)
	for _, step := range []string{"accounts", "wiki"} {
		opt := realSafetyOptions(root)
		opt.FailAfter = step
		if _, err := ImportReal(ctx, db.Admin, opt); err == nil {
			t.Fatalf("failure after %s did not abort", step)
		}
		for _, table := range []string{"accounts", "wallets", "asset_operations", "migration_entities", "migration_runs", "item_definitions", "feedback_entries", "catalog_releases"} {
			var n int
			if err := db.Admin.QueryRow(ctx, "SELECT count(*) FROM fishing."+table).Scan(&n); err != nil || n != 0 {
				t.Fatalf("partial %s survived rollback: %d %v", table, n, err)
			}
		}
	}
	first, err := ImportReal(ctx, db.Admin, realSafetyOptions(root))
	if err != nil {
		t.Fatal(err)
	}
	var before string
	if err = db.Admin.QueryRow(ctx, `SELECT jsonb_build_object('accounts',(SELECT count(*) FROM fishing.accounts),'ops',(SELECT count(*) FROM fishing.asset_operations),'coins',(SELECT sum(coins) FROM fishing.wallets),'entities',(SELECT count(*) FROM fishing.migration_entities))::text`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	second, err := ImportReal(ctx, db.Admin, realSafetyOptions(root))
	if err != nil || !second.AlreadyDone || first.RunID != second.RunID {
		t.Fatal("idempotent retry failed", err)
	}
	var after string
	if err = db.Admin.QueryRow(ctx, `SELECT jsonb_build_object('accounts',(SELECT count(*) FROM fishing.accounts),'ops',(SELECT count(*) FROM fishing.asset_operations),'coins',(SELECT sum(coins) FROM fishing.wallets),'entities',(SELECT count(*) FROM fishing.migration_entities))::text`).Scan(&after); err != nil || before != after {
		t.Fatal("retry changed imported balances or entities", err)
	}
	var secrets int
	if err = db.App.QueryRow(ctx, `SELECT count(*) FROM fishing.migration_entities`).Scan(&secrets); err == nil {
		t.Fatal("runtime role can read source credentials/tokens")
	}
	var sessions int
	if err = db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.auth_sessions`).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatal("legacy sessions were activated", err)
	}
}

func TestIntegrationRealImportRetryRestoresSourceAliases(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	opt := realSafetyOptions(completeRealSafetyFixture(t, true, false))
	if _, err := ImportReal(ctx, db.Admin, opt); err != nil {
		t.Fatal("initial alias import failed", err)
	}
	opt.ReconcileOnly = true
	if _, err := ImportReal(ctx, db.Admin, opt); err != nil {
		t.Fatal("retry lost username or public ID alias", err)
	}
}

func TestIntegrationRealImportRejectsChangedStagingLedger(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	opt := realSafetyOptions(completeRealSafetyFixture(t, false, false))
	result, err := ImportReal(ctx, db.Admin, opt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, `UPDATE fishing.migration_entities SET payload='{"changed":true}' WHERE run_id=$1 AND entity_key='sessions.json'`, result.RunID); err != nil {
		t.Fatal(err)
	}
	opt.ReconcileOnly = true
	if _, err = ImportReal(ctx, db.Admin, opt); err == nil {
		t.Fatal("tampered retained source payload accepted as reconciled")
	}
}

func TestIntegrationRealImportRejectsUnmappedGlobalFields(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	opt := realSafetyOptions(completeRealSafetyFixture(t, false, true))
	if _, err := ImportReal(ctx, db.Admin, opt); err == nil {
		t.Fatal("unknown global field silently archived and marked reconciled")
	}
}

func TestIntegrationRealImportRejectsNonemptyCandidateMetadata(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	opt := realSafetyOptions(completeRealSafetyFixture(t, false, false))
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('existing-unrelated','{"keep":true}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportReal(ctx, db.Admin, opt); err == nil {
		t.Fatal("nonempty candidate metadata was mixed into imported authority")
	}
}
