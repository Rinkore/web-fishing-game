package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/operations"
	"net/http"
)

func (a *API) features(w http.ResponseWriter, r *http.Request) {
	v, err := operations.New(a.pool).Features(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, v)
}
func (a *API) publishFeatures(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		RequestKey       string          `json:"requestKey"`
		ExpectedRevision int64           `json:"expectedRevision,string"`
		Flags            map[string]bool `json:"flags"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, true)
	res, err := operations.New(a.pool).Publish(ctx, operations.Publish{ActorID: session.AccountID, RequestKey: in.RequestKey, ExpectedRevision: in.ExpectedRevision, Flags: in.Flags})
	assetResponse(w, res, err)
}
