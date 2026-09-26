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

// freshSaveRebuiltRows restores the migration-created rows of tables that must
// be cleared: their published releases are player-visible operator history that
// references accounts and operations, so both the release rows and the heads
// that point at them go away together. The statements mirror
// 0013_feature_releases.sql and 0020_catalog_releases.sql.
var freshSaveRebuiltRows = []string{
	`INSERT INTO fishing.catalog_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
	`INSERT INTO fishing.feature_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
}

// PlanFreshSave reports which tables a reset preserves and clears, with
// best-effort row counts, without writing anything.
func PlanFreshSave(ctx context.Context, pool *pgxpool.Pool) (FreshSaveSummary, error) {
	tables, err := fishingTables(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	summary, err := splitFreshSave(tables)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	summary.Rows = freshSaveRowCounts(ctx, pool, summary.Cleared)
	return summary, nil
}

func splitFreshSave(tables []string) (FreshSaveSummary, error) {
	known := make(map[string]bool, len(tables))
	for _, name := range tables {
		known[name] = true
	}
	preserved := make([]string, 0, len(freshSavePreserved))
	for _, name := range freshSavePreserved {
		if !known[name] {
			return FreshSaveSummary{}, fmt.Errorf("preserved table %s is missing from the schema", name)
		}
		preserved = append(preserved, name)
	}
	sort.Strings(preserved)
	keep := make(map[string]bool, len(preserved))
	for _, name := range preserved {
		keep[name] = true
	}
	summary := FreshSaveSummary{Preserved: preserved, Rows: map[string]int64{}}
	for _, name := range tables {
		if !keep[name] {
			summary.Cleared = append(summary.Cleared, name)
		}
	}
	return summary, nil
}

// FreshSave clears all player data while keeping the schema: every fishing
// table is truncated except the preserved configuration tables, then the
// built-in item definitions and official wiki content are restored. The schema,
// its privileges, and the migration ledger stay untouched, so the running
// release keeps matching the database. Stop the game first; the reset refuses
// to run while another fishing-go process is connected.
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
	for _, rebuild := range freshSaveRebuiltRows {
		if _, err := tx.Exec(ctx, rebuild); err != nil {
			return FreshSaveSummary{}, err
		}
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

func fishingTables(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}) ([]string, error) {
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
