package gateway

import (
	"errors"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/trade"
)

func assetResponse(w http.ResponseWriter, result assets.Result, err error) {
	if err != nil {
		var rejection assets.Rejection
		switch {
		case errors.Is(err, assets.ErrInvalid):
			failure(w, identity.ErrInvalid)
		case errors.Is(err, assets.ErrUnauthenticated):
			failure(w, identity.ErrCredentials)
		case errors.Is(err, assets.ErrKeyConflict):
			write(w, 409, map[string]any{"error": "request_key_conflict"})
		case errors.As(err, &rejection):
			write(w, 409, map[string]any{"error": string(rejection)})
		default:
			write(w, 503, map[string]any{"error": "retry_same_request"})
		}
		return
	}
	write(w, 200, result)
}
func (a *API) presence(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Action     string `json:"action"`
		Generation int64  `json:"generation,string"`
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := fishing.New(a.pool).Connection(ctx, fishing.Connection{ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, Generation: in.Generation})
	assetResponse(w, res, err)
}
func (a *API) invite(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		TargetID   int64  `json:"targetId,string"`
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Invite(ctx, trade.Invite{ActorID: session.AccountID, TargetID: in.TargetID, RequestKey: in.RequestKey})
	assetResponse(w, res, err)
}
func (a *API) tradeChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ID         int64         `json:"tradeId,string"`
		Revision   int64         `json:"revision,string"`
		Action     string        `json:"action"`
		Accept     bool          `json:"accept"`
		RequestKey string        `json:"requestKey"`
		Stacks     []trade.Stack `json:"stacks"`
		Equipment  []string      `json:"equipment"`
	}
	if !decode(w, r, &in) {
		return
	}
	ids := []int64{}
	for _, s := range in.Equipment {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil || id < 1 {
			failure(w, identity.ErrInvalid)
			return
		}
		ids = append(ids, id)
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: in.ID, Revision: in.Revision, RequestKey: in.RequestKey, Action: in.Action, Accept: in.Accept, Offer: trade.Offer{Stacks: in.Stacks, Equipment: ids}})
	assetResponse(w, res, err)
}
func (a *API) tradeView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil || id < 1 {
		failure(w, identity.ErrInvalid)
		return
	}
	v, err := trade.New(a.pool).View(r.Context(), id, session.AccountID)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	offer := func(o trade.Offer) map[string]any {
		ids := []string{}
		for _, id := range o.Equipment {
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		return map[string]any{"stacks": o.Stacks, "equipment": ids}
	}
	write(w, 200, map[string]any{"id": strconv.FormatInt(v.ID, 10), "a": strconv.FormatInt(v.AID, 10), "b": strconv.FormatInt(v.BID, 10), "state": v.State, "revision": strconv.FormatInt(v.Revision, 10), "aOffer": offer(v.AOffer), "bOffer": offer(v.BOffer), "aConfirm": v.AConfirm, "bConfirm": v.BConfirm, "cooldownUntil": v.CooldownUntil, "expiresAt": v.ExpiresAt})
}
