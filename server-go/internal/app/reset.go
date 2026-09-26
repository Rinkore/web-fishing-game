package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/wiki"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// FreshSaveSummary is the operator-visible table split of a fresh save. The
// JSON field names stay stable because the reset command prints them.
type FreshSaveSummary struct {
	Preserved []string         `json:"preserved"`
	Retained  map[string]int64 `json:"retained"`
	Cleared   []string         `json:"cleared"`
	Rows      map[string]int64 `json:"rows"`
}

// freshSavePreserved names the tables a fresh save keeps. They hold operator
// configuration or migration-created serializer state, never player saves.
// Every other fishing table, including tables added by later migrations, is
// cleared; add a table here only when its rows must survive a reset.
var freshSavePreserved = []string{
	"banner_state",
	"catch_record_moderation_guard",
	"item_definitions",
	"mail_tracking",
	"operator_settings",
	"party_guard",
	"wiki_state",
}

// freshSavePublishedTables carry the published operator configuration. They are
// kept only while a release exists: an install that never published anything
// keeps the original behaviour, where the empty heads are rebuilt and every
// identity restarts at 1.
var freshSavePublishedTables = []string{"catalog_head", "catalog_releases", "feature_head", "feature_releases"}

// freshSaveRebuiltRows restores the migration-seeded release heads, mirroring
// 0013_feature_releases.sql and 0020_catalog_releases.sql. They rebuild the
// blank heads of an install that never published, and repair a seeded row that
// somehow went missing; with a published configuration the heads are preserved
// with the releases they point at and both statements are no-ops.
var freshSaveRebuiltRows = []string{
	`INSERT INTO fishing.catalog_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
	`INSERT INTO fishing.feature_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
}

// freshSaveRetainedTables hold player data, but a published configuration pins
// a few of their rows: a release is signed by the account that published it and
// carries the audited operation that committed it, and that operation requires
// its command result. When releases exist these tables are pruned instead of
// truncated, so the running rules, prices, drops, mall and feature flags survive
// a fresh save while the players do not.
var freshSaveRetainedTables = []string{"accounts", "asset_operations", "command_results"}

// The predicates below are the single source of truth for "this row belongs to
// the published configuration". The dry run and the prune share them, so a plan
// always matches what --confirm removes. The aliases are the ones the prune
// statements and the count query use.
const (
	freshSaveOperationKept = `(EXISTS (SELECT 1 FROM fishing.catalog_releases cr WHERE cr.operation_id=o.id) OR EXISTS (SELECT 1 FROM fishing.feature_releases fr WHERE fr.operation_id=o.id))`
	freshSaveResultKept    = `EXISTS (SELECT 1 FROM fishing.asset_operations o WHERE o.actor_id=c.actor_id AND o.request_key=c.request_key AND ` + freshSaveOperationKept + `)`
	freshSaveAccountKept   = `(EXISTS (SELECT 1 FROM fishing.catalog_releases cr WHERE cr.actor_id=a.id) OR EXISTS (SELECT 1 FROM fishing.feature_releases fr WHERE fr.actor_id=a.id) OR EXISTS (SELECT 1 FROM fishing.asset_operations o WHERE o.actor_id=a.id AND ` + freshSaveOperationKept + `))`
)

// The statements follow the foreign keys: operations pin command results, and
// both pin accounts.
var freshSaveRetainedPrune = []string{
	`DELETE FROM fishing.asset_operations o WHERE NOT ` + freshSaveOperationKept,
	`DELETE FROM fishing.command_results c WHERE NOT ` + freshSaveResultKept,
	`DELETE FROM fishing.accounts a WHERE NOT ` + freshSaveAccountKept,
}

