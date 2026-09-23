package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/sea"
	"net/http"
	"strconv"
)

// Every command uses the client's stable request key; ambiguous transport
// failures can be retried without spending another ticket or choice.
func (a *API) legacyExpedition(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := a.authorize(w, r, false)
		if !ok {
			return
		}
		var in struct {
			Target     string `json:"target"`
			RequestKey string `json:"requestKey"`
			Route      string `json:"route"`
			Hours      int    `json:"hours"`
			ID         string `json:"id"`
			Set        string `json:"set"`
			Part       string `json:"part"`
			Starter    bool   `json:"starter"`
		}
		if !decode(w, r, &in) {
			return
		}
		if len(in.RequestKey) < 8 || len(in.RequestKey) > 100 {
			write(w, 400, map[string]any{"error": "invalid_request_key"})
			return
		}
		c, err := a.catalog(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		svc := sea.New(a.pool, c, a.location)
		ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
		var result assets.Result
		switch action {
		case "target":
			result, err = svc.SelectTarget(ctx, session.AccountID, in.RequestKey, in.Target)
		case "start":
			result, err = svc.StartExpedition(ctx, session.AccountID, in.RequestKey, in.Route, in.Hours)
		case "claim":
			id, _ := strconv.ParseInt(in.ID, 10, 64)
			result, err = svc.ClaimExpedition(ctx, session.AccountID, in.RequestKey, id)
		case "redeem":
			result, err = svc.RedeemSet(ctx, session.AccountID, in.RequestKey, in.Set, in.Part, in.Starter)
		}
		if err != nil {
			failure(w, err)
			return
		}
		if result.Status != "dispatched" && result.Status != "claimed" && result.Status != "redeemed" && result.Status != "target_selected" {
			write(w, 400, map[string]any{"error": result.Status})
			return
		}
		view, err := a.legacySeaView(r, c, session.AccountID)
		if err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "sea": view, "result": result})
	}
}
