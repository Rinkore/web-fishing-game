package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Legacy component-subscription and feedback contracts.
//
// The original server kept the subscription config on the account record and the
// feedback queue in its runtime store. Both are persisted here (migration 0022).
// The feedback cooldown and skip cost are operator settings in the original
// system. They live in fishing.operator_settings once the console saves them;
// the documented defaults apply until then.
const (
	legacyFeedbackMaxLen          = 1000
	legacyFeedbackKeep            = 500
	legacyFeedbackCDHoursDefault  = 24
	legacyFeedbackSkipCostDefault = 10000
)

type legacySubscriptionBase struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Part string `json:"part"`
}

// legacyFeedbackConfig resolves the effective cooldown length and skip cost.
func (a *API) legacyFeedbackConfig(ctx context.Context) (float64, int64) {
	hours, cost := float64(legacyFeedbackCDHoursDefault), int64(legacyFeedbackSkipCostDefault)
	var stored struct {
		CDHours  *float64 `json:"cdHours"`
		SkipCost *int64   `json:"skipCost"`
	}
	if a.legacyAdminSetting(ctx, "feedback", &stored) == nil {
		if stored.CDHours != nil && *stored.CDHours >= 0 && *stored.CDHours <= 8760 {
			hours = *stored.CDHours
		}
		if stored.SkipCost != nil && *stored.SkipCost >= 0 && *stored.SkipCost <= 1e12 {
			cost = *stored.SkipCost
		}
	}
	return hours, cost
}

func legacyFeedbackCD(hours float64) time.Duration {
	return time.Duration(math.Round(hours * float64(time.Hour)))
}

// legacyFeedbackStateOf mirrors the original feedbackStatusOf(key); the HTTP
// handler of the same name lives in this file's route registration.
func (a *API) legacyFeedbackStateOf(ctx context.Context, owner int64) (map[string]any, error) {
	var nextAt *time.Time
	err := a.pool.QueryRow(ctx, `SELECT next_at FROM fishing.feedback_cooldowns WHERE account_id=$1`, owner).Scan(&nextAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, identity.ErrStorage
	}
	now := time.Now()
	next := int64(0)
	if nextAt != nil {
		next = nextAt.UnixMilli()
	}
	remaining := next - now.UnixMilli()
	if remaining < 0 {
		remaining = 0
	}
	hours, cost := a.legacyFeedbackConfig(ctx)
	return map[string]any{
		"nextAt":      next,
		"ready":       remaining == 0,
		"remainingMs": remaining,
		"skipCost":    cost,
		"cdHours":     math.Round(hours*100) / 100,
	}, nil
}

func (a *API) legacySubscriptionCatalog(c *rules.Catalog) (map[string]any, error) {
	var bases []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Part string `json:"part"`
	}
	if err := c.Constant("COMPONENT_BASES", &bases); err != nil {
		return nil, identity.ErrStorage
	}
	projected := make([]legacySubscriptionBase, 0, len(bases))
	for _, base := range bases {
		projected = append(projected, legacySubscriptionBase{ID: base.ID, Name: base.Name, Part: base.Part})
	}
	qualities := map[string]any{}
	if err := c.Constant("QUALITY", &qualities); err != nil {
		return nil, identity.ErrStorage
	}
	affixes := map[string]string{}
	if err := c.Constant("AFFIX_LABEL", &affixes); err != nil {
		return nil, identity.ErrStorage
	}
	return map[string]any{"bases": projected, "qualities": qualities, "affixes": affixes}, nil
}

// legacyOptNumber mirrors the original optNum: null/absent/empty is null, any
// numeric string or number is rounded, anything else is rejected.
func legacyOptNumber(raw json.RawMessage) (any, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil, true
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, false
		}
		return math.Round(value), true
	}
	var value float64
	if json.Unmarshal(raw, &value) != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, false
	}
	return math.Round(value), true
}

func legacyFeedbackText(raw string) string {
	text := strings.TrimSpace(raw)
	if utf8.RuneCountInString(text) <= legacyFeedbackMaxLen {
		return text
	}
	return string([]rune(text)[:legacyFeedbackMaxLen])
}

