package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Legacy operations console (read-only surface plus the shared helpers the
// mutation handlers use).
//
// The console authorizes with the administrator realm like every other
// /api/admin/* route: the operator must have the admin flag and a valid MFA
// session. Privileged writes record one append-only row in fishing.admin_audit;
// the database-role enrollment trail stays separate on purpose (see migration
// 0023).
//
// Deliberately still out of scope, each needing its own design: the user
// snapshot store (GET/POST /api/admin/users/snapshot, users/snapshots,
// users/snapshot-now, users/rollback), the world/drop configuration editors,
// the banner console and the wiki content editor.

const (
	legacyAdminAuditKeep      = 300
	legacyAdminLockMaxFails   = 5
	legacyAdminLockWindowMin  = 10
	legacyAdminLockMinutes    = 5
	legacyListingCapDefault   = 40
	legacyListingCapMax       = 10000
	legacyAdminBanMaxHours    = 24 * 3650
	legacyRegistrationGlobal  = 200
	legacyRegistrationPerIP   = 10
	legacyRegistrationPerName = 5
)

// legacyAdminExec is satisfied by both *pgxpool.Pool and pgx.Tx, so an audit row
// can be written in the same transaction as the mutation it records.
type legacyAdminExec interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func legacyAdminClip(text string, limit int) string {
	trimmed := strings.TrimSpace(text)
	runes := []rune(trimmed)
	if len(runes) <= limit {
		return trimmed
	}
	return string(runes[:limit])
}

func legacyAdminAudit(ctx context.Context, exec legacyAdminExec, actor identity.Session, action string, subject *int64, target, detail string) error {
	_, err := exec.Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,$4,$5,$6)`,
		actor.AccountID, actor.Name, subject, action, legacyAdminClip(target, 120), legacyAdminClip(detail, 200))
	return err
}

// legacyAdminSetting reads one console-edited setting into out, leaving the
// caller's default in place when the key was never saved.
func (a *API) legacyAdminSetting(ctx context.Context, key string, out any) error {
	var raw []byte
	err := a.pool.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if json.Unmarshal(raw, out) != nil {
		return nil
	}
	return nil
}

func (a *API) legacyCount(ctx context.Context, query string, args ...any) int64 {
	var count int64
	if err := a.pool.QueryRow(ctx, query, args...).Scan(&count); err != nil {
		return 0
	}
	return count
}

func (a *API) legacyAdminCatalog(c *rules.Catalog) (int64, int64) {
	var grounds []struct {
		Spots []struct {
			ID string `json:"id"`
		} `json:"spots"`
	}
	if c.Constant("GROUNDS", &grounds) != nil {
		return 0, 0
	}
	spots := int64(0)
	for _, ground := range grounds {
		spots += int64(len(ground.Spots))
	}
	return int64(len(grounds)), spots
}

func (a *API) legacyAdminOverview(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	live, err := operations.New(a.pool).LiveSample(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	c, err := a.catalog(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	groundCount, spotCount := a.legacyAdminCatalog(c)
	biteFormula := ""
	_ = c.Constant("BITE_FORMULA_DEFAULT", &biteFormula)
	notifyLevel := "all"
	var notifySetting struct {
		Level string `json:"level"`
	}
	if a.legacyAdminSetting(ctx, "notify", &notifySetting) == nil && notifySetting.Level != "" {
		notifyLevel = notifySetting.Level
	}
	write(w, 200, map[string]any{
		"ok":            true,
		"userCount":     live.Players,
		"online":        live.Online,
		"fishingCount":  live.Fishing,
		"listings":      live.Listings,
		"activeTrades":  live.Trades,
		"notifyLevel":   notifyLevel,
		"biteFormula":   biteFormula,
		"groundCount":   groundCount,
		"spotCount":     spotCount,
		"feedbackCount": a.legacyCount(ctx, `SELECT count(*) FROM fishing.feedback_entries`),
	})
}

func (a *API) legacyAdminStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	query := r.URL.Query()
	filter := operations.StatsFilter{Ground: query.Get("ground"), Spot: query.Get("spot")}
	_, offsetSeconds := time.Now().In(a.location).Zone()
	minutes := offsetSeconds % 3600 / 60
	if minutes < 0 {
		minutes = -minutes
	}
	offset := fmt.Sprintf("%+03d:%02d", offsetSeconds/3600, minutes)
	report, err := operations.New(a.pool).StatsReport(ctx, query.Get("range"), filter, offset)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	c, err := a.catalog(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	areaLabel := ""
	if filter.Spot != "" || filter.Ground != "" {
		areaLabel = "该钓点钓鱼人数"
	}
	live := report.Live
	write(w, 200, map[string]any{
		"ok":       true,
		"range":    report.Range,
		"step":     report.Step,
		"span":     report.Span,
		"from":     report.From,
		"now":      report.Now,
		"points":   report.Points,
		"heat":     report.Heat,
		"heatN":    report.HeatN,
		"heatMax":  report.HeatMax,
		"heatDays": report.HeatDays,
		"filter":   map[string]any{"ground": filter.Ground, "spot": filter.Spot, "areaLabel": areaLabel},
		"peak":     map[string]any{"online": report.Peak.Online, "t": report.Peak.T},
		"live": map[string]any{
			"t":        time.Now().Truncate(time.Minute).UnixMilli(),
			"online":   live.Online,
			"fishing":  live.Fishing,
			"listings": live.Listings,
			"trades":   live.Trades,
			"users":    live.Players,
			"grounds":  live.Grounds,
			"spots":    live.Spots,
		},
		"grounds": legacyAdminGroundCatalog(c),
		"samples": map[string]any{"min": report.Samples.Min, "hour": report.Samples.Hour},
	})
}

// legacyAdminGroundCatalog projects the ground catalog for the overview filter
// dropdown: id, name and every spot as "ground:spot" keyed entries.
func legacyAdminGroundCatalog(c *rules.Catalog) []map[string]any {
	var grounds []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Spots []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"spots"`
	}
	if c.Constant("GROUNDS", &grounds) != nil {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(grounds))
	for _, ground := range grounds {
		spots := make([]map[string]any, 0, len(ground.Spots))
		for _, spot := range ground.Spots {
			spots = append(spots, map[string]any{"id": spot.ID, "name": spot.Name, "key": ground.ID + ":" + spot.ID})
		}
		out = append(out, map[string]any{"id": ground.ID, "name": ground.Name, "spots": spots})
	}
	return out
}

