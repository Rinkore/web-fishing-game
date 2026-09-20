package workshop

import (
	"context"
	"errors"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SeedDefinitions is an explicit operator/fixture step; gameplay services never
// acquire catalog write permissions. Existing definitions must match exactly.
func SeedDefinitions(ctx context.Context, pool *pgxpool.Pool, c *rules.Catalog) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, it := range c.Items {
		kind := it.Kind
		part := any(nil)
		if kind == "component" {
			if it.Part == "" {
				continue
			}
			kind = "equipment"
			part = it.Part
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`, it.ID, kind, part); err != nil {
			return err
		}
		var match bool
		if err := tx.QueryRow(ctx, `SELECT kind=$2 AND part IS NOT DISTINCT FROM $3::text FROM fishing.item_definitions WHERE id=$1`, it.ID, kind, part).Scan(&match); err != nil {
			return err
		}
		if !match {
			return errors.New("catalog definition conflict")
		}
	}
	return tx.Commit(ctx)
}
