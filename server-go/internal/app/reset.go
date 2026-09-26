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

// freshSaveKeep names the operator-owned state a database still holds. A fresh
// save carries it over instead of clearing it.
type freshSaveKeep struct {
	// published is set while the database holds a catalog or feature release.
	published bool
	// wiki is set while the database holds official wiki guides.
	wiki bool
}

// keepsAnything reports whether the reset has to carry operator state over, so
// player tables that state references are pruned instead of truncated.
func (k freshSaveKeep) keepsAnything() bool { return k.published || k.wiki }

// wholeTables are the tables a keep preserves row for row.
func (k freshSaveKeep) wholeTables() []string {
	tables := make([]string, 0, len(freshSavePublishedTables)+len(freshSaveWikiTables))
	if k.published {
		tables = append(tables, freshSavePublishedTables...)
	}
	if k.wiki {
		tables = append(tables, freshSaveWikiTables...)
	}
	return tables
}

// retainedRows are the tables a keep prunes back to the rows it pins, in the
// foreign-key order the deletes must follow.
func (k freshSaveKeep) retainedRows() []freshSaveRetainedRow {
	rows := make([]freshSaveRetainedRow, 0, len(freshSaveRetainedRows))
	for _, row := range freshSaveRetainedRows {
		if (row.forPublished && k.published) || (row.forWiki && k.wiki) {
			rows = append(rows, row)
		}
	}
	return rows
}

// freshSavePublishedTables carry the published operator configuration. They are
// kept only while a release exists: an install that never published anything
// keeps the original behaviour, where the empty heads are rebuilt and every
// identity restarts at 1.
var freshSavePublishedTables = []string{"catalog_head", "catalog_releases", "feature_head", "feature_releases"}

// freshSaveWikiTables carry the official wiki content that the store replaces
// as one bundle: the guides and their update log always change together.
var freshSaveWikiTables = []string{"wiki_updates"}

