// import-offline imports the complete operator-prepared Node snapshot into a
// disconnected candidate database. Credentials are accepted only via env.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"fishing.local/server/internal/migration"
	"github.com/jackc/pgx/v5/pgxpool"
)

func run() error {
	root := flag.String("snapshot", "", "prepared private snapshot directory")
	version := flag.String("source-version", "", "source format/version declaration")
	output := flag.String("output", "", "new private report outside snapshot")
	verify := flag.Bool("reconcile", false, "verify an existing offline candidate import")
	fault := flag.String("fail-after", "", "synthetic rollback drill step")
	flag.Parse()
	if *root == "" || *version == "" || *output == "" || flag.NArg() != 0 {
		return fmt.Errorf("snapshot_source_version_output_required")
	}
	rootAbs, err := filepath.Abs(*root)
	if err != nil {
		return fmt.Errorf("invalid_snapshot_path")
	}
	rootAbs, err = filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return fmt.Errorf("invalid_snapshot_path")
	}
	outputAbs, err := filepath.Abs(*output)
	if err != nil {
		return fmt.Errorf("invalid_report_path")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(outputAbs))
	if err != nil {
		return fmt.Errorf("invalid_report_parent")
	}
	outputAbs = filepath.Join(parent, filepath.Base(outputAbs))
	rel, err := filepath.Rel(rootAbs, outputAbs)
	if err != nil || filepath.IsLocal(rel) {
		return fmt.Errorf("report_must_be_outside_snapshot")
	}
	report, err := os.OpenFile(outputAbs, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("cannot_create_new_report")
	}
	defer report.Close()
	key, err := base64.StdEncoding.DecodeString(os.Getenv("FISHING_GO_MFA_KEY"))
	if err != nil || len(key) != 32 {
		return fmt.Errorf("valid_mfa_key_required")
	}
	dsn := os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("candidate_database_env_required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("candidate_connection_failed")
	}
	defer pool.Close()
	result, importErr := migration.ImportReal(ctx, pool, migration.RealOptions{Root: rootAbs, SourceVersion: *version, MFAKey: key, ReconcileOnly: *verify, FailAfter: *fault, Progress: func(stage string) { fmt.Fprintln(os.Stderr, "offline_migration_stage="+stage) }})
	private := map[string]any{"result": result}
	if importErr != nil {
		// Detailed mapper errors are restricted to this private report. They
		// are deliberately not printed to the terminal or application logs.
		private["error"] = importErr.Error()
	}
	if err := json.NewEncoder(report).Encode(private); err != nil {
		return fmt.Errorf("private_report_write_failed")
	}
	if err := report.Sync(); err != nil {
		return fmt.Errorf("private_report_sync_failed")
	}
	if importErr != nil {
		return fmt.Errorf("offline_import_failed_see_private_report")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