func (a *API) legacyAdminNetstats(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	write(w, 200, map[string]any{
		"ok":        true,
		"uptimeSec": int64(time.Since(a.started).Seconds()),
		"sseBytes":  a.sseBytes.Load(),
		"sseMsgs":   a.sseMsgs.Load(),
		"sseWrites": a.sseWrites.Load(),
		"apiBytes":  a.apiBytes.Load(),
		"apiReqs":   a.apiReqs.Load(),
	})
}

func (a *API) legacyAdminRegistrationStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	limited := a.regLimited.Load()
	duplicate := a.regDuplicate.Load()
	write(w, 200, map[string]any{
		"counters": map[string]any{
			"attempts": a.regAttempts.Load(), "created": a.regCreated.Load(), "rejected": a.regRejected.Load(),
			// The Go registration path has no challenge round: a rejected
			// attempt never has a challenge to solve, so the counter stays 0.
			"challenged": 0,
			"duplicate":  duplicate, "limited": limited,
		},
		"startedAt": a.started.UnixMilli(),
		"limits": map[string]any{
			"globalHourly": legacyRegistrationGlobal, "ipHourly": legacyRegistrationPerIP, "usernameHourly": legacyRegistrationPerName,
		},
		"attention": limited > 0 || duplicate >= 5,
	})
}