// freshSaveRebuiltRows restores the migration-seeded release heads, mirroring
// 0013_feature_releases.sql and 0020_catalog_releases.sql. They rebuild the
// blank heads of an install that never published, and repair a seeded row that
// somehow went missing; with a published configuration the heads are preserved
// with the releases they point at and both statements are no-ops.
var freshSaveRebuiltRows = []string{
	`INSERT INTO fishing.catalog_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
	`INSERT INTO fishing.feature_head(singleton,release_id) VALUES(true,NULL) ON CONFLICT(singleton) DO NOTHING`,
}

// freshSaveRetainedRow is a table that holds player data plus the rows the kept
// operator state pins. keep is a predicate over the table alias that identifies
// the rows that survive; forPublished and forWiki name the kept state that needs
// them.
type freshSaveRetainedRow struct {
	table, alias, keep string
	forPublished       bool
	forWiki            bool
}

// The predicates below are the single source of truth for "this row belongs to
// the kept operator state". The dry run and the prune share them, so a plan
// always matches what --confirm removes. The aliases are the ones the prune
// statements and the count query use.
const (
	freshSaveOperationKept = `(EXISTS (SELECT 1 FROM fishing.catalog_releases cr WHERE cr.operation_id=o.id) OR EXISTS (SELECT 1 FROM fishing.feature_releases fr WHERE fr.operation_id=o.id))`
	freshSaveResultKept    = `EXISTS (SELECT 1 FROM fishing.asset_operations o WHERE o.actor_id=c.actor_id AND o.request_key=c.request_key AND ` + freshSaveOperationKept + `)`
	freshSaveAccountKept   = `(EXISTS (SELECT 1 FROM fishing.catalog_releases cr WHERE cr.actor_id=a.id) OR EXISTS (SELECT 1 FROM fishing.feature_releases fr WHERE fr.actor_id=a.id) OR EXISTS (SELECT 1 FROM fishing.asset_operations o WHERE o.actor_id=a.id AND ` + freshSaveOperationKept + `))`
	freshSaveGuideKept     = `(wg.kind='official' AND wg.deleted_at IS NULL)`
	freshSaveSectionKept   = `EXISTS (SELECT 1 FROM fishing.wiki_guides wg WHERE wg.id=ws.guide_id AND ` + freshSaveGuideKept + `)`
)

// The order is the foreign-key order the deletes must follow.
var freshSaveRetainedRows = []freshSaveRetainedRow{
	// A release is signed by the account that published it, carries the audited
	// operation that committed it, and that operation requires its command
	// result, so the running rules, prices, drops, mall and feature flags survive
	// a fresh save while their publishers' other rows do not.
	{table: "asset_operations", alias: "o", keep: freshSaveOperationKept, forPublished: true},
	{table: "command_results", alias: "c", keep: freshSaveResultKept, forPublished: true},
	// Official guides are operator content; the submissions next to them belong
	// to players. Their sections cascade from the guide, and both must go before
	// the accounts the submissions point at.
	{table: "wiki_sections", alias: "ws", keep: freshSaveSectionKept, forWiki: true},
	{table: "wiki_guides", alias: "wg", keep: freshSaveGuideKept, forWiki: true},
	// Accounts stay out of the truncate list whenever a kept table references
	// them; the predicate still deletes every account that no kept row pins.
	{table: "accounts", alias: "a", keep: freshSaveAccountKept, forPublished: true, forWiki: true},
}

// PlanFreshSave reports which tables a reset preserves, prunes and clears, with
// best-effort row counts, without writing anything.
func PlanFreshSave(ctx context.Context, pool *pgxpool.Pool) (FreshSaveSummary, error) {
	keep, err := detectFreshSaveKeep(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	return planFreshSave(ctx, pool, keep)
}

func planFreshSave(ctx context.Context, pool *pgxpool.Pool, keep freshSaveKeep) (FreshSaveSummary, error) {
	tables, err := fishingTables(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	summary, err := splitFreshSave(tables, keep)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	if keep.keepsAnything() {
		if summary.Retained, err = freshSaveRetainedRowCounts(ctx, pool, keep); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	summary.Rows = freshSaveRowCounts(ctx, pool, summary.Cleared)
	return summary, nil
}

func splitFreshSave(tables []string, keep freshSaveKeep) (FreshSaveSummary, error) {
	known := make(map[string]bool, len(tables))
	for _, name := range tables {
		known[name] = true
	}
	retained := keep.retainedRows()
	preserved := make([]string, 0, len(freshSavePreserved)+len(freshSavePublishedTables)+len(freshSaveWikiTables))
	kept := make(map[string]bool, cap(preserved)+len(retained))
	for _, name := range freshSavePreserved {
		if !known[name] {
			return FreshSaveSummary{}, fmt.Errorf("preserved table %s is missing from the schema", name)
		}
		preserved = append(preserved, name)
		kept[name] = true
	}
	for _, name := range keep.wholeTables() {
		if !known[name] {
			return FreshSaveSummary{}, fmt.Errorf("preserved table %s is missing from the schema", name)
		}
		preserved = append(preserved, name)
		kept[name] = true
	}
	for _, row := range retained {
		if !known[row.table] {
			return FreshSaveSummary{}, fmt.Errorf("retained table %s is missing from the schema", row.table)
		}
		kept[row.table] = true
	}
	sort.Strings(preserved)
	summary := FreshSaveSummary{Preserved: preserved, Retained: map[string]int64{}, Rows: map[string]int64{}}
	for _, name := range tables {
		if !kept[name] {
			summary.Cleared = append(summary.Cleared, name)
		}
	}
	return summary, nil
}

// FreshSave clears all player data while keeping the schema: every fishing
// table is truncated except the tables the operator state lives in, those are
// pruned back to the rows that state pins, and the built-in item definitions and
// official wiki content are restored when they are missing. The schema, its
// privileges, and the migration ledger stay untouched, so the running release
// keeps matching the database. Stop the game first; the reset refuses to run
// while another fishing-go process is connected.
func FreshSave(ctx context.Context, pool *pgxpool.Pool) (FreshSaveSummary, error) {
	if err := ensureGameStopped(ctx, pool); err != nil {
		return FreshSaveSummary{}, err
	}
	keep, err := detectFreshSaveKeep(ctx, pool)
	if err != nil {
		return FreshSaveSummary{}, err
	}
	summary, err := planFreshSave(ctx, pool, keep)
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
	// The tables the kept operator state lives in also hold player data: drop
	// every row that state does not pin, in foreign-key order.
	for _, row := range keep.retainedRows() {
		prune := "DELETE FROM " + pgx.Identifier{"fishing", row.table}.Sanitize() +
			" " + row.alias + " WHERE NOT " + row.keep
		if _, err := tx.Exec(ctx, prune); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	for _, rebuild := range freshSaveRebuiltRows {
		if _, err := tx.Exec(ctx, rebuild); err != nil {
			return FreshSaveSummary{}, err
		}
	}
	if keep.keepsAnything() {
		retained, err := freshSaveRetainedRowCounts(ctx, tx, keep)
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

// detectFreshSaveKeep reports which operator state the database still holds.
// Without any, a fresh save stays a plain truncation that restarts every
// identity, because no row has to survive for the configuration.
func detectFreshSaveKeep(ctx context.Context, pool *pgxpool.Pool) (freshSaveKeep, error) {
	var keep freshSaveKeep
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM fishing.catalog_releases) OR EXISTS (SELECT 1 FROM fishing.feature_releases),
EXISTS (SELECT 1 FROM fishing.wiki_guides WHERE kind='official' AND deleted_at IS NULL)`).Scan(&keep.published, &keep.wiki)
	return keep, err
}

// freshSaveRetainedRowCounts counts what the prune keeps, so a dry run shows the
// rows that will still be there after --confirm.
func freshSaveRetainedRowCounts(ctx context.Context, q freshSaveSQL, keep freshSaveKeep) (map[string]int64, error) {
	kept := keep.retainedRows()
	parts := make([]string, 0, len(kept))
	for _, row := range kept {
		parts = append(parts, fmt.Sprintf("SELECT %s::text, count(*) FROM %s %s WHERE %s",
			quoteLiteral(row.table), pgx.Identifier{"fishing", row.table}.Sanitize(), row.alias, row.keep))
	}
	rows, err := q.Query(ctx, strings.Join(parts, " UNION ALL "))
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
