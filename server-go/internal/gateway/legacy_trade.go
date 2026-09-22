package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/trade"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Legacy bilateral trade contracts (/api/trade/*) plus the trade and tradeDone
// stream projections.
//
// The durable trade module owns the transaction: versioned offers, confirm
// resets, the 3s confirmation cooldown and atomic settlement. This bridge maps
// the original HTTP contract onto it. Legacy identities are lowercase
// usernames, so every key exposed here is a username even though the module
// works with account ids, and the original "T<seq>" trade id is preserved as an
// opaque handle that also accepts a plain numeric id.

type legacyTradeParty struct {
	ID   int64
	Key  string
	Name string
}

type legacyTradeItem struct {
	ID  string `json:"id"`
	Qty int64  `json:"qty"`
}

type legacyTradeItemInput struct {
	ID  string `json:"id"`
	Qty int64  `json:"qty"`
}

// legacyTradeState is the durable row projected into the legacy view fields.
type legacyTradeState struct {
	ID       int64
	A, B     legacyTradeParty
	State    string
	Revision int64
	Cooldown time.Time
	AConfirm bool
	BConfirm bool
	AOffer   trade.Offer
	BOffer   trade.Offer
}

// legacyTradeStream remembers what one stream already reported so the poll loop
// emits each legacy projection exactly once.
type legacyTradeStream struct {
	ID       int64
	Revision int64
	State    string
	AConfirm bool
	BConfirm bool
	Active   bool
}

func legacyTradeRef(id int64) string { return "T" + strconv.FormatInt(id, 10) }

