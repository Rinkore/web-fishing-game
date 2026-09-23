package app

import (
	"context"
	"errors"

	"fishing.local/server/internal/modules/catalog"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Schema migrations do not seed item definitions. Check the published rules
// and definitions in one snapshot before accepting players; otherwise a cast
// can start successfully and retry its first reward forever.
func checkCatalogDefinitions(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	c, _, err := catalog.Current(ctx, tx)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,kind,COALESCE(part,'') FROM fishing.item_definitions`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type definition struct{ kind, part string }
	definitions := map[string]definition{}
	for rows.Next() {
		var id string
		var d definition
		if err := rows.Scan(&id, &d.kind, &d.part); err != nil {
			return err
		}
		definitions[id] = d
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range c.Items {
		want := definition{kind: item.Kind}
		if item.Kind == "component" {
			if item.Part == "" {
				continue
			}
			want = definition{kind: "equipment", part: item.Part}
		}
		if got, ok := definitions[item.ID]; !ok || got != want {
			return errors.New("catalog item definitions missing or incompatible; initialize or repair definitions before starting the game")
		}
	}
	return tx.Commit(ctx)
}
