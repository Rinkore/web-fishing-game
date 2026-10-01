package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5/pgxpool"
	"strconv"
	"strings"
)

type Service struct {
	pool   *pgxpool.Pool
	assets *assets.Service
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool, assets.New(pool)} }

// featureClosed reports whether a gate was explicitly turned off in this
// release, either directly or through its page group. An absent key stays
// enabled, matching the COALESCE(...,true) default the command gate uses.
func featureClosed(flags map[string]bool, key string) bool {
	if enabled, ok := flags[key]; ok && !enabled {
		return true
	}
	if i := strings.IndexByte(key, '.'); i > 0 {
		if enabled, ok := flags[key[:i]]; ok && !enabled {
			return true
		}
	}
	return false
}

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
	// LegacyOrder and LegacyAdminBypass are the optional metadata used by the
	// old operator console. They are committed with the feature release so a
	// successful publish cannot leave the console layout half updated.
	LegacyOrder       map[string][]string
	LegacyAdminBypass *bool
	LegacyAuditAction string
	LegacyAuditTarget string
	LegacyAuditDetail string
}

func (s *Service) Publish(ctx context.Context, r Publish) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, r.ActorID); err != nil {
		return assets.Result{}, err
	}
	if r.ExpectedRevision < 0 || len(r.Flags) < 8 || len(r.Flags) > 64 {
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
		case "market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends", "sea", "party", "fishing",
			"fishing.cast", "bd", "bd.equip", "bd.slots", "bd.save", "bd.autobuild",
			"character", "character.companion", "character.boat", "sea.upgrade", "sea.chart", "sea.voyage", "sea.quest", "sea.anchor", "sea.expedition",
			"character.collect", "character.upgrade", "character.pet", "character.role", "character.steal", "character.breeding",
			"ground", "ground.trade", "ground.party", "inventory", "inventory.subscribe",
			"chest.craft", "chest.open",
			"workshop.craft", "workshop.open",
			"workshop.growth", "workshop.sets",
			"mall.buy", "mall.sell", "mall.autosell", "mall.list", "mall.marketbuy",
			"codex", "records", "feedback", "feedback.submit", "feedback.skip", "logs", "wiki", "mail", "adminBypass":
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
		// Closing a feature must also make in-flight state terminal while it is
		// still covered by the publication transaction. These updates are kept
		// local instead of calling module services, which would open a nested
		// asset transaction and publish separate operations.
		if enabled, ok := r.Flags["fishing"]; ok && !enabled {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1,resume_enabled=false WHERE state='active'`); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET state='stopped',generation=generation+1 WHERE state='active'`); err != nil {
				return assets.Result{}, err
			}
		}
		if enabled, ok := r.Flags["trade"]; ok && !enabled {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.trades SET state='cancelled',revision=revision+1,a_confirm=false,b_confirm=false WHERE state IN ('invited','accepted')`); err != nil {
				return assets.Result{}, err
			}
		}
		// A closed fish house must never back-pay the paused window, so closing
		// the collect gate rolls both clocks forward under this same publication
		// lock. Reopening therefore starts a fresh pond (design §10.3).
		if featureClosed(r.Flags, "character.collect") {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.house_state SET settled_at=clock_timestamp(),enabled_at=clock_timestamp()`); err != nil {
				return assets.Result{}, err
			}
		}
		if r.LegacyOrder != nil || r.LegacyAdminBypass != nil {
			metadata := map[string]any{"order": r.LegacyOrder}
			if r.LegacyAdminBypass != nil {
				metadata["adminBypass"] = *r.LegacyAdminBypass
			}
			encoded, err := json.Marshal(metadata)
			if err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, "features", encoded); err != nil {
				return assets.Result{}, err
			}
		}
		if r.LegacyAuditAction != "" {
			var actorName string
			if err := t.SQL().QueryRow(ctx, `SELECT display_name FROM fishing.identities WHERE account_id=$1`, r.ActorID).Scan(&actorName); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$1,$3,$4,$5)`, r.ActorID, actorName, r.LegacyAuditAction, r.LegacyAuditTarget, r.LegacyAuditDetail); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: "published", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