func legacyTradeID(raw string) (int64, bool) {
	value := strings.TrimSpace(raw)
	if len(value) > 1 && (value[0] == 'T' || value[0] == 't') {
		value = value[1:]
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id < 1 {
		return 0, false
	}
	return id, true
}

func legacyTradeActive(state string) bool {
	return state == "invited" || state == "accepted"
}

func legacyTradeError(w http.ResponseWriter, status int, message string) {
	write(w, status, map[string]any{"error": message})
}

// legacyTradeCooldownMS keeps the legacy millisecond epoch, reporting 0 whenever
// the stored deadline is in the past (the durable schema uses '-infinity').
func legacyTradeCooldownMS(until time.Time) int64 {
	if ms := until.UnixMilli(); ms > time.Now().UnixMilli() {
		return ms
	}
	return 0
}

func legacyTradeItemName(c *rules.Catalog, id string) string {
	if base, _, _, ok := c.Instance(id); ok && base.Name != "" {
		return base.Name
	}
	if it, ok := c.Item(id); ok && it.Name != "" {
		return it.Name
	}
	return id
}

// legacyTradeSellable mirrors the original sellableOf: fish, materials, rods
// and chests are tradeable, plus component instances and the generic component.
func legacyTradeSellable(c *rules.Catalog, id string) bool {
	if id == "comp_generic" {
		return true
	}
	if _, _, _, ok := c.Instance(id); ok {
		return true
	}
	it, ok := c.Item(id)
	if !ok {
		return false
	}
	switch it.Kind {
	case "fish", "material", "rod", "chest":
		return true
	}
	return false
}

func (a *API) legacyTradeByKey(ctx context.Context, key string) (legacyTradeParty, bool, error) {
	var p legacyTradeParty
	err := a.pool.QueryRow(ctx, `SELECT account_id,lower(username),display_name FROM fishing.identities WHERE lower(username)=$1`, key).
		Scan(&p.ID, &p.Key, &p.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, identity.ErrStorage
	}
	return p, true, nil
}

// legacyTradeOnline reports the legacy presence notion: the player holds a live
// SSE stream. The stream lease keeps fishing_connections in sync, so the durable
// trade module sees the same audience.
func (a *API) legacyTradeOnline(ctx context.Context, owner int64) (bool, error) {
	var online bool
	if err := a.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.gateway_streams WHERE owner_id=$1 AND expires_at>clock_timestamp())`, owner).Scan(&online); err != nil {
		return false, identity.ErrStorage
	}
	return online, nil
}

func (a *API) legacyTradeState(ctx context.Context, id int64) (legacyTradeState, bool, error) {
	var st legacyTradeState
	var aOffer, bOffer []byte
	// cooldown_until defaults to '-infinity', which pgx cannot scan into
	// time.Time; the durable module normalises it the same way.
	err := a.pool.QueryRow(ctx, `SELECT t.id,t.state,t.revision,CASE WHEN t.cooldown_until='-infinity' THEN '1970-01-01'::timestamptz ELSE t.cooldown_until END,t.a_confirm,t.b_confirm,t.a_offer,t.b_offer,
 t.a_id,lower(ia.username),ia.display_name,t.b_id,lower(ib.username),ib.display_name
 FROM fishing.trades t JOIN fishing.identities ia ON ia.account_id=t.a_id JOIN fishing.identities ib ON ib.account_id=t.b_id
 WHERE t.id=$1`, id).
		Scan(&st.ID, &st.State, &st.Revision, &st.Cooldown, &st.AConfirm, &st.BConfirm, &aOffer, &bOffer,
			&st.A.ID, &st.A.Key, &st.A.Name, &st.B.ID, &st.B.Key, &st.B.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, false, nil
	}
	if err != nil {
		return st, false, identity.ErrStorage
	}
	if json.Unmarshal(aOffer, &st.AOffer) != nil || json.Unmarshal(bOffer, &st.BOffer) != nil {
		return st, false, identity.ErrStorage
	}
	return st, true, nil
}

// legacyTradeActiveID returns the trade the legacy client would show on init.
func (a *API) legacyTradeActiveID(ctx context.Context, owner int64) (int64, error) {
	var id int64
	err := a.pool.QueryRow(ctx, `SELECT id FROM fishing.trades WHERE (a_id=$1 OR b_id=$1) AND state IN ('invited','accepted') ORDER BY id LIMIT 1`, owner).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, identity.ErrStorage
	}
	return id, nil
}

func (a *API) legacyTradeViewItems(ctx context.Context, offer trade.Offer) ([]legacyTradeItem, error) {
	items := []legacyTradeItem{}
	for _, stack := range offer.Stacks {
		items = append(items, legacyTradeItem{ID: stack.ID, Qty: stack.Quantity})
	}
	if len(offer.Equipment) == 0 {
		return items, nil
	}
	// Components travel as equipment ids but the legacy contract keys them by
	// instance signature, which is also what the client resolves affixes from.
	signatures := map[int64]string{}
	rows, err := a.pool.Query(ctx, `SELECT id,COALESCE(attributes->>'signature','') FROM fishing.equipment_instances WHERE id=ANY($1::bigint[])`, offer.Equipment)
	if err != nil {
		return nil, identity.ErrStorage
	}
	for rows.Next() {
		var id int64
		var signature string
		if err := rows.Scan(&id, &signature); err != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		signatures[id] = signature
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, identity.ErrStorage
	}
	for _, id := range offer.Equipment {
		items = append(items, legacyTradeItem{ID: signatures[id], Qty: 1})
	}
	return items, nil
}

func (a *API) legacyTradeView(ctx context.Context, st legacyTradeState) (map[string]any, error) {
	aItems, err := a.legacyTradeViewItems(ctx, st.AOffer)
	if err != nil {
		return nil, err
	}
	bItems, err := a.legacyTradeViewItems(ctx, st.BOffer)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id":            legacyTradeRef(st.ID),
		"a":             map[string]any{"key": st.A.Key, "name": st.A.Name},
		"b":             map[string]any{"key": st.B.Key, "name": st.B.Name},
		"aItems":        aItems,
		"bItems":        bItems,
		"aOk":           st.AConfirm,
		"bOk":           st.BConfirm,
		"accepted":      st.State != "invited",
		"cooldownUntil": legacyTradeCooldownMS(st.Cooldown),
		"reason":        nil,
		"cancelled":     st.State == "cancelled" || st.State == "expired",
		"done":          st.State == "done",
	}, nil
}

func (a *API) legacyTradeSnapshot(ctx context.Context, party legacyTradeParty) (map[string]any, error) {
	inventory, _, err := a.legacyInventory(ctx, party.ID)
	if err != nil {
		return nil, err
	}
	var coins, rev int64
	if err := a.pool.QueryRow(ctx, `SELECT w.coins,p.assets_rev FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, party.ID).
		Scan(&coins, &rev); err != nil {
		return nil, identity.ErrStorage
	}
	return map[string]any{"key": party.Key, "inventory": inventory, "coins": coins, "invRev": strconv.FormatInt(rev, 10)}, nil
}

