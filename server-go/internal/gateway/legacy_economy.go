package gateway

import (
	"net/http"

	"fishing.local/server/internal/modules/economy"
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
