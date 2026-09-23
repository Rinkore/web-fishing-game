package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const RealToolVersion = "go-offline-import/1"

type RealOptions struct {
	Root, SourceVersion string
	MFAKey              []byte
	ReconcileOnly       bool
	FailAfter           string // synthetic failure injection, never a skipped step
	Progress            func(string)
}

type RealResult struct {
	RunID       string `json:"runId"`
	Manifest    string `json:"manifestSha256"`
	Files       int    `json:"files"`
	Accounts    int    `json:"accounts"`
	State       string `json:"state"`
	AlreadyDone bool   `json:"alreadyDone"`
}

type realFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// InspectReal verifies every byte against the preparation manifest and rejects
// unlisted files, symlinks, duplicate paths, and unknown persistence domains.
func InspectReal(root string) ([]realFile, []RealAccount, string, error) {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, "", errors.New("invalid_snapshot_root")
	}
	manifest, err := os.ReadFile(filepath.Join(root, "snapshot-manifest.json"))
	if err != nil {
		return nil, nil, "", errors.New("manifest_unavailable")
	}
	var files []realFile
	if json.Unmarshal(manifest, &files) != nil || len(files) == 0 {
		return nil, nil, "", errors.New("invalid_manifest")
	}
	seen := map[string]bool{}
	var accounts []RealAccount
	for i, file := range files {
		clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(file.Path)))
		if file.Path == "" || clean != file.Path || strings.Contains(file.Path, "\\") || filepath.IsAbs(file.Path) || strings.Contains(file.Path, ":") || strings.HasPrefix(clean, "../") || seen[clean] || file.Bytes < 0 || len(file.SHA256) != 64 {
			return nil, nil, "", fmt.Errorf("invalid_manifest_entry_%d", i)
		}
		seen[clean] = true
		if realDomain(clean) == "" {
			return nil, nil, "", fmt.Errorf("unknown_snapshot_domain_%d", i)
		}
		path := filepath.Join(root, filepath.FromSlash(clean))
		stat, e := os.Lstat(path)
		if e != nil || !stat.Mode().IsRegular() || stat.Size() != file.Bytes {
			return nil, nil, "", fmt.Errorf("snapshot_file_invalid_%d", i)
		}
		hash, e := fileHash(path)
		if e != nil || hash != file.SHA256 {
			return nil, nil, "", fmt.Errorf("snapshot_hash_mismatch_%d", i)
		}
		if realDomain(clean) == "account" {
			payload, e := readObject(path)
			if e != nil {
				return nil, nil, "", fmt.Errorf("invalid_account_json_%d", i)
			}
			accounts = append(accounts, RealAccount{strings.TrimSuffix(filepath.Base(path), ".json"), payload})
		}
	}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.Type()&os.ModeSymlink != 0 {
			return errors.New("invalid_snapshot_entry")
		}
		if entry.IsDir() {
			return nil
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return errors.New("invalid_snapshot_entry")
		}
		rel = filepath.ToSlash(rel)
		if rel != "snapshot-manifest.json" && !seen[rel] {
			return errors.New("unlisted_snapshot_file")
		}
		return nil
	})
	if err != nil {
		return nil, nil, "", err
	}
	for _, required := range []string{"config.json", "market.json", "economy.json", "records.json", "admin.json", "feedback.json", "stats.json", "sessions.json", "wiki.db", "wiki-export.json"} {
		if !seen[required] {
			return nil, nil, "", errors.New("required_snapshot_domain_missing")
		}
	}
	if len(accounts) == 0 {
		return nil, nil, "", errors.New("snapshot_has_no_accounts")
	}
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Key < accounts[j].Key })
	h := sha256.Sum256(manifest)
	return files, accounts, hex.EncodeToString(h[:]), nil
}

func realDomain(path string) string {
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[0] == "accounts" && strings.HasSuffix(path, ".json") {
		return "account"
	}
	if len(parts) > 1 && parts[0] == "snapshots" && strings.HasSuffix(path, ".json") {
		return "historical-snapshot"
	}
	if len(parts) == 2 && strings.HasPrefix(parts[0], "price-backup-") && strings.HasSuffix(path, ".json") {
		return "historical-price-backup"
	}
	if len(parts) != 1 {
		return ""
	}
	switch path {
	case "config.json", "market.json", "economy.json", "records.json", "admin.json", "feedback.json", "stats.json", "sessions.json":
		return strings.TrimSuffix(path, ".json")
	case "wiki-export.json", "wiki.db", "wiki.db-wal", "wiki.db-shm":
		return "wiki-source"
	}
	return ""
}

