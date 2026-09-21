package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"github.com/jackc/pgx/v5"
)

// Legacy feedback moderation for the operator console.

const (
	legacyFeedbackCDMaxHours  = 8760
	legacyFeedbackCostMax     = 1e12
	legacyFeedbackRewardMax   = 1000000000
	legacyFeedbackListMax     = 500
	legacyFeedbackNoteMaxRune = 60
)

var legacyFeedbackStatuses = map[string]string{"submitted": "已提交", "accepted": "已受理", "done": "已完成", "rejected": "已拒绝"}

type legacyFeedbackReward struct {
	Coins int64  `json:"coins"`
	Note  string `json:"note"`
	At    int64  `json:"at"`
	By    string `json:"by"`
	Total int64  `json:"total"`
}

func (a *API) legacyAdminFeedback(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	list := []map[string]any{}
	rows, err := a.pool.Query(ctx, `SELECT f.id,(extract(epoch FROM f.created_at)*1000)::bigint,lower(i.username),f.actor_name,
 f.body,f.kind,f.version,f.status,COALESCE((extract(epoch FROM f.status_at)*1000)::bigint,0),f.status_by,f.reward
 FROM fishing.feedback_entries f JOIN fishing.identities i ON i.account_id=f.account_id
 ORDER BY f.created_at DESC,f.id DESC LIMIT $1`, legacyFeedbackListMax)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id, key, name, text, kind, version, status, statusBy string
		var at, statusAt int64
		var reward []byte
		if err := rows.Scan(&id, &at, &key, &name, &text, &kind, &version, &status, &statusAt, &statusBy, &reward); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		entry := map[string]any{
			"id": id, "t": at, "key": key, "name": name, "text": text, "kind": kind,
			"version": version, "status": status,
		}
		if statusAt > 0 {
			entry["statusAt"] = statusAt
		}
		if statusBy != "" {
			entry["statusBy"] = statusBy
		}
		if len(reward) > 0 {
			var decoded any
			if json.Unmarshal(reward, &decoded) == nil {
				entry["reward"] = decoded
			}
		}
		list = append(list, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	hours, cost := a.legacyFeedbackConfig(ctx)
	write(w, 200, map[string]any{
		"ok": true, "feedback": list, "total": len(list), "statuses": legacyFeedbackStatuses,
		"cfg": map[string]any{
			"cdHours": math.Round(hours*100) / 100, "skipCost": cost,
			"cdHoursDefault": legacyFeedbackCDHoursDefault, "skipCostDefault": legacyFeedbackSkipCostDefault,
		},
	})
}

func (a *API) legacyAdminFeedbackStatus(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token  string `json:"token"`
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	if _, known := legacyFeedbackStatuses[in.Status]; !known {
		legacyTradeError(w, 400, "未知的反馈状态")
		return
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner int64
	if err := tx.QueryRow(ctx, `SELECT account_id FROM fishing.feedback_entries WHERE id=$1 FOR UPDATE`, in.ID).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			legacyTradeError(w, 404, "反馈不存在")
			return
		}
		failure(w, identity.ErrStorage)
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.feedback_entries SET status=$2,status_at=clock_timestamp(),status_by=$3 WHERE id=$1`,
		in.ID, in.Status, actor.Name); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "feedback/status", &owner, in.ID, "status="+in.Status); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "id": in.ID, "status": in.Status})
}

func (a *API) legacyAdminFeedbackDelete(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token string `json:"token"`
		ID    string `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner int64
	if err := tx.QueryRow(ctx, `SELECT account_id FROM fishing.feedback_entries WHERE id=$1 FOR UPDATE`, in.ID).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			legacyTradeError(w, 404, "反馈不存在")
			return
		}
		failure(w, identity.ErrStorage)
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.feedback_entries WHERE id=$1`, in.ID); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM fishing.feedback_entries`).Scan(&total); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "feedback/del", &owner, in.ID, "删除反馈"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "id": in.ID, "total": total})
}

