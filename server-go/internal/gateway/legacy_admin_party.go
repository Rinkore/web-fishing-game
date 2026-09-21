package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/social"
	"github.com/jackc/pgx/v5"
)

func (a *API) legacyAdminParties(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT p.id,p.revision,lower(leader.username),leader.display_name,lower(i.username),i.display_name,
 EXISTS(SELECT 1 FROM fishing.gateway_streams g WHERE g.owner_id=m.owner_id AND g.expires_at>statement_timestamp())
 FROM fishing.parties p JOIN fishing.identities leader ON leader.account_id=p.leader_id
 JOIN fishing.party_members m ON m.party_id=p.id JOIN fishing.identities i ON i.account_id=m.owner_id
 WHERE p.active ORDER BY p.id,m.joined_revision,m.owner_id`)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	var last int64
	for rows.Next() {
		var id, revision int64
		var leader, leaderName, key, name string
		var online bool
		if err := rows.Scan(&id, &revision, &leader, &leaderName, &key, &name, &online); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if id != last {
			list = append(list, map[string]any{"id": id, "revision": revision, "leader": leader, "leaderName": leaderName, "members": []map[string]any{}, "max": 4})
			last = id
		}
		party := list[len(list)-1]
		party["members"] = append(party["members"].([]map[string]any), map[string]any{"id": key, "name": name, "online": online})
	}
	if rows.Err() != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "parties": list, "total": len(list)})
}

func (a *API) legacyAdminPartyDisband(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		ID               json.RawMessage `json:"id"`
		ExpectedRevision *int64          `json:"expectedRevision"`
	}
	if !decode(w, r, &in) {
		return
	}
	var id int64
	if json.Unmarshal(in.ID, &id) != nil {
		var text string
		if json.Unmarshal(in.ID, &text) == nil {
			id, _ = strconv.ParseInt(text, 10, 64)
		}
	}
	if id < 1 {
		legacyTradeError(w, 400, "无效的编队编号")
		return
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := social.New(a.pool).AdminDisband(ctx, actor.AccountID, id, legacyMarketKey("legacy:admin-party"), in.ExpectedRevision)
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	switch result.Status {
	case "disbanded":
		write(w, 200, map[string]any{"ok": true})
	case "party_missing":
		legacyTradeError(w, 404, "队伍不存在（可能已解散）")
	case "party_revision_changed":
		legacyTradeError(w, 409, result.Status)
	default:
		legacyTradeError(w, 400, result.Status)
	}
}
