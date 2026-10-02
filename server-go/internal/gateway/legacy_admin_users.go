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

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"github.com/jackc/pgx/v5"
)

// Legacy account management: edit, ban/unban, administrator flag and deletion.
//
// Deletion is a retirement instead of a purge. The durable schema hangs the
// account off the append-only asset ledger, catch records and the operator
// audit trail, so removing the row would mean tearing the ledger apart.
// Retirement frees the username (the original contract: the login can be
// registered again), kills every session and lease, marks the account
// permanently banned and hides it from the console list, while the history
// stays readable.

// legacyAdminTarget resolves a console account key to its row.
func (a *API) legacyAdminTarget(ctx context.Context, key string) (int64, bool, error) {
	var id int64
	var retired bool
	err := a.pool.QueryRow(ctx, `SELECT account_id,retired FROM fishing.identities WHERE username=$1`, strings.ToLower(strings.TrimSpace(key))).Scan(&id, &retired)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, identity.ErrStorage
	}
	return id, !retired, nil
}

// legacyAdminKick drops every session, lease and running fishing session of one
// account. The original did the same on ban, password change and deletion.
func (a *API) legacyAdminKick(ctx context.Context, tx pgx.Tx, id int64) error {
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp() WHERE owner_id=$1`, id); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, id)
	return err
}

// legacyAdminAdminCount counts the current administrators while holding their
// rows, so two console requests cannot both revoke the last one.
func (a *API) legacyAdminAdminCount(ctx context.Context, tx pgx.Tx) (int64, error) {
	rows, err := tx.Query(ctx, `SELECT account_id FROM fishing.identities WHERE admin AND NOT retired FOR UPDATE`)
	if err != nil {
		return 0, err
	}
	count := int64(0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	return count, err
}

func (a *API) legacyAdminUserUpdate(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token      string          `json:"token"`
		Target     string          `json:"target"`
		Password   *string         `json:"password"`
		Name       *string         `json:"name"`
		Coins      *float64        `json:"coins"`
		ListingCap json.RawMessage `json:"listingCap"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	target := strings.ToLower(strings.TrimSpace(in.Target))
	targetID, exists, err := a.legacyAdminTarget(ctx, target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}

	changed := []string{}
	newPassword := ""
	if in.Password != nil && *in.Password != "" {
		password := *in.Password
		if length := len([]rune(password)); length < 12 || length > 256 {
			legacyTradeError(w, 400, "新密码需为 12～256 位")
			return
		}
		if !identity.PasswordPolicy(password, 12) {
			legacyTradeError(w, 400, "请勿使用常见弱密码")
			return
		}
		if newPassword, err = identity.HashPassword(password); err != nil {
			failure(w, err)
			return
		}
		changed = append(changed, "密码")
	}
	newName := ""
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		newName = legacyAdminClip(*in.Name, 20)
		changed = append(changed, "显示名")
	}
	var newCoins *int64
	if in.Coins != nil {
		coins := math.Floor(*in.Coins)
		if math.IsNaN(coins) || math.IsInf(coins, 0) || coins < 0 || coins > 1e12 {
			legacyTradeError(w, 400, "金币数无效")
			return
		}
		value := int64(coins)
		newCoins = &value
		changed = append(changed, "金币")
	}
	var newCap *int
	if len(in.ListingCap) > 0 {
		if string(in.ListingCap) == "null" {
			value := legacyListingCapDefault
			newCap = &value
			changed = append(changed, "挂单上限（恢复默认 40）")
		} else {
			var text string
			if json.Unmarshal(in.ListingCap, &text) == nil && strings.TrimSpace(text) == "" {
				value := legacyListingCapDefault
				newCap = &value
				changed = append(changed, "挂单上限（恢复默认 40）")
			} else {
				var number float64
				if json.Unmarshal(in.ListingCap, &number) != nil {
					legacyTradeError(w, 400, "挂单上限无效（0 = 不限，最大 10000）")
					return
				}
				value := math.Floor(number)
				if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > legacyListingCapMax {
					legacyTradeError(w, 400, "挂单上限无效（0 = 不限，最大 10000）")
					return
				}
				cap := int(value)
				newCap = &cap
				if cap == 0 {
					changed = append(changed, "挂单上限（不限）")
				} else {
					changed = append(changed, "挂单上限（"+strconv.Itoa(cap)+"）")
				}
			}
		}
	}
	if len(changed) == 0 {
		legacyTradeError(w, 400, "没有需要修改的字段")
		return
	}

	detail := strings.Join(changed, " / ")
	resultName := ""
	resultCoins := int64(0)
	resultCap := 0
	players := []int64{actor.AccountID}
	if targetID != actor.AccountID {
		players = append(players, targetID)
	}
	assetCtx := assets.WithSession(ctx, actor.AccountID, actor.Hash, true)
	_, err = assets.New(a.pool).Run(assetCtx, assets.Command{
		ActorID: actor.AccountID, RequestKey: legacyMarketKey("legacy:admin:users:update"), Kind: "admin_grant",
		RuleVersion: "legacy-admin-v1", Players: players, Input: detail,
	}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if newPassword != "" {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.identities SET password_hash=$2,legacy_salt='',updated_at=clock_timestamp() WHERE account_id=$1`, targetID, newPassword); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1`, targetID); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp() WHERE owner_id=$1`, targetID); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, targetID); err != nil {
				return assets.Result{}, err
			}
		}
		if newName != "" {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.identities SET display_name=$2,updated_at=clock_timestamp() WHERE account_id=$1`, targetID, newName); err != nil {
				return assets.Result{}, err
			}
		}
		if newCap != nil {
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.player_state SET listing_capacity=$2 WHERE account_id=$1`, targetID, *newCap); err != nil {
				return assets.Result{}, err
			}
		}
		if newCoins != nil {
			var current int64
			if err := t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, targetID).Scan(&current); err != nil {
				return assets.Result{}, err
			}
			if delta := *newCoins - current; delta != 0 {
				if err := t.Coins(ctx, targetID, delta); err != nil {
					return assets.Result{}, err
				}
			}
		}
		if err := t.SQL().QueryRow(ctx, `SELECT display_name FROM fishing.identities WHERE account_id=$1`, targetID).Scan(&resultName); err != nil {
			return assets.Result{}, err
		}
		if err := t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, targetID).Scan(&resultCoins); err != nil {
			return assets.Result{}, err
		}
		if err := t.SQL().QueryRow(ctx, `SELECT listing_capacity FROM fishing.player_state WHERE account_id=$1`, targetID).Scan(&resultCap); err != nil {
			return assets.Result{}, err
		}
		if err := legacyAdminAudit(ctx, t.SQL(), actor, "users/update", &targetID, target, detail); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "updated"}, nil
	})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, legacyTradeState{})
		return
	}
	write(w, 200, map[string]any{
		"ok": true, "target": target, "changed": changed, "name": resultName,
		"coins": resultCoins, "listingCap": resultCap, "capSet": false,
	})
}

func (a *API) legacyAdminUserBan(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token   string  `json:"token"`
		Target  string  `json:"target"`
		Hours   float64 `json:"hours"`
		Reason  string  `json:"reason"`
		Confirm bool    `json:"confirm"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	target := strings.ToLower(strings.TrimSpace(in.Target))
	targetID, exists, err := a.legacyAdminTarget(ctx, target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	if targetID == actor.AccountID {
		legacyTradeError(w, 400, "不能封禁自己的账号")
		return
	}
	hours := in.Hours
	if math.IsNaN(hours) || math.IsInf(hours, 0) {
		legacyTradeError(w, 400, "封禁时长无效")
		return
	}
	if math.Abs(hours) > legacyAdminBanMaxHours {
		legacyTradeError(w, 400, "封禁时长过大（上限 3650 天）")
		return
	}
	if !in.Confirm {
		legacyTradeError(w, 400, "需要二次确认")
		return
	}
	reason := legacyAdminClip(in.Reason, 60)
	detail := "hours=" + trimFloat(hours) + " reason=" + reason + " 已二次确认"

	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state := identity.BanState{}
	switch {
	case hours > 0:
		var until time.Time
		if err := tx.QueryRow(ctx, `UPDATE fishing.identities SET banned=true,ban_until=clock_timestamp()+($2::double precision*interval '1 hour'),
 ban_reason=$3,ban_by=$4,ban_at=clock_timestamp(),updated_at=clock_timestamp() WHERE account_id=$1 RETURNING ban_until`, targetID, hours, reason, actor.Name).Scan(&until); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err := a.legacyAdminKick(ctx, tx, targetID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		state = identity.BanStateOf(true, &until, reason, actor.Name, nil)
		state.By, state.Reason = actor.Name, reason
	case hours < 0:
		if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET banned=true,ban_until=NULL,ban_reason=$2,ban_by=$3,ban_at=clock_timestamp(),
 updated_at=clock_timestamp() WHERE account_id=$1`, targetID, reason, actor.Name); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err := a.legacyAdminKick(ctx, tx, targetID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		state = identity.BanStateOf(true, nil, reason, actor.Name, nil)
		state.By, state.Reason = actor.Name, reason
	default:
		if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET banned=false,ban_until=NULL,ban_reason='',ban_by='',ban_at=NULL,
 updated_at=clock_timestamp() WHERE account_id=$1`, targetID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
	}
	if err := legacyAdminAudit(ctx, tx, actor, "users/ban", &targetID, target, detail); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{
		"ok": true, "target": target, "banned": state.Banned, "permanent": state.Permanent,
		"until": state.Until, "remainMs": state.RemainMS, "reason": state.Reason,
	})
}

func (a *API) legacyAdminUserSetAdmin(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token  string `json:"token"`
		Target string `json:"target"`
		Admin  *bool  `json:"admin"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	target := strings.ToLower(strings.TrimSpace(in.Target))
	targetID, exists, err := a.legacyAdminTarget(ctx, target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	if in.Admin == nil {
		legacyTradeError(w, 400, "权限必须为布尔值")
		return
	}
	grant := *in.Admin
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	admins, err := a.legacyAdminAdminCount(ctx, tx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if !grant {
		if targetID == actor.AccountID {
			legacyTradeError(w, 400, "不能撤销自己的管理员权限")
			return
		}
		if admins <= 1 {
			legacyTradeError(w, 400, "不能撤销最后一位管理员")
			return
		}
		if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET admin=false,mfa_secret=NULL,mfa_last_step=-1,updated_at=clock_timestamp() WHERE account_id=$1`, targetID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin`, targetID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
	} else if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET admin=true,updated_at=clock_timestamp() WHERE account_id=$1`, targetID); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "users/setadmin", &targetID, target, "admin="+strconv.FormatBool(grant)+" 已二次确认"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "target": target, "admin": grant})
}

