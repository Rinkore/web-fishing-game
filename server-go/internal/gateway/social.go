package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/social"
	"net/http"
	"strconv"
)

func (a *API) friendChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		Action     string `json:"action"`
		TargetID   int64  `json:"targetId,string"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := social.New(a.pool).Friend(ctx, social.FriendCommand{ActorID: session.AccountID, TargetID: in.TargetID, Action: in.Action, RequestKey: in.RequestKey})
	assetResponse(w, res, err)
}
func (a *API) friends(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	after, limit, ok := pagination(r)
	if !ok {
		failure(w, identity.ErrInvalid)
		return
	}
	list, err := social.New(a.pool).Relations(r.Context(), session.AccountID, after, limit)
	if err != nil {
		failure(w, err)
		return
	}
	next := ""
	if len(list) == limit {
		next = strconv.FormatInt(list[len(list)-1].ID, 10)
	}
	write(w, 200, map[string]any{"items": list, "nextAfter": next})
}