func (a *API) legacyAdminFeedbackReward(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token string   `json:"token"`
		ID    string   `json:"id"`
		Coins *float64 `json:"coins"`
		Note  string   `json:"note"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	coins := math.Floor(0)
	if in.Coins != nil {
		coins = math.Floor(*in.Coins)
	}
	if math.IsNaN(coins) || math.IsInf(coins, 0) || coins <= 0 || coins > legacyFeedbackRewardMax {
		legacyTradeError(w, 400, "奖励金币需在 1 - 10 亿之间")
		return
	}
	amount := int64(coins)
	note := legacyAdminClip(in.Note, legacyFeedbackNoteMaxRune)

	var owner int64
	var retired bool
	err := a.pool.QueryRow(ctx, `SELECT f.account_id,i.retired FROM fishing.feedback_entries f JOIN fishing.identities i ON i.account_id=f.account_id WHERE f.id=$1`, in.ID).
		Scan(&owner, &retired)
	if errors.Is(err, pgx.ErrNoRows) {
		legacyTradeError(w, 404, "反馈不存在")
		return
	}
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if retired {
		legacyTradeError(w, 404, "该反馈的玩家账号已不存在")
		return
	}
	reward := legacyFeedbackReward{}
	playerCoins := int64(0)
	at := time.Now().UnixMilli()
	players := []int64{actor.AccountID}
	if owner != actor.AccountID {
		players = append(players, owner)
	}
	assetCtx := assets.WithSession(ctx, actor.AccountID, actor.Hash, true)
	_, err = assets.New(a.pool).Run(assetCtx, assets.Command{
		ActorID: actor.AccountID, RequestKey: legacyMarketKey("legacy:admin:feedback:reward"), Kind: "admin_grant",
		RuleVersion: "legacy-admin-v1", Players: players, Input: in.ID,
	}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var raw []byte
		if err := t.SQL().QueryRow(ctx, `SELECT reward FROM fishing.feedback_entries WHERE id=$1 FOR UPDATE`, in.ID).Scan(&raw); err != nil {
			return assets.Result{}, err
		}
		previous := legacyFeedbackReward{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &previous)
		}
		reward = legacyFeedbackReward{Coins: amount, Note: note, At: at, By: actor.Name, Total: previous.Total + amount}
		encoded, err := json.Marshal(reward)
		if err != nil {
			return assets.Result{}, err
		}
		if err := t.Coins(ctx, owner, amount); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.feedback_entries SET reward=$2 WHERE id=$1`, in.ID, encoded); err != nil {
			return assets.Result{}, err
		}
		if err := t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&playerCoins); err != nil {
			return assets.Result{}, err
		}
		detail := "coins=" + strconv.FormatInt(amount, 10) + " note=" + note
		if err := legacyAdminAudit(ctx, t.SQL(), actor, "feedback/reward", &owner, in.ID, detail); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "rewarded"}, nil
	})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, legacyTradeState{})
		return
	}
	write(w, 200, map[string]any{"ok": true, "id": in.ID, "reward": reward, "playerCoins": playerCoins})
}

func (a *API) legacyAdminFeedbackConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token    string   `json:"token"`
		CDHours  *float64 `json:"cdHours"`
		SkipCost *float64 `json:"skipCost"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	hours, cost := a.legacyFeedbackConfig(ctx)
	detail := []string{}
	if in.CDHours != nil {
		value := math.Round(*in.CDHours*100) / 100
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > legacyFeedbackCDMaxHours {
			legacyTradeError(w, 400, "CD 时长需在 0 - 8760 小时之间")
			return
		}
		hours = value
		detail = append(detail, "cdHours="+strconv.FormatFloat(value, 'f', -1, 64))
	}
	if in.SkipCost != nil {
		value := math.Floor(*in.SkipCost)
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > legacyFeedbackCostMax {
			legacyTradeError(w, 400, "清空 CD 费用需为非负整数")
			return
		}
		cost = int64(value)
		detail = append(detail, "skipCost="+strconv.FormatInt(cost, 10))
	}
	settings, err := json.Marshal(map[string]any{"cdHours": hours, "skipCost": cost})
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp())
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, "feedback", settings); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "feedback/cfg", nil, "", strings.Join(detail, " ")); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "cfg": map[string]any{"cdHours": hours, "skipCost": cost}})
}
