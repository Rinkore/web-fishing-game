package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/mall"
)

// Legacy mall projections. The durable mall module owns limits and purchase
// counters; the legacy frontend expects the flat mallView shape with item
// display metadata and current inventory counts.

func (a *API) legacyMall(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	view, err := mall.New(a.pool, c, a.location).View(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	have := map[string]int64{}
	rows, err := a.pool.Query(r.Context(), `SELECT item_id,quantity-bound_quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND quantity-bound_quantity>0`, session.AccountID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id string
		var qty int64
		if rows.Scan(&id, &qty) != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		have[id] += qty
	}
	if rows.Err() != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	var coins int64
	_ = a.pool.QueryRow(r.Context(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins)
	items := []map[string]any{}
	for _, it := range view.Items {
		def, _ := c.Item(it.ID)
		var soldOut bool
		if it.Remain != nil && *it.Remain == 0 {
			soldOut = true
		}
		items = append(items, map[string]any{
			"id": it.ID, "name": def.Name, "kind": def.Kind, "rarity": def.Rarity,
			"price": it.Price, "limit": it.Limit, "bought": it.Bought, "remain": it.Remain,
			"soldOut": soldOut, "have": have[it.ID],
		})
	}
	write(w, 200, map[string]any{
		"ok": true, "refreshTime": view.RefreshTime, "cycleKey": view.Key,
		"nextRefreshAt": view.NextAt, "coins": coins, "items": items,
	})
}

func (a *API) legacyMallBuy(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ID  string `json:"id"`
		Qty int64  `json:"qty"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Qty == 0 {
		in.Qty = 1
	}
	if in.Qty < 1 || in.Qty > mall.MaxPurchaseQuantity {
		failure(w, identity.ErrInvalid)
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := mall.New(a.pool, c, a.location).Buy(ctx, mall.Purchase{ActorID: session.AccountID, RequestKey: "legacy:mall:" + strconv.FormatInt(time.Now().UnixMilli(), 10), ItemID: in.ID, Quantity: in.Qty})
	if err != nil {
		failure(w, err)
		return
	}
	if res.Status != "purchased" {
		assetResponse(w, res, nil)
		return
	}
	var details struct {
		Cost   int64 `json:"cost"`
		Bought int64 `json:"bought"`
	}
	_ = json.Unmarshal(res.Details, &details)
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	def, _ := c.Item(in.ID)
	mallNext, err := mall.New(a.pool, c, a.location).View(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{
		"ok": true, "id": in.ID, "name": def.Name, "qty": in.Qty,
		"cost": details.Cost, "coins": profile["coins"],
		"inventory": profile["inventory"], "invRev": profile["invRev"], "mall": mallNext,
	})
}