func (a *API) legacyTradeDone(ctx context.Context, st legacyTradeState) (map[string]any, error) {
	aItems, err := a.legacyTradeViewItems(ctx, st.AOffer)
	if err != nil {
		return nil, err
	}
	bItems, err := a.legacyTradeViewItems(ctx, st.BOffer)
	if err != nil {
		return nil, err
	}
	aSide, err := a.legacyTradeSnapshot(ctx, st.A)
	if err != nil {
		return nil, err
	}
	bSide, err := a.legacyTradeSnapshot(ctx, st.B)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"type": "tradeDone", "tradeId": legacyTradeRef(st.ID),
		"aItems": aItems, "bItems": bItems, "aName": st.A.Name, "bName": st.B.Name,
		"a": aSide, "b": bSide,
	}, nil
}

// legacyTradeInitView is the init.trade payload (myTradeView) and it primes the
// stream tracker so the first poll does not repeat the same view.
func (a *API) legacyTradeInitView(ctx context.Context, owner int64, track *legacyTradeStream) any {
	id, err := a.legacyTradeActiveID(ctx, owner)
	if err != nil || id == 0 {
		return nil
	}
	st, found, err := a.legacyTradeState(ctx, id)
	if err != nil || !found || !legacyTradeActive(st.State) {
		return nil
	}
	view, err := a.legacyTradeView(ctx, st)
	if err != nil {
		return nil
	}
	track.ID, track.Revision, track.State, track.Active = st.ID, st.Revision, st.State, true
	track.AConfirm, track.BConfirm = st.AConfirm, st.BConfirm
	return view
}

// legacyTradeMessages returns the data payloads a stream still owes its client.
// The original server pushed trade events from the mutating request; polling the
// durable row keeps that projection without a second in-process registry, and
// init.trade is the reconnect path.
func (a *API) legacyTradeMessages(ctx context.Context, owner int64, track *legacyTradeStream) []string {
	payloads := []string{}
	if track.Active {
		st, found, err := a.legacyTradeState(ctx, track.ID)
		if err != nil {
			return payloads
		}
		if !found {
			track.Active = false
		} else {
			// A single-sided confirm changes neither the trade revision nor the
			// state, so the confirm flags are part of the change detection.
			if st.Revision != track.Revision || st.State != track.State || st.AConfirm != track.AConfirm || st.BConfirm != track.BConfirm {
				if view, err := a.legacyTradeView(ctx, st); err == nil {
					// The original stream pushes the view inside the "trade"
					// envelope; the bare view is only used for init.trade.
					payloads = append(payloads, jsonString(map[string]any{"type": "trade", "trade": view}))
				}
			}
			track.Revision, track.State, track.AConfirm, track.BConfirm = st.Revision, st.State, st.AConfirm, st.BConfirm
			if !legacyTradeActive(st.State) {
				track.Active = false
				if st.State == "done" {
					if done, err := a.legacyTradeDone(ctx, st); err == nil {
						payloads = append(payloads, jsonString(done))
					}
				}
			}
		}
	}
	if track.Active {
		return payloads
	}
	id, err := a.legacyTradeActiveID(ctx, owner)
	if err != nil || id == 0 {
		return payloads
	}
	st, found, err := a.legacyTradeState(ctx, id)
	if err != nil || !found {
		return payloads
	}
	track.ID, track.Revision, track.State, track.Active = st.ID, st.Revision, st.State, true
	track.AConfirm, track.BConfirm = st.AConfirm, st.BConfirm
	if view, err := a.legacyTradeView(ctx, st); err == nil {
		payloads = append(payloads, jsonString(map[string]any{"type": "trade", "trade": view}))
	}
	return payloads
}

