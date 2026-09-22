package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/mall"
	"net/http"
)

func (a *API) mallBuy(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		ItemID     string `json:"itemId"`
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
	res, err := mall.New(a.pool, c, a.location).Buy(ctx, mall.Purchase{ActorID: session.AccountID, RequestKey: in.RequestKey, ItemID: in.ItemID, Quantity: in.Quantity})
	assetResponse(w, res, err)
}
func (a *API) mallView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	view, err := mall.New(a.pool, c, a.location).View(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, view)
}
