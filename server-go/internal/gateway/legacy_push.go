package gateway

import (
	"context"
	"encoding/json"
	"strconv"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

// Legacy /events push projections.
//
// The original server pushed each domain from the mutating request; the Go
// bridge has no in-process connection registry, so every part projects durable
// state into the frames the original client expects and keeps its own cursor,
// so a slow or missed tick never drops an event.
//
// Covered: trade (the existing watcher), market fills plus listing revisions,
// friend relations and the paginated player viewport.
// Not covered yet (documented in DELIVERY.md): subalert, configuration and
// banner pushes (bitecfg/castcfg/…/banner/maintenance), feed and records.

type legacyStreamPush interface {
	// init contributes fields to the SSE init frame (nil when the domain has no
	// snapshot field of its own).
	init(ctx context.Context) map[string]any
	// poll returns the frames this stream still owes its client.
	poll(ctx context.Context) []string
}

func legacyFrame(payload map[string]any) string {
	return "data: " + jsonString(payload) + "\n\n"
}

type legacyPushSet struct{ parts []legacyStreamPush }

func (a *API) newLegacyPushes(owner int64, c *rules.Catalog) *legacyPushSet {
	return &legacyPushSet{parts: []legacyStreamPush{
		&legacyTradePush{watcher: a.newLegacyTradeWatcher(context.Background(), owner)},
		&legacyMarketPush{api: a, owner: owner, catalog: c},
		&legacyFriendPush{api: a, owner: owner},
		&legacyPlayersPush{api: a, owner: owner, catalog: c},
	}}
}

func (p *legacyPushSet) init(ctx context.Context) map[string]any {
	fields := map[string]any{}
	for _, part := range p.parts {
		for key, value := range part.init(ctx) {
			fields[key] = value
		}
	}
	return fields
}

func (p *legacyPushSet) poll(ctx context.Context) []string {
	frames := []string{}
	for _, part := range p.parts {
		frames = append(frames, part.poll(ctx)...)
	}
	return frames
}

// legacyTradePush adapts the durable trade watcher to the push interface. The
// watcher compares revision/state/confirm flags itself, so it is polled every
// tick; a single-sided confirm changes none of the durable revision columns.
type legacyTradePush struct{ watcher *legacyTradeWatcher }

func (p *legacyTradePush) init(ctx context.Context) map[string]any {
	return map[string]any{"trade": p.watcher.snapshot(ctx)}
}

func (p *legacyTradePush) poll(ctx context.Context) []string { return p.watcher.poll(ctx) }

// legacyMarketPush projects market activity: mktTrade per fill (plus an
// authoritative assets snapshot for the seller, who may not be on the market
// page) and one marketDelta per listing revision bump.
type legacyMarketPush struct {
	api     *API
	owner   int64
	catalog *rules.Catalog

	revision   int64
	fillCursor int64
	seeded     bool
}

func (p *legacyMarketPush) init(ctx context.Context) map[string]any {
	revision, err := p.api.legacyMarketRevision(ctx)
	if err != nil {
		return nil
	}
	p.revision, p.seeded = revision, true
	_ = p.api.pool.QueryRow(ctx, `SELECT COALESCE(max(f.operation_id),0) FROM fishing.market_fills f JOIN fishing.market_orders o ON o.id=f.order_id WHERE f.buyer_id=$1 OR o.seller_id=$1`, p.owner).
		Scan(&p.fillCursor)
	return map[string]any{"marketRevision": revision, "marketTotal": p.api.legacyMarketListed(ctx)}
}

func (p *legacyMarketPush) poll(ctx context.Context) []string {
	revision, err := p.api.legacyMarketRevision(ctx)
	if err != nil {
		return nil
	}
	if !p.seeded {
		p.revision, p.seeded = revision, true
		return nil
	}
	if revision == p.revision {
		return nil
	}
	p.revision = revision
	frames := p.fillFrames(ctx)
	frames = append(frames, legacyFrame(map[string]any{
		"type": "marketDelta", "revision": revision, "total": p.api.legacyMarketListed(ctx),
	}))
	return frames
}

func (p *legacyMarketPush) fillFrames(ctx context.Context) []string {
	rows, err := p.api.pool.Query(ctx, `SELECT f.operation_id,f.order_id,f.quantity,f.total,f.tax,o.unit_price,o.kind,COALESCE(o.item_id,''),o.rod_name,
 f.buyer_id,lower(bi.username),bi.display_name,lower(si.username),si.display_name
 FROM fishing.market_fills f
 JOIN fishing.market_orders o ON o.id=f.order_id
 JOIN fishing.identities bi ON bi.account_id=f.buyer_id
 JOIN fishing.identities si ON si.account_id=o.seller_id
 WHERE f.operation_id>$1 AND (f.buyer_id=$2 OR o.seller_id=$2)
 ORDER BY f.operation_id LIMIT 16`, p.fillCursor, p.owner)
	if err != nil {
		return nil
	}
	type fill struct {
		operation, order, quantity, total, tax, price, buyerID            int64
		kind, itemID, rodName, buyerKey, buyerName, sellerKey, sellerName string
	}
	list := []fill{}
	orderIDs := []int64{}
	for rows.Next() {
		var f fill
		if err := rows.Scan(&f.operation, &f.order, &f.quantity, &f.total, &f.tax, &f.price, &f.kind, &f.itemID, &f.rodName,
			&f.buyerID, &f.buyerKey, &f.buyerName, &f.sellerKey, &f.sellerName); err != nil {
			rows.Close()
			return nil
		}
		list = append(list, f)
		orderIDs = append(orderIDs, f.order)
	}
	if rows.Err() != nil {
		rows.Close()
		return nil
	}
	rows.Close()
	parts, err := p.api.legacyEquipmentParts(ctx, orderIDs)
	if err != nil {
		parts = nil
	}
	frames := []string{}
	sellerPaid := false
	for _, f := range list {
		if f.operation > p.fillCursor {
			p.fillCursor = f.operation
		}
		id, name, _, _, _ := legacyOrderIdentity(p.catalog, f.kind, f.itemID, f.rodName, parts[f.order])
		role, other := "buy", f.sellerName
		if f.buyerID != p.owner {
			role, other = "sell", f.buyerName
			sellerPaid = true
		}
		frames = append(frames, legacyFrame(map[string]any{
			"type": "mktTrade", "t": timeNowMS(), "id": id, "name": name,
			"qty": f.quantity, "price": f.price, "total": f.total, "tax": f.tax,
			"sellerGain": f.total - f.tax, "role": role, "other": other,
			"buyer": f.buyerKey, "buyerName": f.buyerName,
			"seller": f.sellerKey, "sellerName": f.sellerName,
		}))
	}
	if sellerPaid {
		// The seller's coins/inventory changed server-side; push the authoritative
		// snapshot so the sale is visible without a reload.
		if frame, err := p.api.legacyAssetsFrame(ctx, p.owner); err == nil {
			frames = append(frames, frame)
		}
	}
	return frames
}

// legacyFriendPush projects reciprocal relationship changes onto the legacy
// "friends" refresh ping plus the request/accepted notices.
type legacyFriendPush struct {
	api    *API
	owner  int64
	cursor int64
	seeded bool
}

func (p *legacyFriendPush) init(ctx context.Context) map[string]any { return nil }

func (p *legacyFriendPush) poll(ctx context.Context) []string {
	if !p.seeded {
		var cursor int64
		_ = p.api.pool.QueryRow(ctx, `SELECT COALESCE(max(updated_operation),0) FROM fishing.friend_relations WHERE a_id=$1 OR b_id=$1`, p.owner).Scan(&cursor)
		p.cursor, p.seeded = cursor, true
		return nil
	}
	rows, err := p.api.pool.Query(ctx, `SELECT r.requester_id,r.state,r.updated_operation,lower(i.username),i.display_name
 FROM fishing.friend_relations r
 JOIN fishing.identities i ON i.account_id=CASE WHEN r.a_id=$1 THEN r.b_id ELSE r.a_id END
 WHERE (r.a_id=$1 OR r.b_id=$1) AND r.updated_operation>$2
 ORDER BY r.updated_operation LIMIT 16`, p.owner, p.cursor)
	if err != nil {
		return nil
	}
	type relation struct {
		requester, operation int64
		state, key, name     string
	}
	list := []relation{}
	for rows.Next() {
		var rel relation
		if err := rows.Scan(&rel.requester, &rel.state, &rel.operation, &rel.key, &rel.name); err != nil {
			rows.Close()
			return nil
		}
		list = append(list, rel)
	}
	if rows.Err() != nil {
		rows.Close()
		return nil
	}
	rows.Close()
	frames := []string{}
	for _, rel := range list {
		if rel.operation > p.cursor {
			p.cursor = rel.operation
		}
		notice := ""
		switch {
		case rel.state == "pending" && rel.requester != p.owner:
			notice = "👥 " + rel.name + "（@" + rel.key + "）请求加你为好友，到「社交 · 好友」处理。"
		case rel.state == "accepted" && rel.requester == p.owner:
			notice = "✅ " + rel.name + "（@" + rel.key + "）已同意你的好友请求，你们现在是好友了。"
		}
		frames = append(frames, legacyFrame(map[string]any{"type": "friends"}))
		if notice != "" {
			frames = append(frames, legacyFrame(map[string]any{"type": "notice", "msg": notice}))
		}
	}
	return frames
}

// legacyPlayersPush replays the original viewport push: only a connection whose
// owner registered a viewport through POST /api/players/view receives
// playersPage, and only when the projected page actually changed.
type legacyPlayersPush struct {
	api     *API
	owner   int64
	catalog *rules.Catalog
	last    string
}

func (p *legacyPlayersPush) init(ctx context.Context) map[string]any { return nil }

func (p *legacyPlayersPush) poll(ctx context.Context) []string {
	view, ok := p.api.legacyViewport(p.owner)
	if !ok {
		return nil
	}
	payload, err := p.api.legacyPlayersPayload(ctx, p.catalog, view)
	if err != nil {
		return nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil || string(encoded) == p.last {
		return nil
	}
	p.last = string(encoded)
	return []string{legacyFrame(map[string]any{
		"type": "playersPage", "page": payload["page"], "pages": payload["pages"],
		"total": payload["total"], "players": payload["players"],
	})}
}

// legacyAssetsFrame rebuilds the authoritative assets event for one player.
func (a *API) legacyAssetsFrame(ctx context.Context, owner int64) (string, error) {
	inventory, bigfish, err := a.legacyInventory(ctx, owner)
	if err != nil {
		return "", err
	}
	var coins, revision, catchCount int64
	if err := a.pool.QueryRow(ctx, `SELECT w.coins,p.assets_rev,p.catch_count FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, owner).
		Scan(&coins, &revision, &catchCount); err != nil {
		return "", identity.ErrStorage
	}
	return legacyFrame(map[string]any{
		"type": "assets", "coins": coins, "inventory": inventory, "bigfish": bigfish,
		"invRev": strconv.FormatInt(revision, 10), "catchCount": catchCount,
	}), nil
}

// legacyMarketListed counts the open listings the marketTotal field reports.
func (a *API) legacyMarketListed(ctx context.Context) int64 {
	var listed int64
	_ = a.pool.QueryRow(ctx, `SELECT count(*) FROM fishing.market_orders WHERE state='open' AND expires_at>clock_timestamp()`).Scan(&listed)
	return listed
}
