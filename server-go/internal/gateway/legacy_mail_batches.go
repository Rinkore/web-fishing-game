package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/mail"
	"fishing.local/server/internal/rules"
)

// Extend the established mail endpoint; authentication, catalog lookup and
// command error handling stay shared with individual mail delivery.
func (a *API) adminMailQuery(w http.ResponseWriter, r *http.Request, c *rules.Catalog) bool {
	service := mail.New(a.pool, c)
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	switch q.Get("view") {
	case "recipients":
		var filter mail.Audience
		if json.Unmarshal([]byte(q.Get("audience")), &filter) != nil {
			write(w, 400, map[string]any{"error": "invalid_input"})
			return true
		}
		out, err := service.Search(r.Context(), filter, page)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
		} else {
			write(w, 200, out)
		}
	case "batches":
		out, err := service.Batches(r.Context(), q.Get("q"), q.Get("status"), page)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
		} else {
			write(w, 200, map[string]any{"items": out})
		}
	case "batch-recipients":
		id, _ := strconv.ParseInt(q.Get("id"), 10, 64)
		if id <= 0 {
			write(w, 400, map[string]any{"error": "invalid_input"})
			return true
		}
		out, err := service.BatchRecipients(r.Context(), id, page, q.Get("state"))
		if err != nil {
			assetResponse(w, assets.Result{}, err)
		} else {
			write(w, 200, map[string]any{"items": out})
		}
	default:
		return false
	}
	return true
}

func (a *API) adminMailBatch(w http.ResponseWriter, r *http.Request, c *rules.Catalog, actor identity.Session) {
	var in struct {
		mail.BatchCommand
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := mail.New(a.pool, c).BatchChange(ctx, actor.AccountID, actor.Name, in.RequestKey, in.BatchCommand)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if result.Status != in.Action {
		write(w, 400, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true, "result": result})
}

func (a *API) legacyMailClaimAll(w http.ResponseWriter, r *http.Request, c *rules.Catalog, session identity.Session, key, after string) {
	if len(key) < 1 || len(key) > 80 {
		write(w, 400, map[string]any{"error": "invalid_input"})
		return
	}
	cursor, _ := strconv.ParseInt(after, 10, 64)
	rows, err := a.pool.Query(r.Context(), `SELECT id FROM fishing.mail_messages m WHERE recipient_id=$1 AND id>$2 AND claimed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM fishing.mail_attachments a WHERE a.mail_id=m.id) ORDER BY id LIMIT 51`, session.AccountID, cursor)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	more := len(ids) > 50
	if more {
		ids = ids[:50]
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	claimed := 0
	failed := []map[string]string{}
	for _, id := range ids {
		v, claimErr := mail.New(a.pool, c).Change(ctx, session.AccountID, key+":"+strconv.FormatInt(id, 10), id, true)
		if claimErr != nil {
			failed = append(failed, map[string]string{"id": strconv.FormatInt(id, 10), "error": "retry_same_request"})
		} else if v.Status != "claimed" {
			failed = append(failed, map[string]string{"id": strconv.FormatInt(id, 10), "error": v.Status})
		} else {
			claimed++
		}
		cursor = id
	}
	write(w, 200, map[string]any{"ok": true, "claimed": claimed, "failed": failed, "more": more, "afterId": strconv.FormatInt(cursor, 10)})
}
