package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/identity"
)

// Legacy economy read projections. The original frontend treats /shop as the
// public reachability probe and price board; the durable supply/demand prices
// come from the economy module's shared state.

// legacyShop mirrors the legacy shopSnapshot map shape {id: {base, price,
// soldToday, soldTotal}} with no-store semantics.
func (a *API) legacyShop(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	prices, err := economy.New(a.pool, c).Prices(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	out := map[string]any{}
	for _, p := range prices {
		out[p.ID] = map[string]any{"base": p.Base, "price": p.Price, "soldToday": p.SoldToday, "soldTotal": p.SoldTotal}
	}
	w.Header().Set("Cache-Control", "no-store")
	write(w, 200, out)
}

// legacyShopHistory mirrors /api/shop/history. Per-minute price samples and
// trade feeds are not persisted in the Go schema yet, so points and trades are
// explicit empty degradations while the durable price/sale fields stay exact.
func (a *API) legacyShopHistory(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	id := r.URL.Query().Get("id")
	prices, err := economy.New(a.pool, c).Prices(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	for _, p := range prices {
		if p.ID != id {
			continue
		}
		write(w, 200, map[string]any{
			"id": p.ID, "base": p.Base, "price": p.Price,
			"soldToday": p.SoldToday, "soldTotal": p.SoldTotal,
			"points": []any{}, "trades": []any{},
		})
		return
	}
	write(w, 404, map[string]any{"error": "unknown_item", "code": "unknown_item"})
}

// legacySell bridges the original /api/sell contract. The frontend sends tier
// 'L'/'G'; the durable economy module uses large/giant and returns the gain
// details, while the response rebuilds the authoritative inventory snapshots.
func (a *API) legacySell(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ID   string `json:"id"`
		Qty  int64  `json:"qty"`
		Tier string `json:"tier"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Qty == 0 {
		in.Qty = 1
	}
	tier := "normal"
	if in.Tier == "L" {
		tier = "large"
	} else if in.Tier == "G" {
		tier = "giant"
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := economy.New(a.pool, c).Sell(ctx, economy.Sell{ActorID: session.AccountID, RequestKey: "legacy:sell:" + strconv.FormatInt(timeNowMS(), 10), ItemID: in.ID, Tier: tier, Quantity: in.Qty})
	if err != nil {
		failure(w, err)
		return
	}
	var details struct {
		Gain int64 `json:"gain"`
	}
	if err := json.Unmarshal(res.Details, &details); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	shop := map[string]any{}
	if prices, err := economy.New(a.pool, c).Prices(r.Context()); err == nil {
		for _, p := range prices {
			shop[p.ID] = map[string]any{"base": p.Base, "price": p.Price, "soldToday": p.SoldToday, "soldTotal": p.SoldTotal}
		}
	}
	write(w, 200, map[string]any{
		"ok":        true,
		"gain":      details.Gain,
		"coins":     profile["coins"],
		"inventory": profile["inventory"],
		"invRev":    profile["invRev"],
		"bigfish":   profile["bigfish"],
		"shop":      shop,
	})
}

func timeNowMS() int64 { return time.Now().UnixMilli() }
