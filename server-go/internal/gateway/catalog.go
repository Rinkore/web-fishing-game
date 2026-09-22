package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

func (a *API) catalog(ctx context.Context) (*rules.Catalog, error) {
	c, _, e := catalog.Effective(ctx, a.pool)
	return c, e
}
func (a *API) catalogView(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, id, e := catalog.Current(r.Context(), a.pool)
	if e != nil {
		failure(w, e)
		return
	}
	write(w, 200, map[string]any{"revision": id, "catalog": c})
}
func (a *API) catalogPublish(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		RequestKey       string          `json:"requestKey"`
		ExpectedRevision int64           `json:"expectedRevision"`
		Catalog          json.RawMessage `json:"catalog"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, (1<<20)+4096))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		failure(w, identity.ErrInvalid)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, true)
	res, e := catalog.PublishConfig(ctx, a.pool, catalog.Publish{ActorID: session.AccountID, RequestKey: in.RequestKey, ExpectedRevision: in.ExpectedRevision, Catalog: in.Catalog})
	assetResponse(w, res, e)
}