// legacyAdminUserTOTP mints a fresh authenticator secret for an administrator.
// The console route closes the gap the operator CLI left open: a newly
// authorized admin can be enrolled without shell access. The plaintext secret
// is returned exactly once; the audit row and the account list stay keyed to
// the account and never carry the credential.
func (a *API) legacyAdminUserTOTP(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token   string `json:"token"`
		Target  string `json:"target"`
		Confirm bool   `json:"confirm"`
		// Two-phase enrollment for the console: Stage "begin" only mints and
		// returns a secret (nothing is persisted), Stage "finish" writes it once
		// OTP from the new authenticator matches. Empty stage keeps the legacy
		// one-shot behaviour used by the operator flow and existing tests.
		Stage string `json:"stage"`
		OTP   string `json:"otp"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !in.Confirm {
		legacyTradeError(w, 400, "需要二次确认")
		return
	}
	ctx := r.Context()
	target := strings.ToLower(strings.TrimSpace(in.Target))
	targetID, exists, err := a.legacyAdminTarget(ctx, target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	// Two-phase console enrollment: the first call hands the administrator a
	// secret to scan but writes nothing, so a typing mistake can never lock the
	// account out. The secret is only committed once a code from the new
	// authenticator proves it was captured.
	if in.Stage == "begin" {
		var admin, banned bool
		if err := a.pool.QueryRow(ctx, `SELECT admin,banned FROM fishing.identities WHERE account_id=$1`, targetID).Scan(&admin, &banned); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if !admin {
			legacyTradeError(w, 400, "该账号不是管理员，请先打开「管理员」开关")
			return
		}
		if banned {
			legacyTradeError(w, 400, "该账号已被封禁，请先解封")
			return
		}
		pending, err := identity.NewMFASecret()
		if err != nil {
			failure(w, err)
			return
		}
		a.totpMu.Lock()
		if a.totpPending == nil {
			a.totpPending = make(map[int64]totpPendingEnrollment)
		}
		a.totpPending[targetID] = totpPendingEnrollment{secret: pending, expires: time.Now().Add(10 * time.Minute)}
		a.totpMu.Unlock()
		write(w, 200, map[string]any{
			"ok": true, "target": target, "secret": pending, "pending": true,
			"otpauthUrl": identity.MFAAuthURL(legacyAdminTOTPIssuer, target, pending),
		})
		return
	}
	var secret string
	if in.Stage == "finish" {
		a.totpMu.Lock()
		pending, ok := a.totpPending[targetID]
		if ok && time.Now().After(pending.expires) {
			ok = false
		}
		a.totpMu.Unlock()
		if !ok {
			legacyTradeError(w, 400, "密钥已过期，请重新生成")
			return
		}
		// A wrong code keeps the pending secret so the administrator can retry
		// without re-scanning; only success (below) consumes it.
		if !identity.VerifyMFA(pending.secret, in.OTP) {
			legacyTradeError(w, 400, "验证码不正确，请核对验证器后重试")
			return
		}
		secret = pending.secret
		a.totpMu.Lock()
		delete(a.totpPending, targetID)
		a.totpMu.Unlock()
	} else {
		secret, err = identity.NewMFASecret()
		if err != nil {
			failure(w, err)
			return
		}
	}
	sealed, err := a.identity.SealMFA(targetID, secret)
	if err != nil {
		failure(w, err)
		return
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, targetID); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	// The player guard serializes identity changes, so the eligibility check
	// belongs to the same transaction: a revocation racing this request must
	// not leave a secret behind. Reading the row after the guard keeps the lock
	// order used by Login and the operator CLI.
	var admin, banned bool
	if err := tx.QueryRow(ctx, `SELECT admin,banned FROM fishing.identities WHERE account_id=$1`, targetID).Scan(&admin, &banned); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if !admin {
		legacyTradeError(w, 400, "该账号不是管理员，请先打开「管理员」开关")
		return
	}
	if banned {
		legacyTradeError(w, 400, "该账号已被封禁，请先解封")
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET mfa_secret=$2,mfa_last_step=-1,updated_at=clock_timestamp() WHERE account_id=$1`, targetID, sealed); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	// The old authenticator stops working and every other console session is
	// revoked; rotating your own key keeps the session you are using. Gameplay
	// sessions and realtime streams are untouched: this rotates a console
	// credential, not the account's login state.
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin AND token_hash<>$2`, targetID, actor.Hash[:]); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "users/totp", &targetID, target, "已二次确认"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	payload := map[string]any{"ok": true, "target": target}
	if in.Stage != "finish" {
		// The plaintext secret is shown exactly once, on the call that mints it.
		payload["secret"] = secret
		payload["otpauthUrl"] = identity.MFAAuthURL(legacyAdminTOTPIssuer, target, secret)
	}
	write(w, 200, payload)
}

func (a *API) legacyAdminUserDelete(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token   string `json:"token"`
		Target  string `json:"target"`
		Confirm bool   `json:"confirm"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	target := strings.ToLower(strings.TrimSpace(in.Target))
	targetID, exists, err := a.legacyAdminTarget(ctx, target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	if targetID == actor.AccountID {
		legacyTradeError(w, 400, "不能删除自己的账号")
		return
	}
	if !in.Confirm {
		legacyTradeError(w, 400, "需要二次确认")
		return
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	password, err := identity.HashPassword(hex.EncodeToString(secret[:]))
	if err != nil {
		failure(w, err)
		return
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	admins, err := a.legacyAdminAdminCount(ctx, tx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	var isAdmin bool
	if err := tx.QueryRow(ctx, `SELECT admin FROM fishing.identities WHERE account_id=$1`, targetID).Scan(&isAdmin); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if isAdmin && admins <= 1 {
		legacyTradeError(w, 400, "不能删除最后一位管理员")
		return
	}
	var party string
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT party_id::text FROM fishing.party_members WHERE owner_id=$1 LIMIT 1),'')`, targetID).Scan(&party); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if party != "" {
		legacyTradeError(w, 400, "该账号正在编队中，请先解散或退出编队")
		return
	}
	var trade int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT id FROM fishing.trades WHERE (a_id=$1 OR b_id=$1) AND state IN ('invited','accepted') LIMIT 1),0)`, targetID).Scan(&trade); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if trade != 0 {
		legacyTradeError(w, 400, "该账号有进行中的交易，请先取消交易")
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET username='retired_'||account_id,retired=true,banned=true,ban_until=NULL,
 ban_reason='账号已注销',ban_by=$2,ban_at=clock_timestamp(),password_hash=$3,legacy_salt='',admin=false,
 mfa_secret=NULL,mfa_last_step=-1,updated_at=clock_timestamp() WHERE account_id=$1`, targetID, actor.Name, password); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := a.legacyAdminKick(ctx, tx, targetID); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminAudit(ctx, tx, actor, "users/delete", &targetID, target, "已二次确认"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "target": target})
}

func trimFloat(v float64) string {
	if v == math.Trunc(v) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', 2, 64)
}
