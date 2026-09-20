package gateway

import (
	"fishing.local/server/internal/modules/identity"
	"net/http"
	"strconv"
	"time"
)

func (a *API) codex(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	after := r.URL.Query().Get("after")
	limit := 50
	if len(after) > 128 {
		failure(w, identity.ErrInvalid)
		return
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			failure(w, identity.ErrInvalid)
			return
		}
		limit = n
	}
	rows, err := a.pool.Query(r.Context(), `SELECT item_id,count,first_at FROM fishing.player_codex WHERE owner_id=$1 AND item_id>$2 ORDER BY item_id LIMIT $3`, session.AccountID, after, limit+1)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	next := ""
	for rows.Next() {
		var id string
		var count int64
		var first time.Time
		if rows.Scan(&id, &count, &first) != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if len(items) == limit {
			next = items[len(items)-1]["id"].(string)
			break
		}
		items = append(items, map[string]any{"id": id, "count": count, "firstAt": first.UnixMilli()})
	}
	if rows.Err() != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"items": items, "nextAfter": next})
}
