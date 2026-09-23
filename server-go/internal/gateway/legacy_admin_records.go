package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Moderation changes the public projections, never the immutable catch ledger,
// inventory or personal codex. A repeatable snapshot makes the selected rank,
// hidden candidates, audit and response describe the same committed operation.
func (a *API) legacyRecordsTx(ctx context.Context, actor identity.Session) (pgx.Tx, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, err
	}
	fail := func(err error) (pgx.Tx, error) {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	// Updating the guard serializes all moderation, including disjoint rows.
	// PostgreSQL rejects a waiter with a stale repeatable-read snapshot before
	// it checks ranks, so a concurrent removal cannot shift an unchecked index.
	if _, err = tx.Exec(ctx, `UPDATE fishing.catch_record_moderation_guard SET revision=revision+1 WHERE singleton`); err != nil {
		return fail(err)
	}
	var id int64
	err = tx.QueryRow(ctx, `SELECT i.account_id FROM fishing.identities i JOIN fishing.auth_sessions s ON s.account_id=i.account_id
 WHERE i.account_id=$1 AND i.admin AND NOT i.banned AND NOT i.retired AND s.token_hash=$2 AND s.admin AND s.expires_at>clock_timestamp()
 FOR SHARE OF i,s`, actor.AccountID, actor.Hash[:]).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return fail(identity.ErrCredentials)
	}
	if err != nil {
		return fail(err)
	}
	return tx, nil
}

func legacyRecordsFailure(w http.ResponseWriter, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "40001" {
		legacyTradeError(w, 409, "纪录已变化，请刷新后重试")
		return
	}
	failure(w, err)
}

func (a *API) legacyAdminRecordsDelete(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in *struct {
		Token string `json:"token"`
		ID    string `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in == nil {
		failure(w, identity.ErrInvalid)
		return
	}
	ctx := r.Context()
	c, err := a.catalog(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	if it, ok := c.Item(in.ID); in.ID != "" && (!ok || it.Kind != "fish") {
		legacyTradeError(w, 400, "未知鱼类："+in.ID)
		return
	}
	tx, err := a.legacyRecordsTx(ctx, actor)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now()
	before, err := a.legacyRecordsProjection(ctx, tx, c)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	removed := map[string]int{"big": 0, "small": 0, "top": 0, "topSmall": 0, "rank": 0}
	for _, it := range c.Items {
		if it.Kind != "fish" || (in.ID != "" && in.ID != it.ID) {
			continue
		}
		for _, kind := range []string{"big", "small"} {
			key := "records"
			if kind == "small" {
				key = "small"
			}
			if _, found := before[key].(map[string]legacyRecordEntry)[it.ID]; found {
				removed[kind]++
			}
		}
		for _, scope := range []string{"day", "week", "all"} {
			hasRank := false
			for _, small := range []bool{false, true} {
				top, err := legacyRankList(ctx, tx, it.ID, small, scope, a.location, now)
				if err != nil {
					legacyRecordsFailure(w, err)
					return
				}
				if len(top) > 0 {
					hasRank = true
					if scope == "all" {
						key := "top"
						if small {
							key = "topSmall"
						}
						removed[key]++
					}
				}
			}
			if scope != "all" && hasRank {
				removed["rank"]++
			}
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id)
 SELECT cr.operation_id,cr.ordinal,cr.item_id,r,k,$2 FROM fishing.catch_records cr
 CROSS JOIN unnest(ARRAY['day','week','all','record']) r CROSS JOIN unnest(ARRAY['big','small']) k
 WHERE ($1='' OR cr.item_id=$1) ON CONFLICT DO NOTHING`, in.ID, actor.AccountID)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = clearLegacyLastRecord(ctx, tx, in.ID); err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = removeImportedRecords(ctx, tx, in.ID, nil, "", "", true, a.location, now); err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	value, err := a.legacyRecordsProjection(ctx, tx, c)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = legacyAdminAudit(ctx, tx, actor, "records/delete", nil, in.ID, fmt.Sprintf("removed=%v", removed)); err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	value["ok"], value["removed"] = true, removed
	value["id"] = nil
	if in.ID != "" {
		value["id"] = in.ID
	}
	write(w, 200, value)
}

