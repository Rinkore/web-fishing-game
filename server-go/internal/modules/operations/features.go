package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5/pgxpool"
	"strconv"
)

type Service struct {
	pool   *pgxpool.Pool
	assets *assets.Service
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool, assets.New(pool)} }

type Features struct {
	Revision int64           `json:"revision,string"`
	Digest   string          `json:"digest"`
	Flags    map[string]bool `json:"flags"`
}

func (s *Service) Features(ctx context.Context) (Features, error) {
	var v Features
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(h.release_id,0),COALESCE(r.digest,''),COALESCE(r.flags,'{}'::jsonb) FROM fishing.feature_head h LEFT JOIN fishing.feature_releases r ON r.id=h.release_id WHERE singleton`).Scan(&v.Revision, &v.Digest, &raw); err != nil {
		return v, assets.ErrUnavailable
	}
	if json.Unmarshal(raw, &v.Flags) != nil {
		return v, assets.ErrUnavailable
	}
	return v, nil
}

type Publish struct {
	ActorID          int64
	RequestKey       string
	ExpectedRevision int64
	Flags            map[string]bool
}

func (s *Service) Publish(ctx context.Context, r Publish) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, r.ActorID); err != nil {
		return assets.Result{}, err
	}
	if r.ExpectedRevision < 0 || len(r.Flags) < 8 || len(r.Flags) > 10 {
		return assets.Result{}, assets.ErrInvalid
	}
	// Existing eight-flag publications remain valid. New domains default to
	// enabled when omitted, matching releases created before those domains.
	for _, k := range []string{"market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends"} {
		if _, ok := r.Flags[k]; !ok {
			return assets.Result{}, assets.ErrInvalid
		}
	}
	for k := range r.Flags {
		switch k {
		case "market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends", "sea", "party":
		default:
			return assets.Result{}, assets.ErrInvalid
		}
	}
	data, err := json.Marshal(r.Flags)
	if err != nil {
		return assets.Result{}, assets.ErrInvalid
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "feature_publish", RuleVersion: "feature-schema-v1", Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var current int64
		if err := t.SQL().QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.feature_head WHERE singleton FOR UPDATE`).Scan(&current); err != nil {
			return assets.Result{}, err
		}
		if current != r.ExpectedRevision {
			return assets.Result{}, assets.Rejection("feature_revision_changed")
		}
		var id int64
		if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.feature_releases(operation_id,actor_id,schema_version,digest,flags) VALUES($1,$2,1,$3,$4) RETURNING id`, t.OperationID(), r.ActorID, digest, data).Scan(&id); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.feature_head SET release_id=$1 WHERE singleton`, id); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "published", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
