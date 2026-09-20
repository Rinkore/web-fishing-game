package assets

import (
	"context"
	"fishing.local/server/internal/rules"
)

// EnsureDefinitions is called only by a validated administrative publication.
// Existing asset identities retain their category and equipment part forever.
func (t *Transaction) EnsureDefinitions(ctx context.Context, items []rules.Item) error {
	ids := []string{}
	for _, it := range items {
		kind := it.Kind
		var part any
		if kind == "component" {
			if it.Part == "" {
				continue
			}
			kind = "equipment"
			part = it.Part
		}
		ids = append(ids, it.ID)
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, it.ID, kind, part); err != nil {
			return err
		}
		var match bool
		if err := t.SQL().QueryRow(ctx, `SELECT kind=$2 AND part IS NOT DISTINCT FROM $3::text FROM fishing.item_definitions WHERE id=$1`, it.ID, kind, part).Scan(&match); err != nil {
			return err
		}
		if !match {
			return Rejection("catalog_definition_conflict")
		}
	}
	var absent bool
	if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.item_definitions WHERE NOT(id=ANY($1::text[])))`, ids).Scan(&absent); err != nil {
		return err
	}
	if absent {
		return Rejection("catalog_definition_missing")
	}
	return nil
}