func clearLegacyLastRecord(ctx context.Context, q legacyRecordQueryer, id string) error {
	var raw []byte
	if err := q.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1 FOR UPDATE`, legacyRecordsRuntime).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	var state struct {
		LastRec struct {
			ID string `json:"id"`
		} `json:"lastRec"`
	}
	if json.Unmarshal(raw, &state) != nil || state.LastRec.ID == "" || id != "" && state.LastRec.ID != id {
		return nil
	}
	_, err := q.Exec(ctx, `UPDATE fishing.operator_settings SET value='{"lastRec":null}'::jsonb,updated_at=clock_timestamp() WHERE key=$1`, legacyRecordsRuntime)
	return err
}

func (a *API) legacyAdminRecordDeleteOne(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Token string          `json:"token"`
		ID    string          `json:"id"`
		Range string          `json:"range"`
		Kind  string          `json:"kind"`
		Index *int            `json:"index"`
		Who   *string         `json:"who"`
		Size  *float64        `json:"size"`
		T     *int64          `json:"t"`
		Purge json.RawMessage `json:"purge"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	c, err := a.catalog(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	if it, ok := c.Item(in.ID); !ok || it.Kind != "fish" {
		legacyTradeError(w, 400, "未知鱼类："+in.ID)
		return
	}
	if (in.Range != "day" && in.Range != "week" && in.Range != "all") || (in.Kind != "big" && in.Kind != "small") ||
		in.Index == nil || *in.Index < 0 || *in.Index >= 10 || in.Who == nil || in.Size == nil || in.T == nil ||
		*in.Who == "" || *in.Size <= 0 || math.IsNaN(*in.Size) || math.IsInf(*in.Size, 0) || *in.T < 0 {
		failure(w, identity.ErrInvalid)
		return
	}
	purge := false
	if len(in.Purge) > 0 {
		switch string(in.Purge) {
		case "true", "1":
			purge = true
		case "false", "0", "null":
		default:
			failure(w, identity.ErrInvalid)
			return
		}
	}
	tx, err := a.legacyRecordsTx(ctx, actor)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now()
	top, err := legacyRankList(ctx, tx, in.ID, in.Kind == "small", in.Range, a.location, now)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if *in.Index >= len(top) {
		legacyTradeError(w, 409, "名次已变化，请刷新后重试")
		return
	}
	cur := top[*in.Index]
	if cur.Who != *in.Who || cur.Size != *in.Size || cur.T != *in.T {
		legacyTradeError(w, 409, "该条已被更新，请刷新后重试")
		return
	}
	var purged map[string]int
	if purge {
		purged, err = a.legacyRecordPurgeCounts(ctx, tx, c, in.ID, cur, now)
		if err == nil {
			// Identity is the account, not its mutable/non-unique display name.
			_, err = tx.Exec(ctx, `INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id)
 SELECT cr.operation_id,cr.ordinal,cr.item_id,r,k,$4 FROM fishing.catch_records cr
 CROSS JOIN unnest(ARRAY['day','week','all','record']) r CROSS JOIN unnest(ARRAY['big','small']) k
 WHERE cr.item_id=$1 AND cr.owner_id=$2 AND cr.size=$3 ON CONFLICT DO NOTHING`, in.ID, cur.OwnerID, cur.Size, actor.AccountID)
		}
		if purged != nil {
			purged["boards"]-- // The selected entry is already reported as removed.
		}
	}
	if err == nil {
		// Remove the player's existing candidates from this board, so an older
		// inferior catch cannot immediately reappear as the deleted rank.
		from, until := legacyRankWindow(in.Range, a.location, now)
		_, err = tx.Exec(ctx, `INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id)
 SELECT operation_id,ordinal,item_id,$3,$4,$5 FROM fishing.catch_records
 WHERE item_id=$1 AND owner_id=$2 AND ($6::timestamptz IS NULL OR (caught_at>=$6 AND caught_at<$7)) ON CONFLICT DO NOTHING`,
			in.ID, cur.OwnerID, in.Range, in.Kind, actor.AccountID, from, until)
	}
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = removeImportedRecords(ctx, tx, in.ID, &cur, in.Range, in.Kind, purge, a.location, now); err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	top, err = legacyRankList(ctx, tx, in.ID, in.Kind == "small", in.Range, a.location, now)
	if err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	var auditOwner *int64
	if cur.OwnerID > 0 {
		auditOwner = &cur.OwnerID
	}
	if err = legacyAdminAudit(ctx, tx, actor, "records/delone", auditOwner, in.ID,
		fmt.Sprintf("range=%s kind=%s index=%d size=%g t=%d purge=%t catch=%d/%d", in.Range, in.Kind, *in.Index, cur.Size, cur.T, purge, cur.OperationID, cur.Ordinal)); err != nil {
		legacyRecordsFailure(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	label := rankLabelOf(in.Range, a.location, now) + " · 最大"
	if in.Kind == "small" {
		label = rankLabelOf(in.Range, a.location, now) + " · 最小"
	}
	write(w, 200, map[string]any{"ok": true, "id": in.ID, "range": in.Range, "kind": in.Kind, "label": label, "removed": cur, "purge": purged, "top": top})
}

func (a *API) legacyRecordPurgeCounts(ctx context.Context, q legacyRecordQueryer, c *rules.Catalog, id string, cur legacyTopEntry, now time.Time) (map[string]int, error) {
	counts := map[string]int{"boards": 0, "big": 0, "small": 0}
	for _, scope := range []string{"day", "week", "all"} {
		for _, small := range []bool{false, true} {
			top, err := legacyRankList(ctx, q, id, small, scope, a.location, now)
			if err != nil {
				return nil, err
			}
			for _, entry := range top {
				if legacyRankIdentity(entry) == legacyRankIdentity(cur) && entry.Size == cur.Size {
					counts["boards"]++
				}
			}
		}
	}
	value, err := a.legacyRecordsProjection(ctx, q, c)
	if err != nil {
		return nil, err
	}
	for _, kind := range []string{"big", "small"} {
		key := kind
		if kind == "big" {
			key = "records"
		}
		if entry, ok := value[key].(map[string]legacyRecordEntry)[id]; ok && (entry.OwnerID > 0 && entry.OwnerID == cur.OwnerID || entry.OwnerID == 0 && entry.Who == cur.Who) && entry.Size == cur.Size {
			counts[kind]++
		}
	}
	return counts, nil
}