// ImportReal only imports into a new, fully migrated candidate database. A
// complete second reconciliation is performed on idempotent retries. The live
// application must remain disconnected until the caller accepts this result.
func ImportReal(ctx context.Context, pool *pgxpool.Pool, opt RealOptions) (RealResult, error) {
	progress := func(stage string) {
		if opt.Progress != nil {
			opt.Progress(stage)
		}
	}
	progress("inspect")
	files, accounts, manifest, err := InspectReal(opt.Root)
	if err != nil {
		return RealResult{}, err
	}
	if err := ValidateRealDomains(opt.Root); err != nil {
		return RealResult{}, err
	}
	if strings.TrimSpace(opt.SourceVersion) == "" || len(opt.MFAKey) != 32 {
		return RealResult{}, errors.New("source_version_and_mfa_key_required")
	}
	if err := migrations.Check(ctx, pool); err != nil {
		return RealResult{}, errors.New("candidate_schema_mismatch")
	}
	result := RealResult{RunID: deterministicRunID(manifest, opt.SourceVersion), Manifest: manifest, Files: len(files), Accounts: len(accounts)}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return result, errors.New("candidate_transaction_failed")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734913209)`); err != nil {
		return result, err
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT state FROM fishing.migration_runs WHERE id=$1`, result.RunID).Scan(&existing)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, fmt.Errorf("candidate_state_read_failed: %w", err)
	}
	rc := &RealContext{Tx: tx, Root: opt.Root, IDs: map[string]int64{}, RunID: result.RunID, Now: time.Now().UTC(), MFAKey: opt.MFAKey}
	if existing != "" {
		if existing != "reconciled" {
			return result, errors.New("candidate_has_incomplete_import")
		}
		rows, e := tx.Query(ctx, `SELECT legacy_id,new_id::bigint FROM fishing.legacy_id_map WHERE run_id=$1 AND domain='account'`, result.RunID)
		if e != nil {
			return result, e
		}
		for rows.Next() {
			var key string
			var id int64
			if rows.Scan(&key, &id) != nil {
				rows.Close()
				return result, errors.New("candidate_id_map_invalid")
			}
			rc.IDs[key] = id
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return result, err
		}
		for _, account := range accounts {
			id := rc.IDs[account.Key]
			if id == 0 {
				return result, errors.New("candidate_account_mapping_missing")
			}
			for _, alias := range []string{strings.ToLower(account.Key), strings.ToLower(stringValue(account.Payload, "username")), strings.ToLower(stringValue(account.Payload, "id"))} {
				if alias == "" {
					continue
				}
				if previous := rc.IDs[alias]; previous != 0 && previous != id {
					return result, errors.New("candidate_account_alias_conflict")
				}
				rc.IDs[alias] = id
			}
		}
		result.AlreadyDone = true
		cfg, configErr := readObject(filepath.Join(opt.Root, "config.json"))
		econ, economyErr := readObject(filepath.Join(opt.Root, "economy.json"))
		if configErr != nil || economyErr != nil {
			return result, errors.New("candidate_source_config_invalid")
		}
		rc.Catalog, err = buildRealCatalog(cfg, econ)
		if err != nil {
			return result, errors.New("candidate_source_catalog_invalid")
		}
	} else {
		if opt.ReconcileOnly {
			return result, errors.New("no_import_to_reconcile")
		}
		var populated bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.accounts) OR EXISTS(SELECT 1 FROM fishing.migration_runs) OR EXISTS(SELECT 1 FROM fishing.operator_settings) OR EXISTS(SELECT 1 FROM fishing.wiki_guides) OR EXISTS(SELECT 1 FROM fishing.wiki_updates) OR EXISTS(SELECT 1 FROM fishing.wiki_revisions) OR EXISTS(SELECT 1 FROM fishing.economy_prices) OR EXISTS(SELECT 1 FROM fishing.legacy_economy_history) OR EXISTS(SELECT 1 FROM fishing.activity_samples)`).Scan(&populated); err != nil || populated {
			return result, errors.New("candidate_database_not_empty")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.migration_runs(id,source_version,snapshot_sha256,tool_version,state) VALUES($1,$2,$3,$4,'running')`, result.RunID, opt.SourceVersion, manifest, RealToolVersion); err != nil {
			return result, err
		}
		if err := stageRealFiles(ctx, rc, files); err != nil {
			return result, err
		}
		progress("source_archived")
		steps := []struct {
			name string
			fn   func() error
		}{
			{"catalog", func() error { return PrepareRealCatalog(ctx, rc) }},
			{"accounts", func() error { _, e := ImportRealAccounts(ctx, rc, accounts); return e }},
			{"resume", func() error { return ImportRealResume(ctx, rc, accounts) }},
			{"config", func() error { return ImportRealConfig(ctx, rc) }},
			{"market_economy", func() error { return ImportRealMarketEconomy(ctx, rc) }},
			{"world", func() error { return ImportRealWorld(ctx, rc) }},
			{"wiki", func() error { return ImportRealWiki(ctx, rc) }},
		}
		for _, step := range steps {
			progress("import_" + step.name)
			if err := step.fn(); err != nil {
				return result, fmt.Errorf("import_%s: %w", step.name, err)
			}
			if opt.FailAfter == step.name {
				return result, errors.New("injected_import_failure")
			}
		}
	}
	checks := []struct {
		name string
		fn   func() error
	}{
		{"accounts", func() error { return ReconcileRealAccounts(ctx, rc, accounts) }},
		{"resume", func() error { return ReconcileRealResume(ctx, rc, accounts) }},
		{"config", func() error { return ReconcileRealConfig(ctx, rc) }},
		{"market_economy", func() error { return ReconcileRealMarketEconomy(ctx, rc) }},
		{"world", func() error { return ReconcileRealWorld(ctx, rc) }},
		{"wiki", func() error { return ReconcileRealWiki(ctx, rc) }},
	}
	for _, check := range checks {
		progress("reconcile_" + check.name)
		if err := check.fn(); err != nil {
			return result, fmt.Errorf("reconcile_%s: %w", check.name, err)
		}
	}
	progress("reconcile_archive")
	if err := verifyRealArchive(ctx, rc, files); err != nil {
		return result, err
	}
	// Detect changes made after the initial inspection, before accepting data.
	_, _, finalManifest, err := InspectReal(opt.Root)
	if err != nil || finalManifest != manifest {
		return result, errors.New("source_changed_during_import")
	}
	if !result.AlreadyDone {
		if _, err := tx.Exec(ctx, `UPDATE fishing.migration_entities SET status='reconciled',issue=CASE WHEN domain='sessions' THEN 'legacy_sessions_invalidated' WHEN domain='historical-price-backup' THEN 'historical_backup_retained_without_reapplying' ELSE '' END WHERE run_id=$1`, result.RunID); err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx, `UPDATE fishing.migration_runs SET state='reconciled',finished_at=clock_timestamp() WHERE id=$1`, result.RunID); err != nil {
			return result, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return result, errors.New("candidate_commit_failed")
	}
	result.State = "reconciled"
	return result, nil
}