// legacyTradeWatcher is the per-stream reader of the durable trade row. The HTTP
// bridge mutates the row; the stream loop polls this watcher, so the legacy
// trade/tradeDone pushes need no in-process registry that could drift from the
// database.
type legacyTradeWatcher struct {
	api   *API
	owner int64
	track legacyTradeStream
}

func (a *API) newLegacyTradeWatcher(ctx context.Context, owner int64) *legacyTradeWatcher {
	return &legacyTradeWatcher{api: a, owner: owner}
}

// snapshot is the init.trade payload (legacy myTradeView) and primes the tracker
// so the first poll does not repeat the same view.
func (w *legacyTradeWatcher) snapshot(ctx context.Context) any {
	return w.api.legacyTradeInitView(ctx, w.owner, &w.track)
}

// poll returns the complete SSE frames this stream still owes its client.
func (w *legacyTradeWatcher) poll(ctx context.Context) []string {
	frames := []string{}
	for _, payload := range w.api.legacyTradeMessages(ctx, w.owner, &w.track) {
		frames = append(frames, "data: "+payload+"\n\n")
	}
	return frames
}

// legacyTradeOffer validates the legacy item list and converts it into the
// durable offer. The returned message is the original Chinese rejection text.
func (a *API) legacyTradeOffer(ctx context.Context, c *rules.Catalog, owner int64, items []legacyTradeItemInput) (trade.Offer, string, error) {
	offer := trade.Offer{Stacks: []trade.Stack{}, Equipment: []int64{}}
	seen := map[string]bool{}
	for _, item := range items {
		id := item.ID
		if id == "" || item.Qty < 1 || seen[id] || strings.HasPrefix(id, "rodset:") {
			return offer, "交易物品非法或重复", nil
		}
		seen[id] = true
		if _, _, _, isInstance := c.Instance(id); isInstance {
			instances, err := a.legacyFreeInstances(ctx, owner, id, item.Qty)
			if err != nil {
				return offer, "", err
			}
			if int64(len(instances)) < item.Qty {
				return offer, "你没有足够的 " + legacyTradeItemName(c, id), nil
			}
			offer.Equipment = append(offer.Equipment, instances...)
			continue
		}
		if !legacyTradeSellable(c, id) {
			return offer, "交易物品非法或重复", nil
		}
		var have int64
		if err := a.pool.QueryRow(ctx, `SELECT COALESCE(sum(quantity),0) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier='normal'`, owner, id).Scan(&have); err != nil {
			return offer, "", identity.ErrStorage
		}
		if have < item.Qty {
			return offer, "你没有足够的 " + legacyTradeItemName(c, id), nil
		}
		offer.Stacks = append(offer.Stacks, trade.Stack{ID: id, Quantity: item.Qty})
	}
	return offer, "", nil
}

func (a *API) legacyTradeWriteFailure(w http.ResponseWriter, err error, st legacyTradeState) {
	var rejection assets.Rejection
	switch {
	case errors.As(err, &rejection):
		switch string(rejection) {
		case "trade_not_found", "trade_closed", "expired":
			legacyTradeError(w, 404, "交易不存在")
		case "not_accepted", "cannot_respond":
			legacyTradeError(w, 400, "对方尚未接受邀请")
		case "confirmation_cooldown":
			write(w, 429, map[string]any{"error": "冷却中，请稍候", "cooldownUntil": legacyTradeCooldownMS(st.Cooldown)})
		case "offer_unavailable", "offer_invalidated":
			legacyTradeError(w, 400, "物品不足，交易已重置")
		case "offer_changed":
			legacyTradeError(w, 409, "交易状态已变化，请重试")
		case "player_offline":
			legacyTradeError(w, 400, "对方不在线")
		case "trade_exists":
			legacyTradeError(w, 409, "已有进行中的交易")
		default:
			write(w, 409, map[string]any{"error": string(rejection)})
		}
	case errors.Is(err, assets.ErrInvalid):
		legacyTradeError(w, 400, "请求参数无效")
	case errors.Is(err, assets.ErrUnauthenticated):
		failure(w, identity.ErrCredentials)
	case errors.Is(err, assets.ErrKeyConflict):
		legacyTradeError(w, 400, "重复的请求编号")
	default:
		write(w, 503, map[string]any{"error": "retry_same_request"})
	}
}

