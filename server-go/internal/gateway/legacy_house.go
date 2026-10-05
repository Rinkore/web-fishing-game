package gateway

import (
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/house"
	"net/http"
	"strings"
)

// houseSuccess lists the terminal statuses a successful house command returns.
var houseSuccess = map[string]bool{
	"placed": true, "collected": true, "nothing_ready": true,
	"upgraded": true, "renovated": true,
	"pet_feed": true, "pet_station": true, "pet_unstow": true,
	"role_invested": true, "stolen": true, "settled": true,
}

// houseFrozenStatus is reported when the yard is frozen.
const houseFrozenStatus = "frozen"

func houseRejection(result assets.Result) string {
	if result.Status == "" || houseSuccess[result.Status] {
		return ""
	}
	if result.Status == houseFrozenStatus {
		return "house_frozen"
	}
	return result.Status
}

// legacyHouse handles all /api/house/* write commands plus the view.
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
			// pet
			PetID     string `json:"petId"`
			PetAction string `json:"petAction"`
			// role
			Track  string `json:"track"`
			Points int    `json:"points"`
			// steal
			Target string `json:"target"`
			// place_fish — price and tier are resolved server-side from the catalog;
			// the client only supplies the fish item id, slot index, and processing chain.
			FishID  string   `json:"fishId"`
			SlotIdx int      `json:"slotIdx"`
			Phases  []string `json:"phases"`
		}
		if !decode(w, r, &in) {
			return
		}
		if len(in.RequestKey) < 8 || len(in.RequestKey) > 100 {
			write(w, 400, map[string]any{"error": "invalid_request_key"})
			return
		}
		if strings.Contains(in.RequestKey, ":") {
			write(w, 400, map[string]any{"error": "invalid_request_key"})
			return
		}
		ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
		var result assets.Result
		switch action {
		case "place_fish":
			result, err = svc.PlaceFish(ctx, session.AccountID, in.RequestKey,
				in.FishID, in.SlotIdx, in.Phases)
		case "collect_rack":
			result, err = svc.CollectRack(ctx, session.AccountID, in.RequestKey, false)
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
