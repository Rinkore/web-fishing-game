package gateway

import (
	"net/http"
	"strings"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/breeding"
)

var breedingSuccess = map[string]bool{
	"founder_added":  true,
	"offspring_born": true,
	"released":       true,
}

func (a *API) breedingView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	view, err := breeding.New(a.pool).View(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "breeding": view})
}

func (a *API) breedingAction(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in breeding.Command
	if !decode(w, r, &in) {
		return
	}
	if len(in.RequestKey) < 8 || len(in.RequestKey) > 100 || strings.Contains(in.RequestKey, ":") {
		write(w, http.StatusBadRequest, map[string]any{"error": "invalid_request_key"})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	result, err := breeding.New(a.pool).Apply(ctx, session.AccountID, in)
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	if !breedingSuccess[result.Status] {
		write(w, http.StatusConflict, map[string]any{"error": result.Status})
		return
	}
	view, err := breeding.New(a.pool).View(r.Context(), session.AccountID)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "breeding": view, "result": result})
}
