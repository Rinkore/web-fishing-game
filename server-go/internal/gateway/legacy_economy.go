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
	out, err := a.legacyShopData(r.Context(), c)
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	write(w, 200, out)
}

// legacyShopHistory includes imported price and sales history. Historical
// rows are display records and never replay any payment or inventory change.
func (a *API) legacyShopHistory(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	id := r.URL.Query().Get("id")
	p, exists, err := a.legacyHistoryQuote(r.Context(), c, id)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		write(w, 404, map[string]any{"error": "unknown_item", "code": "unknown_item"})
		return
	}
	points, err := a.legacyEconomicHistory(r.Context(), "price", id, 10000)
	if err != nil {
		failure(w, err)
		return
	}
	for i, j := 0, len(points)-1; i < j; i, j = i+1, j-1 {
		points[i], points[j] = points[j], points[i]
	}
	trades, err := a.legacyEconomicHistory(r.Context(), "shop", id, 200)
	if err != nil {
		failure(w, err)
		return
	}
	rows, err := a.pool.Query(r.Context(), `SELECT (1000*extract(epoch from s.created_at))::bigint,i.display_name,s.quantity,s.unit,s.automatic FROM fishing.shop_sales s JOIN fishing.identities i ON i.account_id=s.owner_id WHERE s.item_id=$1 ORDER BY s.created_at DESC,s.operation_id DESC LIMIT 200`, id)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	live := []map[string]any{}
	for rows.Next() {
		var t, q, unit int64
		var who string
		var auto bool
		if rows.Scan(&t, &who, &q, &unit, &auto) != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		if auto {
			who += "·自动"
		}
		live = append(live, map[string]any{"t": t, "who": who, "qty": q, "unit": unit})
	}
	if rows.Err() != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	trades = append(live, trades...)
	if len(trades) > 200 {
		trades = trades[:200]
	}
	for i, j := 0, len(trades)-1; i < j; i, j = i+1, j-1 {
		trades[i], trades[j] = trades[j], trades[i]
	}
	write(w, 200, map[string]any{
		"id": p.ID, "base": p.Base, "price": p.Price,
		"soldToday": p.SoldToday, "soldTotal": p.SoldTotal,
		"points": points, "trades": trades,
	})
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
