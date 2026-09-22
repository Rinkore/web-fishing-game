package gateway

import (
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/market"
)

func (a *API) marketList(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey  string `json:"requestKey"`
		ItemID      string `json:"itemId"`
		Quantity    int64  `json:"quantity"`
		EquipmentID int64  `json:"equipmentId,string"`
		RodSlot     *int   `json:"rodSlot"`
		UnitPrice   int64  `json:"unitPrice"`
		Hours       int    `json:"hours"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := market.New(a.pool).ListOrder(ctx, market.OrderRequest{ActorID: session.AccountID, RequestKey: in.RequestKey, ItemID: in.ItemID, Quantity: in.Quantity, EquipmentID: in.EquipmentID, RodSlot: in.RodSlot, UnitPrice: in.UnitPrice, Hours: in.Hours})
	assetResponse(w, res, err)
}
func (a *API) marketBuy(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey        string `json:"requestKey"`
		OrderID           int64  `json:"orderId,string"`
		Quantity          int64  `json:"quantity"`
		ExpectedUnitPrice int64  `json:"expectedUnitPrice"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := market.New(a.pool).Fill(ctx, market.FillRequest{ActorID: session.AccountID, RequestKey: in.RequestKey, OrderID: in.OrderID, Quantity: in.Quantity, ExpectedUnitPrice: in.ExpectedUnitPrice})
	assetResponse(w, res, err)
}
func (a *API) marketCancel(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		OrderID    int64  `json:"orderId,string"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := market.New(a.pool).CloseOrder(ctx, session.AccountID, in.OrderID, in.RequestKey, false)
	assetResponse(w, res, err)
}
func pagination(r *http.Request) (int64, int, bool) {
	after, limit := int64(0), 50
	var err error
	if raw := r.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			return 0, 0, false
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return 0, 0, false
		}
	}
	return after, limit, true
}
func (a *API) marketOpen(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, false); !ok {
		return
	}
	after, limit, ok := pagination(r)
	if !ok {
		failure(w, identity.ErrInvalid)
		return
	}
	list, err := market.New(a.pool).OpenOrders(r.Context(), after, limit)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	next := ""
	if len(list) == limit {
		next = strconv.FormatInt(list[len(list)-1].ID, 10)
	}
	write(w, 200, map[string]any{"items": list, "nextAfter": next})
}
func (a *API) marketHistory(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	after, limit, ok := pagination(r)
	if !ok {
		failure(w, identity.ErrInvalid)
		return
	}
	rows, err := a.pool.Query(r.Context(), `SELECT f.operation_id,f.order_id,o.seller_id,f.buyer_id,f.quantity,f.total,f.tax FROM fishing.market_fills f JOIN fishing.market_orders o ON o.id=f.order_id WHERE (f.buyer_id=$1 OR o.seller_id=$1) AND f.operation_id>$2 ORDER BY f.operation_id LIMIT $3`, session.AccountID, after, limit)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	next := ""
	for rows.Next() {
		var op, order, seller, buyer, qty, total, tax int64
		if rows.Scan(&op, &order, &seller, &buyer, &qty, &total, &tax) != nil {
			failure(w, identity.ErrStorage)
			return
		}
		list = append(list, map[string]any{"operationId": strconv.FormatInt(op, 10), "orderId": strconv.FormatInt(order, 10), "sellerId": strconv.FormatInt(seller, 10), "buyerId": strconv.FormatInt(buyer, 10), "quantity": qty, "total": total, "tax": tax})
		next = strconv.FormatInt(op, 10)
	}
	if rows.Err() != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if len(list) < limit {
		next = ""
	}
	write(w, 200, map[string]any{"items": list, "nextAfter": next})
}
func (a *API) rodChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey  string `json:"requestKey"`
		Action      string `json:"action"`
		Part        string `json:"part"`
		EquipmentID int64  `json:"equipmentId,string"`
		Slot        int    `json:"slot"`
		Name        string `json:"name"`
		Force       bool   `json:"force"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := assets.New(a.pool).ChangeRod(ctx, assets.RodCommand{ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, Part: in.Part, EquipmentID: in.EquipmentID, Slot: in.Slot, Name: in.Name, Force: in.Force})
	assetResponse(w, res, err)
}
func (a *API) operation(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	res, err := assets.New(a.pool).Lookup(r.Context(), session.AccountID, r.URL.Query().Get("key"))
	if err == assets.ErrNotFound {
		write(w, 404, map[string]any{"error": "result_not_found", "retrySameKey": true})
		return
	}
	assetResponse(w, res, err)
}
