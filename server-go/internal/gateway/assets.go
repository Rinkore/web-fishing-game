package gateway

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/identity"
	"github.com/jackc/pgx/v5"
)

type assetCursor struct {
	Revision int64  `json:"rev,string"`
	Kind     string `json:"kind"`
	Item     string `json:"item"`
	Tier     string `json:"tier"`
	ID       int64  `json:"id,string"`
}

func (a *API) assets(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "stacks"
	}
	if kind != "stacks" && kind != "equipment" {
		failure(w, identity.ErrInvalid)
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		var err error
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			failure(w, identity.ErrInvalid)
			return
		}
	}
	cursor := assetCursor{Kind: kind}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || len(data) > 512 || json.Unmarshal(data, &cursor) != nil || cursor.Kind != kind || cursor.Revision < 0 || cursor.ID < 0 {
			failure(w, identity.ErrInvalid)
			return
		}
	}
	ctx, cancel := timeout(r)
	defer cancel()
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, session.AccountID).Scan(&revision); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if r.URL.Query().Get("cursor") != "" && cursor.Revision != revision {
		write(w, 409, map[string]any{"error": "assets_changed", "assetsRev": strconv.FormatInt(revision, 10)})
		return
	}
	cursor.Revision = revision
	items := []map[string]any{}
	var next *assetCursor
	if kind == "stacks" {
		rows, err := tx.Query(ctx, `SELECT item_id,tier,quantity,kind FROM fishing.inventory_stacks WHERE owner_id=$1 AND quantity>0 AND (item_id,tier)>($2,$3) ORDER BY item_id,tier LIMIT $4`, session.AccountID, cursor.Item, cursor.Tier, limit+1)
		if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id, tier, k string
			var q int64
			if rows.Scan(&id, &tier, &q, &k) != nil {
				failure(w, identity.ErrStorage)
				return
			}
			if len(items) == limit {
				copy := cursor
				next = &copy
				break
			}
			items = append(items, map[string]any{"id": id, "tier": tier, "kind": k, "quantity": q})
			cursor.Item = id
			cursor.Tier = tier
		}
		if rows.Err() != nil {
			failure(w, identity.ErrStorage)
			return
		}
		rows.Close()
	} else {
		rows, err := tx.Query(ctx, `SELECT id,definition_id,part,attributes,lifecycle FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle<>'consumed' AND id>$2 ORDER BY id LIMIT $3`, session.AccountID, cursor.ID, limit+1)
		if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var def, part, state string
			var attrs json.RawMessage
			if rows.Scan(&id, &def, &part, &attrs, &state) != nil {
				failure(w, identity.ErrStorage)
				return
			}
			if len(items) == limit {
				copy := cursor
				next = &copy
				break
			}
			items = append(items, map[string]any{"id": strconv.FormatInt(id, 10), "definitionId": def, "part": part, "attributes": attrs, "state": state})
			cursor.ID = id
		}
		if rows.Err() != nil {
			failure(w, identity.ErrStorage)
			return
		}
		rows.Close()
	}
	nextToken := ""
	if next != nil {
		b, _ := json.Marshal(next)
		nextToken = base64.RawURLEncoding.EncodeToString(b)
	}
	write(w, 200, map[string]any{"items": items, "assetsRev": strconv.FormatInt(revision, 10), "nextCursor": nextToken})
}
