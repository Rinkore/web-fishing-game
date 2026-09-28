// Package gearmerge implements the phase-1 merge of the retired gear_*_2..5
// base ids into their canonical gear_*_1 base: publishing the alias-marked
// catalog and rewriting every stored alias reference (equipment instance
// signatures, mail attachments, codex rows). Phase 2 later removes the alias
// entries, the aliasOf support and the retired item_definitions rows.
package gearmerge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/rules"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errNoAdmin = errors.New("gearmerge: no admin account available as migration actor")

// Aliases extracts the retired → canonical base id map from the catalog.
func Aliases(c *rules.Catalog) map[string]string {
	out := map[string]string{}
	for _, it := range c.Items {
		if it.AliasOf != "" {
			out[it.ID] = it.AliasOf
		}
	}
	return out
}

// Check applies pending schema migrations first so the tool never runs against
// a partially migrated database.
func Check(ctx context.Context, pool *pgxpool.Pool) error {
	return migrations.Check(ctx, pool)
}

// Publish publishes the embedded (alias-marked) catalog as a new release. The
// actor must be an administrator account id; the maintenance context keeps the
// normal ledger and audit trail while skipping interactive session checks.
func Publish(ctx context.Context, pool *pgxpool.Pool, actor int64) (string, error) {
	c, err := rules.Default()
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	// The publisher's own player row is locked by the command guard, so it
	// must exist even for a pure maintenance actor.
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES ($1) ON CONFLICT DO NOTHING`, actor); err != nil {
		return "", err
	}
	mctx := assets.WithMaintenance(ctx, actor)
	var revision int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton`).Scan(&revision); err != nil {
		return "", err
	}
	result, err := catalog.PublishConfig(mctx, pool, catalog.Publish{
		ActorID:          actor,
		RequestKey:       fmt.Sprintf("gearmerge-publish-%d", time.Now().UnixMilli()),
		ExpectedRevision: revision,
		Catalog:          raw,
		AuditAction:      "publish",
		AuditName:        "gear base merge",
		AuditTarget:      c.Version,
	})
	if err != nil {
		return "", err
	}
	if result.Status != "published" {
		return "", fmt.Errorf("publish rejected: %s", result.Status)
	}
	return c.Version, nil
}

// Migrate rewrites stored alias references. Equipment instance rows carry the
// signature in attributes->>'signature' and the base in definition_id; market
// escrow and rod loadouts reference instance row ids, so rewriting the rows
// covers them. mail_attachments.item_id stores the raw signature. Codex rows
// are keyed by base id and merged into the canonical row.
func Migrate(ctx context.Context, pool *pgxpool.Pool, c *rules.Catalog, dryRun bool) (stats, error) {
	var s stats
	aliases := Aliases(c)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return s, err
	}
	defer tx.Rollback(context.Background())
	for alias, target := range aliases {
		rows, err := tx.Query(ctx, `SELECT id, attributes->>'signature' FROM fishing.equipment_instances WHERE definition_id=$1 AND attributes ? 'signature'`, alias)
		if err != nil {
			return s, err
		}
		type row struct {
			id  int64
			sig string
		}
		list := []row{}
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.sig); err != nil {
				rows.Close()
				return s, err
			}
			list = append(list, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return s, err
		}
		for _, r := range list {
			newSig := target + r.sig[len(alias):]
			s.Instances++
			if dryRun {
				fmt.Printf("instance #%d %s -> %s\n", r.id, r.sig, newSig)
				continue
			}
			if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET definition_id=$1, attributes=jsonb_set(attributes,'{signature}',to_jsonb($2::text)) WHERE id=$3`, target, newSig, r.id); err != nil {
				return s, err
			}
		}
		if dryRun {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_attachments WHERE item_id LIKE $1||'#%'`, alias).Scan(&n); err != nil {
				return s, err
			}
			s.Mail += n
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM fishing.player_codex WHERE item_id=$1`, alias).Scan(&n); err != nil {
				return s, err
			}
			s.Codex += n
			continue
		}
		tag, err := tx.Exec(ctx, `UPDATE fishing.mail_attachments SET item_id=$1||substr(item_id,length($2)+1) WHERE item_id LIKE $2||'#%'`, target, alias)
		if err != nil {
			return s, err
		}
		s.Mail += int(tag.RowsAffected())
		tag, err = tx.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at)
			SELECT owner_id,$1,count,now() FROM fishing.player_codex WHERE item_id=$2
			ON CONFLICT(owner_id,item_id) DO UPDATE SET count=fishing.player_codex.count+excluded.count`, target, alias)
		if err != nil {
			return s, err
		}
		s.Codex += int(tag.RowsAffected())
		if _, err := tx.Exec(ctx, `DELETE FROM fishing.player_codex WHERE item_id=$1`, alias); err != nil {
			return s, err
		}
	}
	if dryRun {
		return s, nil
	}
	return s, tx.Commit(ctx)
}