func (a *API) legacyTradeInvite(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Target string `json:"target"`
	}
	if !decode(w, r, &in) {
		return
	}
	key := strings.ToLower(in.Target)
	if key == "" {
		legacyTradeError(w, 404, "对方不存在")
		return
	}
	if key == strings.ToLower(session.Username) {
		legacyTradeError(w, 400, "不能与自己交易")
		return
	}
	target, found, err := a.legacyTradeByKey(r.Context(), key)
	if err != nil {
		failure(w, err)
		return
	}
	if !found {
		legacyTradeError(w, 404, "对方不存在")
		return
	}
	online, err := a.legacyTradeOnline(r.Context(), target.ID)
	if err != nil {
		failure(w, err)
		return
	}
	if !online {
		legacyTradeError(w, 400, "对方不在线")
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Invite(ctx, trade.Invite{ActorID: session.AccountID, TargetID: target.ID, RequestKey: legacyMarketKey("legacy:trade:invite")})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, legacyTradeState{})
		return
	}
	if res.Status != "invited" {
		// The durable module reports a rejection as a status, not as an error,
		// so the legacy text has to be resolved from the result.
		a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), legacyTradeState{})
		return
	}
	id, err := strconv.ParseInt(res.ResourceID, 10, 64)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "tradeId": legacyTradeRef(id)})
}

func (a *API) legacyTradeRespond(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		TradeID string `json:"tradeId"`
		Accept  *bool  `json:"accept"`
	}
	if !decode(w, r, &in) {
		return
	}
	id, ok := legacyTradeID(in.TradeID)
	if !ok {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	st, found, err := a.legacyTradeState(r.Context(), id)
	if err != nil {
		failure(w, err)
		return
	}
	if !found {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	if st.A.ID != session.AccountID && st.B.ID != session.AccountID {
		legacyTradeError(w, 403, "无权操作")
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	svc := trade.New(a.pool)
	accept := in.Accept == nil || *in.Accept
	if !accept {
		// The legacy contract lets either side decline; the invitee's decline is
		// the durable respond transition and the inviter's is a cancel.
		action := "respond"
		if session.AccountID == st.A.ID {
			action = "cancel"
		}
		res, err := svc.Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: id, Revision: st.Revision, RequestKey: legacyMarketKey("legacy:trade:" + action), Action: action, Accept: false})
		if err != nil {
			a.legacyTradeWriteFailure(w, err, st)
			return
		}
		if res.Status != "cancelled" {
			a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), st)
			return
		}
		write(w, 200, map[string]any{"ok": true, "closed": true})
		return
	}
	if st.State != "invited" || session.AccountID == st.A.ID {
		// Already accepted, or the inviter acknowledging its own invite: the
		// original server treated both as a successful no-op.
		write(w, 200, map[string]any{"ok": true})
		return
	}
	res, err := svc.Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: id, Revision: st.Revision, RequestKey: legacyMarketKey("legacy:trade:respond"), Action: "respond", Accept: true})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, st)
		return
	}
	if res.Status != "accepted" {
		a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), st)
		return
	}
	write(w, 200, map[string]any{"ok": true})
}

