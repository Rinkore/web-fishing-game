package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/social"
	"net/http"
	"strconv"
)

func (a *API) partyView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	v, err := social.New(a.pool).PartyView(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, v)
}
func (a *API) partyChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		Action     string `json:"action"`
		TargetID   int64  `json:"targetId,string"`
		PartyID    int64  `json:"partyId,string"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := social.New(a.pool).Party(ctx, social.PartyCommand{ActorID: session.AccountID, TargetID: in.TargetID, PartyID: in.PartyID, RequestKey: in.RequestKey, Action: in.Action})
	assetResponse(w, res, err)
}
func (a *API) partyEvents(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	after, limit, ok := pagination(r)
	if !ok {
		failure(w, identity.ErrInvalid)
		return
	}
	rows, err := a.pool.Query(r.Context(), `SELECT revision,action FROM fishing.party_events WHERE $1=ANY(recipients) AND revision>$2 ORDER BY revision LIMIT $3`, session.AccountID, after, limit)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	next := strconv.FormatInt(after, 10)
	for rows.Next() {
		var revision int64
		var action string
		if rows.Scan(&revision, &action) != nil {
			failure(w, identity.ErrStorage)
			return
		}
		next = strconv.FormatInt(revision, 10)
		list = append(list, map[string]any{"revision": next, "action": action})
	}
	if rows.Err() != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"items": list, "nextAfter": next})
}
