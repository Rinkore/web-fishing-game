// Package catalog stores immutable complete rule snapshots and an atomic head.
package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Version(c *rules.Catalog) string { return "catch-v1:" + c.Version + ":" + c.SourceSHA256 }
func Current(ctx context.Context, q assets.SQL) (*rules.Catalog, int64, error) {
	var raw []byte
	var id int64
	err := q.QueryRow(ctx, `SELECT COALESCE(h.release_id,0),r.catalog FROM fishing.catalog_head h LEFT JOIN fishing.catalog_releases r ON r.id=h.release_id WHERE singleton`).Scan(&id, &raw)
	if err != nil {
		return nil, 0, assets.ErrUnavailable
	}
	if id == 0 {
		c, e := rules.Default()
		return c, 0, e
	}
	c, e := rules.DecodeCatalog(raw)
	return c, id, e
}
func ByVersion(ctx context.Context, q assets.SQL, version string) (*rules.Catalog, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT catalog FROM fishing.catalog_releases WHERE rule_version=$1 ORDER BY id DESC LIMIT 1`, version).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		c, e := rules.Default()
		if e == nil && Version(c) == version {
			return c, nil
		}
		return nil, assets.ErrDeferred
	}
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	return rules.DecodeCatalog(raw)
}

type Publish struct {
	ActorID          int64
	RequestKey       string
	ExpectedRevision int64
	Catalog          json.RawMessage
	// Audit fields are optional for the generic v1 catalog editor. World/drop
	// admin mutations populate them so the console audit is committed with the
	// immutable catalog release and head update.
	AuditAction string
	AuditName   string
	AuditTarget string
	AuditDetail string
}

func PublishConfig(ctx context.Context, pool *pgxpool.Pool, r Publish) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, r.ActorID); err != nil {
		return assets.Result{}, err
	}
	if r.ExpectedRevision < 0 || len(r.Catalog) > 1<<20 {
		return assets.Result{}, assets.ErrInvalid
	}
	c, err := rules.DecodeCatalog(r.Catalog)
	if err != nil || rules.ValidateCatalog(c) != nil {
		return assets.Result{}, assets.ErrInvalid
	}
	c.SourceSHA256 = ""
	canonical, _ := json.Marshal(c)
	hash := sha256.Sum256(canonical)
	digest := hex.EncodeToString(hash[:])
	c.SourceSHA256 = digest
	canonical, _ = json.Marshal(c)
	input := struct {
		Revision int64
		Digest   string
	}{r.ExpectedRevision, digest}
	return assets.New(pool).Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "catalog_publish", RuleVersion: "catalog-schema-v1", Players: []int64{r.ActorID}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var current int64
		if err := t.SQL().QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton FOR UPDATE`).Scan(&current); err != nil {
			return assets.Result{}, err
		}
		if current != r.ExpectedRevision {
			return assets.Result{}, assets.Rejection("catalog_revision_changed")
		}
		// Definition identities cannot be silently deleted or change category.
		if err := t.EnsureDefinitions(ctx, c.Items); err != nil {
			return assets.Result{}, err
		}
		var id int64
		if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog) VALUES($1,$2,$3,$4,$5) RETURNING id`, t.OperationID(), r.ActorID, digest, Version(c), canonical).Scan(&id); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.catalog_head SET release_id=$1 WHERE singleton`, id); err != nil {
			return assets.Result{}, err
		}
		if r.AuditAction != "" {
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,action,target,detail) VALUES($1,$2,$3,$4,$5)`,
				r.ActorID, r.AuditName, r.AuditAction, r.AuditTarget, r.AuditDetail); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: "published", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