// PlanFreshSave reports which tables a reset preserves and clears, with
// best-effort row counts, without writing anything.
func PlanFreshSave(ctx context.Context, pool *pgxpool.Pool) (FreshSaveSummary, error) {
	tables, err := fishingTables(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	retain, err := freshSaveKeepsPublishedConfig(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	summary, err := splitFreshSave(tables, retain)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	if retain {
		if summary.Retained, err = freshSaveRetainedRows(ctx, pool); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	summary.Rows = freshSaveRowCounts(ctx, pool, summary.Cleared)
	return summary, nil
}

func splitFreshSave(tables []string, retain bool) (FreshSaveSummary, error) {
	known := make(map[string]bool, len(tables))
	for _, name := range tables {
		known[name] = true
	}
	preserved := make([]string, 0, len(freshSavePreserved)+len(freshSavePublishedTables))
	keep := make(map[string]bool, len(freshSavePreserved)+len(freshSavePublishedTables)+len(freshSaveRetainedTables))
	for _, name := range freshSavePreserved {
		if !known[name] {
			return FreshSaveSummary{}, fmt.Errorf("preserved table %s is missing from the schema", name)
		}
		preserved = append(preserved, name)
		keep[name] = true
	}
	if retain {
		for _, name := range freshSavePublishedTables {
			if !known[name] {
				return FreshSaveSummary{}, fmt.Errorf("published table %s is missing from the schema", name)
			}
			preserved = append(preserved, name)
			keep[name] = true
		}
		for _, name := range freshSaveRetainedTables {
			if !known[name] {
				return FreshSaveSummary{}, fmt.Errorf("retained table %s is missing from the schema", name)
			}
			keep[name] = true
		}
	}
	sort.Strings(preserved)
	summary := FreshSaveSummary{Preserved: preserved, Retained: map[string]int64{}, Rows: map[string]int64{}}
	for _, name := range tables {
		if !keep[name] {
			summary.Cleared = append(summary.Cleared, name)
		}
	}
	return summary, nil
}

// FreshSave clears all player data while keeping the schema: every fishing
// table is truncated except the preserved configuration tables, then the
// published releases are pruned back to the rows the operator configuration
// pins, and the built-in item definitions and official wiki content are
// restored. The schema, its privileges, and the migration ledger stay
// untouched, so the running release keeps matching the database. Stop the game
// first; the reset refuses to run while another fishing-go process is
// connected.
func FreshSave(ctx context.Context, pool *pgxpool.Pool) (FreshSaveSummary, error) {
	if err := ensureGameStopped(ctx, pool); err != nil {
		return FreshSaveSummary{}, err
	}
	summary, err := PlanFreshSave(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	if len(summary.Cleared) == 0 {
		return FreshSaveSummary{}, errors.New("no fishing table to clear")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return FreshSaveSummary{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	statement := "TRUNCATE TABLE " + strings.Join(qualifiedTables(summary.Cleared), ", ") + " RESTART IDENTITY"
	if _, err := tx.Exec(ctx, statement); err != nil {
		return FreshSaveSummary{}, err
	}
	// Accounts, operations and command results are player data too: keep only
	// the rows the preserved releases pin and drop the rest.
	for _, prune := range freshSaveRetainedPrune {
		if _, err := tx.Exec(ctx, prune); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	for _, rebuild := range freshSaveRebuiltRows {
		if _, err := tx.Exec(ctx, rebuild); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	if len(summary.Retained) > 0 {
		retained, err := freshSaveRetainedRows(ctx, tx)
		if err != nil {
			return FreshSaveSummary{}, err
		}
		summary.Retained = retained
	}
	if err := tx.Commit(ctx); err != nil {
		return FreshSaveSummary{}, err
	}
	if err := seedFreshSaveDefaults(ctx, pool); err != nil {
		return FreshSaveSummary{}, err
	}
	return summary, nil
}

// ensureGameStopped relies on the shared application_name that every postgres
// pool of this server sets. An idle game process still holds no table lock, so
// the lock timeout alone cannot protect the reset from a running service.
func ensureGameStopped(ctx context.Context, pool *pgxpool.Pool) error {
	var others int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_catalog.pg_stat_activity
WHERE datname=current_database() AND application_name='fishing-go' AND pid<>pg_backend_pid()`).Scan(&others)
	if err != nil {
		return err
	}
	if others > 0 {
		return errors.New("another fishing-go process is connected; stop the game service before resetting")
	}
	return nil
}

func seedFreshSaveDefaults(ctx context.Context, pool *pgxpool.Pool) error {
	catalog, err := rules.Default()
	if err != nil {
		return err
	}
	if err := workshop.SeedDefinitions(ctx, pool, catalog); err != nil {
		return err
	}
	// The store seeds the built-in guides only while none exist, so this is a
	// no-op once a reset has been applied.
	return wiki.NewStore(pool).Ensure(ctx)
}

// freshSaveSQL is the read surface the plan shares with the prune statements.
type freshSaveSQL interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// freshSaveKeepsPublishedConfig reports whether the database holds published
// operator releases. Without one a fresh save stays a plain truncation that
// restarts every identity, because no row has to survive for a configuration.
func freshSaveKeepsPublishedConfig(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var keeps bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM fishing.catalog_releases) OR EXISTS (SELECT 1 FROM fishing.feature_releases)`).Scan(&keeps)
	return keeps, err
}

// freshSaveRetainedRows counts what the prune keeps, so a dry run shows the
// rows that will still be there after --confirm.
func freshSaveRetainedRows(ctx context.Context, q freshSaveSQL) (map[string]int64, error) {
	rows, err := q.Query(ctx, `SELECT 'asset_operations'::text, count(*) FROM fishing.asset_operations o WHERE `+freshSaveOperationKept+
		` UNION ALL SELECT 'command_results', count(*) FROM fishing.command_results c WHERE `+freshSaveResultKept+
		` UNION ALL SELECT 'accounts', count(*) FROM fishing.accounts a WHERE `+freshSaveAccountKept)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	retained := map[string]int64{}
	for rows.Next() {
		var name string
		var count int64
		if err := rows.Scan(&name, &count); err != nil {
			return nil, err
		}
		retained[name] = count
	}
	return retained, rows.Err()
}

func fishingTables(ctx context.Context, q freshSaveSQL) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT c.relname FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='fishing' AND c.relkind='r' ORDER BY c.relname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

func qualifiedTables(tables []string) []string {
	out := make([]string, 0, len(tables))
	for _, name := range tables {
		out = append(out, pgx.Identifier{"fishing", name}.Sanitize())
	}
	return out
}

// freshSaveRowCounts is advisory only: a large database may need more time than
// the shared statement timeout allows, and a missing count must not block or
// half-apply a reset.
func freshSaveRowCounts(ctx context.Context, pool *pgxpool.Pool, tables []string) map[string]int64 {
	counts := map[string]int64{}
	if len(tables) == 0 {
		return counts
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return counts
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '60s'"); err != nil {
		return counts
	}
	parts := make([]string, 0, len(tables))
	for _, name := range tables {
		parts = append(parts, fmt.Sprintf("SELECT %s::text, count(*) FROM %s",
			quoteLiteral(name), pgx.Identifier{"fishing", name}.Sanitize()))
	}
	rows, err := tx.Query(ctx, strings.Join(parts, " UNION ALL "))
	if err != nil {
		return map[string]int64{}
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var count int64
		if err := rows.Scan(&name, &count); err != nil {
			return map[string]int64{}
		}
		counts[name] = count
	}
	if rows.Err() != nil {
		return map[string]int64{}
	}
	return counts
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
