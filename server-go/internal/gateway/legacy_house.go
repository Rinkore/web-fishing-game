package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/house"
	"net/http"
	"strings"
)

// houseSuccess lists the terminal statuses a successful house command returns.
// Anything else is one of the design's rejection codes, which the command
// boundary reports through Result.Status instead of an error.
var houseSuccess = map[string]bool{
	"collected": true, "upgraded": true, "renovated": true,
	"pet_feed": true, "pet_station": true, "pet_unstow": true,
	"role_invested": true, "stolen": true, "settled": true,
}

// houseFrozenStatus is reported by the service when the yard is frozen. It is
// deliberately NOT in houseSuccess: a frozen yard must surface as the
// rejection code house_frozen (409), not as a successful zero payout.
const houseFrozenStatus = "frozen"

// houseRejection turns a terminal failure status into the code the panel
// translates through its own errors{} table (see frontend/js/house.js).
func houseRejection(result assets.Result) string {
	if result.Status == "" || houseSuccess[result.Status] {
		return ""
	}
	if result.Status == houseFrozenStatus {
		return "house_frozen"
	}
	return result.Status
}

// House follows the expedition contract: every command carries a client-side
// stable request key, so a retried request after an ambiguous transport failure
// returns the original result instead of paying twice.
//
// action is "view" for the read-only view, or one of the write commands.
func (a *API) legacyHouse(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := a.authorize(w, r, false)
		if !ok {
			return
		}
		c, err := a.catalog(r.Context())
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		svc := house.New(a.pool, c)

		if action == "view" {
			view, err := svc.View(r.Context(), session.AccountID)
			if err != nil {
				assetResponse(w, assets.Result{}, err)
				return
			}
			write(w, 200, map[string]any{"ok": true, "house": view})
			return
		}

		var in struct {
			RequestKey string `json:"requestKey"`
			PetID      string `json:"petId"`
			PetAction  string `json:"petAction"`
			Track      string `json:"track"`
			Points     int    `json:"points"`
			Target     string `json:"target"`
		}
		if !decode(w, r, &in) {
			return
		}
		if len(in.RequestKey) < 8 || len(in.RequestKey) > 100 {
			write(w, 400, map[string]any{"error": "invalid_request_key"})
			return
		}
		// Player keys are opaque client-generated tokens. Rejecting ':' keeps a
		// client from forging the reserved system keys the settlement worker uses.
		if strings.Contains(in.RequestKey, ":") {
			write(w, 400, map[string]any{"error": "invalid_request_key"})
			return
		}
		ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
		var result assets.Result
		switch action {
		case "collect":
			result, err = svc.Collect(ctx, session.AccountID, in.RequestKey)
		case "upgrade":
			result, err = svc.Upgrade(ctx, session.AccountID, in.RequestKey)
		case "renovate":
			result, err = svc.Renovate(ctx, session.AccountID, in.RequestKey)
		case "pet":
			result, err = svc.Pet(ctx, session.AccountID, in.RequestKey, in.PetID, in.PetAction)
		case "role":
			result, err = svc.Role(ctx, session.AccountID, in.RequestKey, in.Track, in.Points)
		case "steal":
			result, err = svc.Steal(ctx, session.AccountID, in.RequestKey, in.Target)
		default:
			write(w, 400, map[string]any{"error": "unknown_action"})
			return
		}
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		if code := houseRejection(result); code != "" {
			write(w, 409, map[string]any{"error": code})
			return
		}
		view, err := svc.View(r.Context(), session.AccountID)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "house": view, "result": result})
	}
}
