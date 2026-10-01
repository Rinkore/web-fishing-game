package gateway

import (
	"net/http"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
)

func (a *API) chest(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		UnboundInputs bool   `json:"unboundInputs"`
		RequestKey    string `json:"requestKey"`
		Action        string `json:"action"`
		ChestID       string `json:"chestId"`
		Part          string `json:"part"`
		BaseID        string `json:"baseId"`
		Quantity      int64  `json:"quantity"`
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
	res, err := workshop.New(a.pool, c).Chest(ctx, workshop.ChestCommand{UnboundInputs: in.UnboundInputs, ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, ChestID: in.ChestID, Part: in.Part, BaseID: in.BaseID, Quantity: in.Quantity})
	assetResponse(w, res, err)
}
