package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/identity"
	"net/http"
)

func (a *API) sell(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		ItemID     string `json:"itemId"`
		Tier       string `json:"tier"`
		Quantity   int64  `json:"quantity"`
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
	res, err := economy.New(a.pool, c).Sell(ctx, economy.Sell{ActorID: session.AccountID, RequestKey: in.RequestKey, ItemID: in.ItemID, Tier: in.Tier, Quantity: in.Quantity})
	assetResponse(w, res, err)
}
func (a *API) autosellConfigure(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string           `json:"requestKey"`
		Settings   economy.Settings `json:"settings"`
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
	res, err := economy.New(a.pool, c).Configure(ctx, session.AccountID, in.RequestKey, in.Settings)
	assetResponse(w, res, err)
}
func (a *API) autosellRun(w http.ResponseWriter, r *http.Request) {
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
	res, err := economy.New(a.pool, c).AutoSell(ctx, session.AccountID, in.RequestKey)
	assetResponse(w, res, err)
}
func (a *API) shopPrices(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	prices, err := economy.New(a.pool, c).Prices(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"items": prices})
}
func (a *API) autosellSettings(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	cfg, err := economy.New(a.pool, c).Settings(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, cfg)
}
func (a *API) sellEquipment(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey  string `json:"requestKey"`
		EquipmentID int64  `json:"equipmentId,string"`
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
	res, err := economy.New(a.pool, c).SellEquipment(ctx, session.AccountID, in.EquipmentID, in.RequestKey)
	assetResponse(w, res, err)
}