func stageRealFiles(ctx context.Context, rc *RealContext, files []realFile) error {
	for index, file := range files {
		domain := realDomain(file.Path)
		var payload []byte
		if strings.HasSuffix(file.Path, ".json") {
			var err error
			payload, err = os.ReadFile(filepath.Join(rc.Root, filepath.FromSlash(file.Path)))
			if err != nil || !json.Valid(payload) {
				return fmt.Errorf("stage_json_invalid_%d", index)
			}
			var object map[string]json.RawMessage
			if json.Unmarshal(payload, &object) != nil || object == nil {
				payload = append(append([]byte(`{"value":`), payload...), '}')
			}
		} else {
			payload, _ = json.Marshal(map[string]any{"bytes": file.Bytes, "sha256": file.SHA256})
		}
		if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.migration_entities(run_id,domain,entity_key,source_sha256,payload,status) VALUES($1,$2,$3,$4,$5,'staged')`, rc.RunID, domain, file.Path, file.SHA256, payload); err != nil {
			return fmt.Errorf("stage_storage_failed_%d", index)
		}
	}
	return nil
}

func verifyRealArchive(ctx context.Context, rc *RealContext, files []realFile) error {
	var count int
	if err := rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.migration_entities WHERE run_id=$1`, rc.RunID).Scan(&count); err != nil || count != len(files) {
		return errors.New("archived_source_count_mismatch")
	}
	for index, file := range files {
		var payload []byte
		if strings.HasSuffix(file.Path, ".json") {
			var err error
			payload, err = os.ReadFile(filepath.Join(rc.Root, filepath.FromSlash(file.Path)))
			if err != nil || !json.Valid(payload) {
				return fmt.Errorf("archive_source_invalid_%d", index)
			}
			var object map[string]json.RawMessage
			if json.Unmarshal(payload, &object) != nil || object == nil {
				payload = append(append([]byte(`{"value":`), payload...), '}')
			}
		} else {
			payload, _ = json.Marshal(map[string]any{"bytes": file.Bytes, "sha256": file.SHA256})
		}
		var match bool
		if err := rc.Tx.QueryRow(ctx, `SELECT source_sha256=$4 AND payload=$5::jsonb FROM fishing.migration_entities WHERE run_id=$1 AND domain=$2 AND entity_key=$3`, rc.RunID, realDomain(file.Path), file.Path, file.SHA256, payload).Scan(&match); err != nil || !match {
			return fmt.Errorf("archived_source_mismatch_%d", index)
		}
	}
	return nil
}