func (a *API) legacyTradeSet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		TradeID string                 `json:"tradeId"`
		Items   []legacyTradeItemInput `json:"items"`
	}
	if !decode(w, r, &in) {
		return
	}
	id, ok := legacyTradeID(in.TradeID)
	if !ok {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	st, found, err := a.legacyTradeState(r.Context(), id)
	if err != nil {
		failure(w, err)
		return
	}
	if !found || !legacyTradeActive(st.State) {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	if st.A.ID != session.AccountID && st.B.ID != session.AccountID {
		legacyTradeError(w, 403, "无权操作")
		return
	}
	if st.State != "accepted" {
		legacyTradeError(w, 400, "对方尚未接受邀请")
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	offer, message, err := a.legacyTradeOffer(r.Context(), c, session.AccountID, in.Items)
	if err != nil {
		failure(w, err)
		return
	}
	if message != "" {
		legacyTradeError(w, 400, message)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: id, Revision: st.Revision, RequestKey: legacyMarketKey("legacy:trade:set"), Action: "offer", Offer: offer})
	if err != nil {
		var rejection assets.Rejection
		if errors.As(err, &rejection) && string(rejection) == "offer_unavailable" {
			// Raced with another change: report the first item the player no
			// longer holds instead of the generic reset text.
			if _, message, checkErr := a.legacyTradeOffer(r.Context(), c, session.AccountID, in.Items); checkErr == nil && message != "" {
				legacyTradeError(w, 400, message)
				return
			}
		}
		a.legacyTradeWriteFailure(w, err, st)
		return
	}
	if res.Status != "offer_updated" {
		// A raced offer (the other side changed the row first) or an offline
		// partner arrives as a status; never report it as a stored offer.
		if res.Status == "offer_unavailable" {
			if _, message, checkErr := a.legacyTradeOffer(r.Context(), c, session.AccountID, in.Items); checkErr == nil && message != "" {
				legacyTradeError(w, 400, message)
				return
			}
		}
		a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), st)
		return
	}
	cooldown := int64(0)
	if after, found, err := a.legacyTradeState(r.Context(), id); err == nil && found {
		cooldown = legacyTradeCooldownMS(after.Cooldown)
	}
	write(w, 200, map[string]any{"ok": true, "cooldownUntil": cooldown})
}

func (a *API) legacyTradeConfirm(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		TradeID string `json:"tradeId"`
	}
	if !decode(w, r, &in) {
		return
	}
	id, ok := legacyTradeID(in.TradeID)
	if !ok {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	st, found, err := a.legacyTradeState(r.Context(), id)
	if err != nil {
		failure(w, err)
		return
	}
	if !found || !legacyTradeActive(st.State) {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	if st.A.ID != session.AccountID && st.B.ID != session.AccountID {
		legacyTradeError(w, 403, "无权操作")
		return
	}
	if st.State != "accepted" {
		legacyTradeError(w, 400, "对方尚未接受邀请")
		return
	}
	if cooldown := legacyTradeCooldownMS(st.Cooldown); cooldown > 0 {
		write(w, 429, map[string]any{"error": "冷却中，请稍候", "cooldownUntil": cooldown})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: id, Revision: st.Revision, RequestKey: legacyMarketKey("legacy:trade:confirm"), Action: "confirm"})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, st)
		return
	}
	if res.Status == "traded" {
		write(w, 200, map[string]any{"ok": true, "done": true})
		return
	}
	if res.Status == "offer_invalidated" {
		legacyTradeError(w, 400, "物品不足，交易已重置")
		return
	}
	if res.Status != "confirmed" {
		a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), st)
		return
	}
	write(w, 200, map[string]any{"ok": true})
}

func (a *API) legacyTradeCancel(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		TradeID string `json:"tradeId"`
	}
	if !decode(w, r, &in) {
		return
	}
	id, ok := legacyTradeID(in.TradeID)
	if !ok {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	st, found, err := a.legacyTradeState(r.Context(), id)
	if err != nil {
		failure(w, err)
		return
	}
	if !found {
		legacyTradeError(w, 404, "交易不存在")
		return
	}
	if st.A.ID != session.AccountID && st.B.ID != session.AccountID {
		legacyTradeError(w, 403, "无权操作")
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := trade.New(a.pool).Change(ctx, trade.Change{ActorID: session.AccountID, TradeID: id, Revision: st.Revision, RequestKey: legacyMarketKey("legacy:trade:cancel"), Action: "cancel"})
	if err != nil {
		a.legacyTradeWriteFailure(w, err, st)
		return
	}
	if res.Status != "cancelled" {
		a.legacyTradeWriteFailure(w, assets.Rejection(res.Status), st)
		return
	}
	write(w, 200, map[string]any{"ok": true})
}
