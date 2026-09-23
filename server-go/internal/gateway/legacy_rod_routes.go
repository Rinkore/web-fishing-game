package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"github.com/jackc/pgx/v5"
)

// Legacy rod routes. Each maps the original request shape onto the durable rod
// command and answers with the legacy snapshot fields the client renders.

func (a *API) legacyRodSlotBuy(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	if !a.legacyRodFeature(w, r.Context(), "bd.slots") {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	key := in.RequestKey
	if key == "" {
		key = "legacy:rod:buy:" + strconv.FormatInt(timeNowMS(), 10)
	}
	res, err := assets.New(a.pool).BuyRodSlot(ctx, session.AccountID, key)
	if err != nil {
		a.legacyRodFailure(w, err)
		return
	}
	if res.Status != "rod_slot_bought" {
		write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	price, _ := strconv.ParseInt(res.ResourceID, 10, 64)
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{
		"ok": true, "coins": profile["coins"], "price": price,
		"rodSlotsCount": profile["rodSlotsCount"], "nextRodSlotPrice": profile["nextRodSlotPrice"],
		"rodSlots": profile["rodSlots"],
	})
}

func (a *API) legacyRodSave(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "save")
}
func (a *API) legacyRodName(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "name")
}
func (a *API) legacyRodRename(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "rename")
}
func (a *API) legacyRodUse(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "use")
}
func (a *API) legacyRodStow(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "stow")
}
func (a *API) legacyRodDelete(w http.ResponseWriter, r *http.Request) {
	a.legacyRodCommand(w, r, "delete")
}

// legacyRodCommand executes one rod action and rebuilds the legacy snapshot.
// returned counts components that become tradeable again as a side effect.
func (a *API) legacyRodCommand(w http.ResponseWriter, r *http.Request, action string) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	feature := "bd.save"
	if action == "use" || action == "stow" {
		feature = "bd.equip"
	}
	if !a.legacyRodFeature(w, r.Context(), feature) {
		return
	}
	var in struct {
		Slot  int    `json:"slot"`
		Name  string `json:"name"`
		Force bool   `json:"force"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	active, err := a.activeRodSlot(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	// Legacy save without an explicit name falls back to the current rod name.
	if action == "save" && in.Name == "" {
		in.Name = a.activeRodName(r.Context(), session.AccountID, active)
	}
	returned := int64(0)
	switch action {
	case "use", "stow":
		if active < 0 {
			returned = a.rodComponentCount(r.Context(), session.AccountID, -1)
		}
	case "delete":
		if active != in.Slot {
			returned = a.rodComponentCount(r.Context(), session.AccountID, in.Slot)
		}
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := assets.New(a.pool).ChangeRod(ctx, assets.RodCommand{
		ActorID: session.AccountID, RequestKey: "legacy:rod:" + action + ":" + strconv.FormatInt(timeNowMS(), 10),
		Action: action, Slot: in.Slot, Name: in.Name, Force: in.Force,
	})
	if err != nil {
		a.legacyRodFailure(w, err)
		return
	}
	if res.Status != "rod_updated" {
		write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	out := map[string]any{
		"ok": true, "bd": profile["bd"], "rodName": profile["rodName"],
		"rodActiveSlot": profile["rodActiveSlot"], "inventory": profile["inventory"],
		"invRev": profile["invRev"], "rodSlots": profile["rodSlots"], "rodLocked": profile["rodLocked"],
		"coins": profile["coins"],
	}
	if action == "save" {
		out["slot"] = in.Slot
	}
	if returned > 0 {
		out["returned"] = returned
	}
	if action == "stow" {
		out["fromSlot"] = active
	}
	if action == "delete" {
		out["wasActive"] = active == in.Slot
	}
	write(w, 200, out)
}

// legacyRodFailure keeps the legacy rejection vocabulary for rod operations.
func (a *API) legacyRodFailure(w http.ResponseWriter, err error) {
	var rejection assets.Rejection
	switch {
	case errors.As(err, &rejection):
		write(w, 400, map[string]any{"error": string(rejection), "code": string(rejection)})
	case errors.Is(err, assets.ErrInvalid):
		write(w, 400, map[string]any{"error": "invalid_input", "code": "invalid_input"})
	case errors.Is(err, assets.ErrUnauthenticated):
		failure(w, identity.ErrCredentials)
	default:
		write(w, 503, map[string]any{"error": "retry_same_request"})
	}
}

func (a *API) activeRodSlot(ctx context.Context, owner int64) (int, error) {
	var slot int
	err := a.pool.QueryRow(ctx, `SELECT slot FROM fishing.rod_loadouts WHERE owner_id=$1 AND active`, owner).Scan(&slot)
	if errors.Is(err, pgx.ErrNoRows) {
		return -1, nil
	}
	return slot, err
}

func (a *API) activeRodName(ctx context.Context, owner int64, slot int) string {
	var name string
	if err := a.pool.QueryRow(ctx, `SELECT name FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=$2`, owner, slot).Scan(&name); err != nil {
		return ""
	}
	return name
}

func (a *API) rodComponentCount(ctx context.Context, owner int64, slot int) int64 {
	var n int64
	if err := a.pool.QueryRow(ctx, `SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2`, owner, slot).Scan(&n); err != nil {
		return 0
	}
	return n
}