func (a *API) legacyAdminSecurity(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	log := []map[string]any{}
	rows, err := a.pool.Query(ctx, `SELECT (extract(epoch FROM a.created_at)*1000)::bigint,a.actor_name,
 COALESCE(i.username,''),a.action,a.target,a.detail
 FROM fishing.admin_audit a LEFT JOIN fishing.identities i ON i.account_id=a.actor_id
 ORDER BY a.created_at DESC,a.id DESC LIMIT $1`, legacyAdminAuditKeep)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var at int64
		var name, key, action, target, detail string
		if err := rows.Scan(&at, &name, &key, &action, &target, &detail); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		log = append(log, map[string]any{"t": at, "key": key, "name": name, "action": action, "target": target, "detail": detail})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()

	banned := []map[string]any{}
	rows, err = a.pool.Query(ctx, `SELECT i.account_id,lower(i.username),i.display_name,i.banned,i.ban_until,i.ban_reason,i.ban_by,i.ban_at
 FROM fishing.identities i WHERE i.banned AND NOT i.retired ORDER BY i.ban_at DESC NULLS LAST,i.account_id DESC`)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id int64
		var key, name, reason, by string
		var flagged bool
		var until, at *time.Time
		if err := rows.Scan(&id, &key, &name, &flagged, &until, &reason, &by, &at); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		state := identity.BanStateOf(flagged, until, reason, by, at)
		if !state.Banned {
			continue
		}
		banned = append(banned, map[string]any{
			"key": key, "name": name, "username": key,
			"permanent": state.Permanent, "until": state.Until, "remainMs": state.RemainMS,
			"reason": state.Reason, "banBy": state.By, "banAt": state.At,
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()

	lockouts := []identity.Lockout{}
	if locks, err := a.identity.Lockouts(ctx); err == nil {
		lockouts = locks
	}
	write(w, 200, map[string]any{
		"ok": true, "log": log, "banned": banned, "lockouts": lockouts,
		"rules": map[string]any{"maxFails": legacyAdminLockMaxFails, "windowMin": legacyAdminLockWindowMin, "lockMin": legacyAdminLockMinutes},
	})
}

func (a *API) legacyAdminUsers(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	ctx := r.Context()
	users := []map[string]any{}
	rows, err := a.pool.Query(ctx, `SELECT i.account_id,lower(i.username),i.display_name,i.qq,i.admin,w.coins,
 p.catch_count,p.listing_capacity,(extract(epoch FROM acc.created_at)*1000)::bigint,
 i.banned,i.ban_until,i.ban_reason,i.ban_by,i.ban_at,
 EXISTS(SELECT 1 FROM fishing.gateway_streams g WHERE g.owner_id=i.account_id AND g.expires_at>clock_timestamp()),
 EXISTS(SELECT 1 FROM fishing.native_fishing_sessions s WHERE s.owner_id=i.account_id AND s.state='active'),
 (SELECT count(*) FROM fishing.market_orders o WHERE o.seller_id=i.account_id AND o.state='open')
 FROM fishing.identities i JOIN fishing.accounts acc ON acc.id=i.account_id
 JOIN fishing.wallets w ON w.account_id=i.account_id JOIN fishing.player_state p ON p.account_id=i.account_id
 WHERE NOT i.retired ORDER BY acc.created_at DESC,i.account_id DESC`)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id, coins, catchCount, listings, createdAt int64
		var key, name, qq, reason, by string
		var admin, online, fishing, flagged bool
		var capacity int
		var until, at *time.Time
		if err := rows.Scan(&id, &key, &name, &qq, &admin, &coins, &catchCount, &capacity, &createdAt,
			&flagged, &until, &reason, &by, &at, &online, &fishing, &listings); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		state := identity.BanStateOf(flagged, until, reason, by, at)
		entry := map[string]any{
			"key": key, "username": key, "name": name, "qq": qq, "admin": admin, "coins": coins,
			"listingCap": capacity, "capSet": false, "listings": listings, "catchCount": catchCount,
			"online": online, "createdAt": createdAt,
			"banned": state.Banned, "banPermanent": state.Permanent, "banUntil": state.Until,
			"banRemainMs": state.RemainMS, "banReason": state.Reason, "banBy": state.By,
		}
		if fishing {
			entry["fishing"] = true
		} else {
			entry["fishing"] = nil
		}
		users = append(users, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	write(w, 200, map[string]any{"ok": true, "users": users, "me": strings.ToLower(actor.Username)})
}
