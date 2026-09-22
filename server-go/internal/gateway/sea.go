package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/sea"
	"net/http"
)

func (a *API) seaView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	v, err := sea.New(a.pool, c, a.location).Overview(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, v)
}
func (a *API) quests(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := sea.New(a.pool, c, a.location).QuestRefresh(ctx, session.AccountID, in.RequestKey)
	assetResponse(w, res, err)
}
func (a *API) questClaim(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		ID         string `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := sea.New(a.pool, c, a.location).QuestClaim(ctx, session.AccountID, in.RequestKey, in.ID)
	assetResponse(w, res, err)
}
func (a *API) voyage(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := sea.New(a.pool, c, a.location).Voyage(ctx, session.AccountID, in.RequestKey)
	assetResponse(w, res, err)
}
func (a *API) anchor(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		ZoneID     string `json:"zoneId"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := sea.New(a.pool, c, a.location).Anchor(ctx, session.AccountID, in.RequestKey, in.ZoneID)
	assetResponse(w, res, err)
}
func (a *API) seaChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey    string `json:"requestKey"`
		Action        string `json:"action"`
		ExpectedLevel int    `json:"expectedLevel"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := sea.New(a.pool, c, a.location).Apply(ctx, sea.Command{ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, ExpectedLevel: in.ExpectedLevel})
	assetResponse(w, res, err)
}
