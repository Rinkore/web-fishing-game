package gateway

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/identity"
)

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	last := int64(0)
	raw := r.Header.Get("Last-Event-ID")
	if raw != "" {
		var err error
		last, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || last < 0 {
			failure(w, identity.ErrInvalid)
			return
		}
	}
	var current int64
	if err := a.pool.QueryRow(r.Context(), `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, session.AccountID).Scan(&current); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if last > current {
		failure(w, identity.ErrInvalid)
		return
	}
	select {
	case a.streams <- struct{}{}:
		defer func() { <-a.streams }()
	default:
		failure(w, identity.ErrBusy)
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(text string) bool {
		if controller.SetWriteDeadline(time.Now().Add(2*time.Second)) != nil {
			return false
		}
		if _, err := fmt.Fprint(w, text); err != nil {
			return false
		}
		if controller.Flush() != nil {
			return false
		}
		a.sseMsgs.Add(1)
		a.sseWrites.Add(1)
		a.sseBytes.Add(int64(len(text)))
		return true
	}
	if raw == "" {
		last = current
		if !send(fmt.Sprintf("id: %d\ndata: {\"type\":\"snapshot_required\",\"assetsRev\":\"%d\"}\n\n", last, last)) {
			return
		}
	}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		if _, err := a.identity.Authenticate(r.Context(), token(r, false), false); err != nil {
			_ = send("data: {\"type\":\"kicked\"}\n\n")
			return
		}
		rows, err := a.pool.Query(r.Context(), `SELECT revision FROM fishing.player_events WHERE owner_id=$1 AND revision>$2 ORDER BY revision LIMIT 100`, session.AccountID, last)
		if err != nil {
			return
		}
		revisions := []int64{}
		for rows.Next() {
			var v int64
			if rows.Scan(&v) != nil {
				rows.Close()
				return
			}
			revisions = append(revisions, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return
		}
		for _, revision := range revisions {
			if !send(fmt.Sprintf("id: %d\ndata: {\"type\":\"assets_changed\",\"assetsRev\":\"%d\"}\n\n", revision, revision)) {
				return
			}
			last = revision
		}
		if len(revisions) == 100 {
			continue
		}
		if !send(": heartbeat\n\n") {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}