func legacyFeedbackID(now time.Time) string {
	var suffix [3]byte
	_, _ = rand.Read(suffix[:])
	return "fb_" + strconv.FormatInt(now.UnixMilli(), 10) + "_" + hex.EncodeToString(suffix[:])
}

func (a *API) legacySubscribeGet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	catalog, err := a.legacySubscriptionCatalog(c)
	if err != nil {
		failure(w, err)
		return
	}
	cfg := map[string]any{}
	var raw []byte
	err = a.pool.QueryRow(r.Context(), `SELECT config FROM fishing.subscription_settings WHERE account_id=$1`, session.AccountID).Scan(&raw)
	if err == nil {
		if json.Unmarshal(raw, &cfg) != nil {
			failure(w, identity.ErrStorage)
			return
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "cfg": cfg, "catalog": catalog})
}

func (a *API) legacySubscribeSet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		On        bool            `json:"on"`
		BaseID    string          `json:"baseId"`
		Quality   string          `json:"quality"`
		AffixType string          `json:"affixType"`
		Min       json.RawMessage `json:"min"`
		Max       json.RawMessage `json:"max"`
		Badge     *bool           `json:"badge"`
		Blink     *bool           `json:"blink"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	catalog, err := a.legacySubscriptionCatalog(c)
	if err != nil {
		failure(w, err)
		return
	}
	if in.BaseID != "" {
		known := false
		for _, base := range catalog["bases"].([]legacySubscriptionBase) {
			if base.ID == in.BaseID {
				known = true
				break
			}
		}
		if !known {
			legacyTradeError(w, 400, "未知的底材")
			return
		}
	}
	if in.Quality != "" {
		if _, ok := catalog["qualities"].(map[string]any)[in.Quality]; !ok {
			legacyTradeError(w, 400, "未知的品质")
			return
		}
	}
	if in.AffixType != "" {
		if _, ok := catalog["affixes"].(map[string]string)[in.AffixType]; !ok {
			legacyTradeError(w, 400, "未知的词条类型")
			return
		}
	}
	min, okMin := legacyOptNumber(in.Min)
	max, okMax := legacyOptNumber(in.Max)
	if !okMin || !okMax {
		legacyTradeError(w, 400, "数值范围需为数字")
		return
	}
	if min != nil && max != nil {
		if min.(float64) > max.(float64) {
			legacyTradeError(w, 400, "最小值不能大于最大值")
			return
		}
	}
	cfg := map[string]any{
		"on": in.On, "baseId": in.BaseID, "quality": in.Quality, "affixType": in.AffixType,
		"min": min, "max": max,
		"badge": in.Badge == nil || *in.Badge,
		"blink": in.Blink == nil || *in.Blink,
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if _, err := a.pool.Exec(r.Context(), `INSERT INTO fishing.subscription_settings(account_id,config,updated_at) VALUES($1,$2,clock_timestamp())
 ON CONFLICT(account_id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at`, session.AccountID, data); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "cfg": cfg})
}

func (a *API) legacyFeedbackGet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	status, err := a.legacyFeedbackStateOf(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	mine := []map[string]any{}
	rows, err := a.pool.Query(r.Context(), `SELECT f.id,(extract(epoch FROM f.created_at)*1000)::bigint,lower(i.username),f.actor_name,f.body,f.kind,f.version,f.status
 FROM fishing.feedback_entries f JOIN fishing.identities i ON i.account_id=f.account_id
 WHERE f.account_id=$1 ORDER BY f.created_at DESC,f.id DESC LIMIT 20`, session.AccountID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id, key, name, text, kind, version, state string
		var at int64
		if err := rows.Scan(&id, &at, &key, &name, &text, &kind, &version, &state); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		mine = append(mine, map[string]any{"id": id, "t": at, "key": key, "name": name, "text": text, "kind": kind, "version": version, "status": state})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	var coins int64
	if err := a.pool.QueryRow(r.Context(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"status": status, "mine": mine, "coins": coins})
}

func (a *API) legacyFeedbackSubmit(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Text string `json:"text"`
		Kind string `json:"kind"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	cooldownHours, skipCost := a.legacyFeedbackConfig(ctx)
	status, err := a.legacyFeedbackStateOf(ctx, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	if ready, _ := status["ready"].(bool); !ready {
		remaining, _ := status["remainingMs"].(int64)
		message := "冷却中，" + strconv.FormatInt((remaining+59999)/60000, 10) + " 分钟后可再次提交（或花 " + strconv.FormatInt(skipCost, 10) + " 金币立即结束冷却）"
		write(w, 429, map[string]any{"error": message, "status": status})
		return
	}
	text := legacyFeedbackText(in.Text)
	if text == "" {
		legacyTradeError(w, 400, "反馈内容不能为空")
		return
	}
	kind := in.Kind
	if utf8.RuneCountInString(kind) > 20 {
		kind = string([]rune(kind)[:20])
	}
	if kind == "" {
		kind = "other"
	}
	c, err := a.catalog(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	var version string
	_ = json.Unmarshal(c.Constants["VERSION"], &version)
	now := time.Now()
	entry := map[string]any{
		"id": legacyFeedbackID(now), "t": now.UnixMilli(), "key": strings.ToLower(session.Username),
		"name": session.Name, "text": text, "kind": kind, "version": version, "status": "submitted",
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.feedback_entries(id,account_id,actor_name,kind,body,version,status)
 VALUES($1,$2,$3,$4,$5,$6,'submitted')`, entry["id"], session.AccountID, session.Name, kind, text, version); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.feedback_cooldowns(account_id,next_at,last_at) VALUES($1,clock_timestamp()+$2::interval,clock_timestamp())
 ON CONFLICT(account_id) DO UPDATE SET next_at=excluded.next_at,last_at=excluded.last_at`, session.AccountID, legacyFeedbackCD(cooldownHours).String()); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.feedback_entries WHERE id IN (SELECT id FROM fishing.feedback_entries ORDER BY created_at DESC,id DESC OFFSET $1)`, legacyFeedbackKeep); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	after, err := a.legacyFeedbackStateOf(ctx, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	// The original server pushed a live notice to online administrators here; the
	// operator review surface is not bridged yet, so the entry itself is the only
	// record of the submission.
	write(w, 200, map[string]any{"ok": true, "entry": entry, "status": after})
}

func (a *API) legacyFeedbackSkip(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	ctx := r.Context()
	_, skipCost := a.legacyFeedbackConfig(ctx)
	status, err := a.legacyFeedbackStateOf(ctx, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	if ready, _ := status["ready"].(bool); ready {
		legacyTradeError(w, 400, "当前不在冷却中，无需跳过")
		return
	}
	var coins int64
	if err := a.pool.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if coins < skipCost {
		legacyTradeError(w, 400, "金币不足（需 "+strconv.FormatInt(skipCost, 10)+"）")
		return
	}
	// Charging the fee and clearing the cooldown share one asset transaction so a
	// failed write cannot leave a paid player on cooldown.
	sessionCtx := assets.WithSession(ctx, session.AccountID, session.Hash, false)
	result, err := assets.New(a.pool).Run(sessionCtx, assets.Command{
		ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:feedback:skip"), Kind: "feedback_skip",
		RuleVersion: "legacy-feedback-v1", Players: []int64{session.AccountID}, Input: skipCost,
	}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if err := t.Coins(ctx, session.AccountID, -skipCost); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.feedback_cooldowns SET next_at=clock_timestamp() WHERE account_id=$1`, session.AccountID); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "skipped"}, nil
	})
	if err != nil {
		var rejection assets.Rejection
		if errors.As(err, &rejection) && string(rejection) == "insufficient_funds" {
			legacyTradeError(w, 400, "金币不足（需 "+strconv.FormatInt(skipCost, 10)+"）")
			return
		}
		a.legacyTradeWriteFailure(w, err, legacyTradeState{})
		return
	}
	// The asset machinery reports business rejections as Result.Status instead of
	// an error, so a raced balance check still surfaces as the legacy text.
	if result.Status != "skipped" {
		if result.Status == "insufficient_funds" {
			legacyTradeError(w, 400, "金币不足（需 "+strconv.FormatInt(skipCost, 10)+"）")
			return
		}
		a.legacyTradeWriteFailure(w, assets.Rejection(result.Status), legacyTradeState{})
		return
	}
	if err := a.pool.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	after, err := a.legacyFeedbackStateOf(ctx, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "coins": coins, "status": after})
}
