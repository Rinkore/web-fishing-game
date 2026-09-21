// Package migrations applies embedded, append-only SQL as a separate operator
// step. The running game checks schema compatibility but never applies DDL.
package migrations

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

var ErrIncompatible = errors.New("database schema missing or incompatible")
var ErrApply = errors.New("database schema update failed")

type step struct{ name, sql, checksum string }

// Count reports how many embedded steps this build ships, so callers can compare
// the applied history with the binary instead of hardcoding a revision number.
func Count() int { return len(steps()) }

func steps() []step {
	entries, _ := files.ReadDir(".")
	var out []step
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		data, _ := files.ReadFile(entry.Name())
		hash := sha256.Sum256(data)
		out = append(out, step{entry.Name(), string(data), hex.EncodeToString(hash[:])})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func applied(ctx context.Context, q queryer) (map[string]string, error) {
	rows, err := q.Query(ctx, "SELECT name, checksum FROM public.fishing_schema_migrations ORDER BY name")
	if err != nil {
		return nil, ErrIncompatible
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, checksum string
		if rows.Scan(&name, &checksum) != nil {
			return nil, ErrIncompatible
		}
		out[name] = checksum
	}
	if rows.Err() != nil {
		return nil, ErrIncompatible
	}
	return out, nil
}

func compatible(seen map[string]string, expected []step, requireAll bool) bool {
	if len(seen) > len(expected) || requireAll && len(seen) != len(expected) {
		return false
	}
	for i, step := range expected {
		checksum, exists := seen[step.name]
		if i < len(seen) {
			if !exists || checksum != step.checksum {
				return false
			}
		} else if exists {
			return false
		}
	}
	return true
}

func Check(ctx context.Context, pool *pgxpool.Pool) error {
	seen, err := applied(ctx, pool)
	if err != nil || !compatible(seen, steps(), true) {
		return ErrIncompatible
	}
	return nil
}

func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ErrApply
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// All schema writers use one transaction-scoped lock, including first boot.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(724196502)"); err != nil {
		return ErrApply
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.fishing_schema_migrations (
name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		return ErrApply
	}
	seen, err := applied(ctx, tx)
	all := steps()
	if err != nil || !compatible(seen, all, false) {
		return ErrIncompatible
	}
	for _, step := range all {
		if _, exists := seen[step.name]; exists {
			continue
		}
		if _, err = tx.Exec(ctx, step.sql); err != nil {
			return fmt.Errorf("%w: %s", ErrApply, step.name)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO public.fishing_schema_migrations(name, checksum) VALUES ($1,$2)", step.name, step.checksum); err != nil {
			return ErrApply
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrApply
	}
	return nil
}
