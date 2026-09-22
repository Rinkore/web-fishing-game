// import-legacy keeps the read-only scanner separate from the PostgreSQL
// staging importer. Database modes require an already migrated isolated DB.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fishing.local/server/internal/legacy"
	"fishing.local/server/internal/migration"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("import-legacy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	mode := flags.String("mode", "scan", "scan (read-only), import, or reconcile")
	snapshot := flags.String("snapshot", "", "immutable offline snapshot directory (required)")
	version := flags.String("source-version", "", "operator-verified legacy version (required)")
	output := flags.String("output", "", "new report file outside snapshot (required)")
	dsn := flags.String("database-url", "", "isolated PostgreSQL DSN for import/reconcile")
	runID := flags.String("run-id", "", "stable migration run UUID (optional; defaults to source identity)")
	failAfter := flags.Int("fail-after", 0, "test-only transaction fault injection after N staged entities")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *snapshot == "" || *output == "" || strings.TrimSpace(*version) == "" || !map[string]bool{"scan": true, "import": true, "reconcile": true}[*mode] {
		fmt.Fprintln(stderr, "Required: --mode scan|import|reconcile --snapshot DIR --source-version VERSION --output NEW_FILE")
		return 2
	}
	if (*mode == "import" || *mode == "reconcile") && strings.TrimSpace(*dsn) == "" {
		fmt.Fprintln(stderr, "--database-url is required for import/reconcile")
		return 2
	}
	root, err := filepath.EvalSymlinks(*snapshot)
	if err != nil {
		fmt.Fprintln(stderr, "Snapshot is unavailable")
		return 2
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return 2
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(*output))
	if err != nil {
		fmt.Fprintln(stderr, "Report parent directory must exist")
		return 2
	}
	parent, err = filepath.Abs(parent)
	if err != nil {
		return 2
	}
	dest := filepath.Join(parent, filepath.Base(*output))
	rel, err := filepath.Rel(root, dest)
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
		fmt.Fprintln(stderr, "Report must be outside snapshot")
		return 2
	}
	report, err := legacy.Scan(root, *version)
	if err != nil {
		fmt.Fprintln(stderr, "Snapshot scan failed; no report written")
		return 2
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return 2
	}
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		fmt.Fprintln(stderr, "Cannot create report; existing files are never overwritten")
		return 2
	}
	_, writeErr := f.Write(append(data, '\n'))
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		fmt.Fprintln(stderr, "Report write failed; discard partial report")
		return 2
	}
	if *mode != "scan" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		cfg, err := pgxpool.ParseConfig(*dsn)
		if err != nil {
			fmt.Fprintln(stderr, "Invalid database URL")
			return 2
		}
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			fmt.Fprintln(stderr, "Cannot connect to isolated database")
			return 2
		}
		defer pool.Close()
		if err := migrations.Check(ctx, pool); err != nil {
			fmt.Fprintln(stderr, "Database schema is not at migration head")
			return 2
		}
		var result migration.Result
		if *mode == "import" {
			result, err = migration.Import(ctx, pool, migration.Options{Root: root, SourceVersion: *version, RunID: *runID, FailAfter: *failAfter})
		} else {
			if strings.TrimSpace(*runID) == "" {
				fmt.Fprintln(stderr, "--run-id is required for reconcile")
				return 2
			}
			result, err = migration.Reconcile(ctx, pool, *runID)
		}
		if err != nil {
			if result.RunID != "" {
				if failedData, marshalErr := json.MarshalIndent(result, "", "  "); marshalErr == nil {
					_ = os.WriteFile(dest, append(failedData, '\n'), 0600)
				}
			}
			fmt.Fprintf(stderr, "%s failed: %v\n", *mode, err)
			return 1
		}
		data, _ = json.MarshalIndent(result, "", "  ")
		if err := os.WriteFile(dest, append(data, '\n'), 0600); err != nil {
			fmt.Fprintln(stderr, "Cannot write database result")
			return 2
		}
		fmt.Fprintf(stderr, "%s completed: run %s state=%s\n", *mode, result.RunID, result.State)
		return 0
	}
	fmt.Fprintf(stderr, "Scanned %d files; %d findings. Import readiness remains unverified.\n", len(report.Files), len(report.Issues))
	if len(report.Issues) > 0 {
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stderr)) }