type stats struct {
	Instances int
	Mail      int
	Codex     int
}

// Remaining reports how many alias references survive in each store; phase 2
// is only safe when all three are zero.
func Remaining(ctx context.Context, pool *pgxpool.Pool, c *rules.Catalog) (stats, error) {
	var s stats
	for alias := range Aliases(c) {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE definition_id=$1 OR attributes->>'signature' LIKE $1||'#%'`, alias).Scan(&n); err != nil {
			return s, err
		}
		s.Instances += n
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_attachments WHERE item_id LIKE $1||'#%'`, alias).Scan(&n); err != nil {
			return s, err
		}
		s.Mail += n
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.player_codex WHERE item_id=$1`, alias).Scan(&n); err != nil {
			return s, err
		}
		s.Codex += n
	}
	return s, nil
}

// HeadHasAliases reports whether the live catalog head already carries the
// alias-marked base list.
func HeadHasAliases(ctx context.Context, pool *pgxpool.Pool, c *rules.Catalog) (bool, error) {
	var raw []byte
	err := pool.QueryRow(ctx, `SELECT r.catalog FROM fishing.catalog_head h JOIN fishing.catalog_releases r ON r.id=h.release_id WHERE h.singleton AND h.release_id IS NOT NULL`).Scan(&raw)
	if err != nil {
		return false, nil // no release yet: embedded defaults are the head
	}
	head, err := rules.DecodeCatalog(raw)
	if err != nil {
		return false, err
	}
	return len(Aliases(head)) == len(Aliases(c)) && head.Version == c.Version, nil
}

// AutoMigrate is the idempotent startup hook: it publishes the alias-marked
// catalog when the head is still pre-merge and converts any stored alias
// references. After the first successful run it is a cheap no-op, so every
// restart (multiple nodes, rollbacks) is safe. Phase 2 — dropping the alias
// entries, the aliasOf support and the retired item_definitions rows — stays a
// deliberate later release once Remaining reports zero.
func AutoMigrate(ctx context.Context, pool *pgxpool.Pool, logf func(string, ...any)) error {
	c, err := rules.Default()
	if err != nil {
		return err
	}
	if len(Aliases(c)) == 0 {
		return nil
	}
	rem, err := Remaining(ctx, pool, c)
	if err != nil {
		return err
	}
	headHas, err := HeadHasAliases(ctx, pool, c)
	if err != nil {
		return err
	}
	if rem.Instances+rem.Mail+rem.Codex == 0 && headHas {
		return nil
	}
	if !headHas {
		actor, err := MaintenanceActor(ctx, pool)
		// A fresh game (or a game with no provisioned administrator yet) has
		// nothing to rewrite. Keep it available for registration and retry the
		// audited catalog publication on a later startup. Existing alias
		// references still require an administrator and fail closed.
		if errors.Is(err, errNoAdmin) && rem.Instances+rem.Mail+rem.Codex == 0 {
			logf("gearmerge: catalog publication deferred until an admin account exists")
			return nil
		}
		if err != nil {
			return err
		}
		version, err := Publish(ctx, pool, actor)
		if err != nil {
			return err
		}
		logf("gearmerge: alias catalog published", "version", version)
	}
	s, err := Migrate(ctx, pool, c, false)
	if err != nil {
		return err
	}
	logf("gearmerge: retired gear bases converted", "instances", s.Instances, "mail", s.Mail, "codex", s.Codex)
	rem, err = Remaining(ctx, pool, c)
	if err != nil {
		return err
	}
	if rem.Instances+rem.Mail+rem.Codex > 0 {
		return fmt.Errorf("gearmerge: %d instance, %d mail, %d codex alias references remain", rem.Instances, rem.Mail, rem.Codex)
	}
	return nil
}

// MaintenanceActor picks the actor recorded on the migration ledger: the
// lowest admin account that has a player row, creating the player row when an
// admin account has none yet.
func MaintenanceActor(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var actor int64
	err := pool.QueryRow(ctx, `SELECT i.account_id FROM fishing.identities i JOIN fishing.player_state p ON p.account_id=i.account_id WHERE i.admin AND NOT i.banned ORDER BY i.account_id LIMIT 1`).Scan(&actor)
	if err == nil {
		return actor, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	err = pool.QueryRow(ctx, `SELECT i.account_id FROM fishing.identities i WHERE i.admin AND NOT i.banned ORDER BY i.account_id LIMIT 1`).Scan(&actor)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, errNoAdmin
		}
		return 0, err
	}
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES ($1) ON CONFLICT DO NOTHING`, actor); err != nil {
		return 0, err
	}
	return actor, nil
}
