package gateway

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/rules"
)

// Legacy market bridge. The durable market module owns orders, escrow, listing
// fees and tax; the original frontend expects the flat MarketPage shape, the
// data.js item identity and the legacy Chinese rejection text.
//
// Whole rods are the delicate part. A durable order stores escrowed equipment
// rows (market_order_equipment), not the legacy identifier, so the
// "rodset:part=sig;..." identity is rebuilt from the escrowed components in
// data.js ROD_PARTS order. Components keep one durable instance per item, so a
// legacy "list N of the same signature" turns into one durable order per
// instance; each order charges its own listing fee (ceil per unit instead of
// ceil of the legacy lump sum, so the total can differ by at most N-1 coins).

var legacyMarketPageParam = regexp.MustCompile(`^[1-9]\d*$`)

var legacyMarketKinds = map[string]bool{"all": true, "fish": true, "material": true, "component": true, "rod": true, "chest": true}
var legacyMarketAffixes = map[string]bool{"speed": true, "skill": true, "rare": true, "material": true, "size": true, "double": true}

var legacyMarketSequence uint64

// legacyMarketKey keeps the legacy "no idempotency" behaviour while still
// giving every bridge command a unique request key.
func legacyMarketKey(prefix string) string {
	return prefix + ":" + strconv.FormatInt(timeNowMS(), 10) + ":" + strconv.FormatUint(atomic.AddUint64(&legacyMarketSequence, 1), 10)
}

// legacyMarketListing is the public listing projection (MarketPage.publicListing).
type legacyMarketListing struct {
	LID        int64  `json:"lid"`
	Seller     string `json:"seller"`
	SellerName string `json:"sellerName"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	Qty        int64  `json:"qty"`
	Price      int64  `json:"price"`
	T          int64  `json:"t"`
	ExpireAt   int64  `json:"expireAt"`
	Hours      int    `json:"hours"`
}

// legacyMarketItem carries the display identity used by the market filters.
type legacyMarketItem struct {
	Listing legacyMarketListing
	Kind    string
	Part    string
	Affixes []rules.MetaAffix
	Search  string
}

type legacyMarketQuery struct {
	Page                int
	Size                int
	Scope, Kind, Part   string
	Q, Affix, Sort, Dir string
	minV, maxV          float64
	hasMin, hasMax      bool
}

func legacyMarketError(w http.ResponseWriter, message string) {
	write(w, 400, map[string]any{"error": message, "code": "invalid_input"})
}

// optionalSession resolves the viewer without failing anonymous requests. The
// legacy page only needs the viewer for scope=mine and the mineCount badge.
func (a *API) optionalSession(r *http.Request) (identity.Session, error) {
	value := token(r, false)
	if value == "" {
		return identity.Session{}, identity.ErrCredentials
	}
	return a.identity.Authenticate(r.Context(), value, false)
}

func parseLegacyMarketQuery(values url.Values, viewer string) (legacyMarketQuery, string) {
	q := legacyMarketQuery{Page: 1, Size: 30, Scope: "all", Kind: "all", Part: "all", Affix: "all", Sort: "time", Dir: "desc"}
	allowed := map[string]bool{"page": true, "size": true, "scope": true, "kind": true, "part": true, "q": true, "affix": true, "sort": true, "dir": true, "min": true, "max": true}
	for key := range values {
		if !allowed[key] {
			return q, "未知市集查询参数"
		}
	}
	text := func(key, fallback string) (string, string) {
		list, ok := values[key]
		if !ok {
			return fallback, ""
		}
		if len(list) != 1 || len(list[0]) > 100 {
			return "", "市集查询参数无效"
		}
		return list[0], ""
	}
	integer := func(key string, fallback, max int) (int, string) {
		value, message := text(key, strconv.Itoa(fallback))
		if message != "" {
			return 0, message
		}
		if !legacyMarketPageParam.MatchString(value) {
			return 0, "市集分页参数无效"
		}
		number, err := strconv.Atoi(value)
		if err != nil || number > max {
			return 0, "市集分页参数无效"
		}
		return number, ""
	}
	var message string
	if q.Page, message = integer("page", 1, 10000000); message != "" {
		return q, message
	}
	if q.Size, message = integer("size", 30, 100); message != "" {
		return q, message
	}
	for _, field := range []struct {
		key      string
		fallback string
		target   *string
	}{{"scope", "all", &q.Scope}, {"kind", "all", &q.Kind}, {"part", "all", &q.Part}} {
		if *field.target, message = text(field.key, field.fallback); message != "" {
			return q, message
		}
	}
	if q.Q, message = text("q", ""); message != "" {
		return q, message
	}
	q.Q = strings.ToLower(strings.TrimSpace(q.Q))
	if q.Affix, message = text("affix", "all"); message != "" {
		return q, message
	}
	if q.Sort, message = text("sort", "time"); message != "" {
		return q, message
	}
	if q.Dir, message = text("dir", "desc"); message != "" {
		return q, message
	}
	if (q.Scope != "all" && q.Scope != "mine" && q.Scope != "others") ||
		(q.Sort != "time" && q.Sort != "price" && q.Sort != "qty" && q.Sort != "affix") ||
		(q.Dir != "asc" && q.Dir != "desc") {
		return q, "市集筛选参数无效"
	}
	if !legacyMarketKinds[q.Kind] || (q.Part != "all" && !legacyMarketParts.has(q.Part)) || (q.Affix != "all" && !legacyMarketAffixes[q.Affix]) {
		return q, "市集分类或词条无效"
	}
	if q.Scope == "mine" && viewer == "" {
		return q, "查看我的挂单需登录"
	}
	minRaw, message := text("min", "")
	if message != "" {
		return q, message
	}
	maxRaw, message := text("max", "")
	if message != "" {
		return q, message
	}
	if minRaw != "" {
		value, err := strconv.ParseFloat(strings.TrimSpace(minRaw), 64)
		if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
			return q, "词条范围无效"
		}
		q.minV, q.hasMin = value, true
	}
	if maxRaw != "" {
		value, err := strconv.ParseFloat(strings.TrimSpace(maxRaw), 64)
		if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
			return q, "词条范围无效"
		}
		q.maxV, q.hasMax = value, true
	}
	if q.hasMin && q.hasMax && q.minV > q.maxV {
		return q, "词条范围无效"
	}
	return q, ""
}

// legacyMarketParts mirrors data.js ROD_PARTS for query validation only.
var legacyMarketParts = partSet{keys: rodPartOrder}

type partSet struct{ keys []string }

func (p partSet) has(key string) bool {
	for _, candidate := range p.keys {
		if candidate == key {
			return true
		}
	}
	return false
}

// legacyOrderIdentity rebuilds the data.js item identity of one durable order.
func legacyOrderIdentity(c *rules.Catalog, kind, itemID, rodName string, parts map[string]string) (id, name, itemKind, part string, affixes []rules.MetaAffix) {
	switch kind {
	case "stack":
		if def, ok := c.Item(itemID); ok {
			return def.ID, def.Name, def.Kind, "", nil
		}
		return itemID, itemID, "unknown", "", nil
	case "equipment":
		partName, signature := "", ""
		for key, value := range parts {
			if signature == "" || key < partName {
				partName, signature = key, value
			}
		}
		meta, ok := c.ComponentMeta(signature)
		if !ok {
			return signature, "未知组件", "unknown", "", nil
		}
		return meta.ID, meta.Name, "component", meta.Part, meta.Affixes
	case "rod":
		segs := []string{}
		count := 0
		aggregate := map[string]float64{}
		types := []string{}
		for _, order := range rodPartOrder {
			signature, ok := parts[order]
			if !ok || signature == "" {
				continue
			}
			segs = append(segs, order+"="+signature)
			count++
			meta, ok := c.ComponentMeta(signature)
			if !ok {
				continue
			}
			for _, affix := range meta.Affixes {
				if _, seen := aggregate[affix.Type]; !seen {
					types = append(types, affix.Type)
				}
				aggregate[affix.Type] += affix.Value
			}
		}
		label := "整根钓竿（" + strconv.Itoa(count) + " 件）"
		if rodName != "" {
			label = rodName + " · " + label
		}
		sort.Strings(types)
		for _, affixType := range types {
			affixes = append(affixes, rules.MetaAffix{Type: affixType, Value: aggregate[affixType]})
		}
		return "rodset:" + strings.Join(segs, ";"), label, "rod", "", affixes
	}
	return itemID, itemID, "unknown", "", nil
}

func (a *API) legacyEquipmentParts(ctx context.Context, orderIDs []int64) (map[int64]map[string]string, error) {
	parts := map[int64]map[string]string{}
	if len(orderIDs) == 0 {
		return parts, nil
	}
	rows, err := a.pool.Query(ctx, `SELECT mo.order_id,mo.part,i.attributes->>'signature' FROM fishing.market_order_equipment mo JOIN fishing.equipment_instances i ON i.id=mo.equipment_id WHERE mo.order_id=ANY($1)`, orderIDs)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	for rows.Next() {
		var orderID int64
		var part, signature string
		if err := rows.Scan(&orderID, &part, &signature); err != nil {
			return nil, identity.ErrStorage
		}
		if parts[orderID] == nil {
			parts[orderID] = map[string]string{}
		}
		parts[orderID][part] = signature
	}
	if err := rows.Err(); err != nil {
		return nil, identity.ErrStorage
	}
	return parts, nil
}

// legacyMarketItems loads open orders (optionally a subset) as legacy items.
func (a *API) legacyMarketItems(ctx context.Context, c *rules.Catalog, orderIDs []int64) ([]legacyMarketItem, error) {
	statement := `SELECT o.id,o.kind,COALESCE(o.item_id,''),o.remaining,o.unit_price,o.rod_name,o.hours,
 (1000*extract(epoch from o.created_at))::bigint,(1000*extract(epoch from o.expires_at))::bigint,i.username,i.display_name
 FROM fishing.market_orders o JOIN fishing.identities i ON i.account_id=o.seller_id
 WHERE o.state='open' AND o.expires_at>clock_timestamp()`
	args := []any{}
	if len(orderIDs) > 0 {
		statement += ` AND o.id=ANY($1)`
		args = append(args, orderIDs)
	}
	statement += ` ORDER BY o.id`
	rows, err := a.pool.Query(ctx, statement, args...)
	if err != nil {
		return nil, identity.ErrStorage
	}
	type rawOrder struct {
		id, remaining, price, created, expires int64
		kind, itemID, rodName, username, name  string
		hours                                  int
	}
	list := []rawOrder{}
	ids := []int64{}
	for rows.Next() {
		var order rawOrder
		if err := rows.Scan(&order.id, &order.kind, &order.itemID, &order.remaining, &order.price, &order.rodName, &order.hours, &order.created, &order.expires, &order.username, &order.name); err != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		list = append(list, order)
		ids = append(ids, order.id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()
	parts, err := a.legacyEquipmentParts(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]legacyMarketItem, 0, len(list))
	for _, order := range list {
		listing := legacyMarketListing{
			LID: order.id, Seller: order.username, SellerName: order.name,
			Qty: order.remaining, Price: order.price, T: order.created,
			ExpireAt: order.expires, Hours: order.hours,
		}
		id, name, kind, part, affixes := legacyOrderIdentity(c, order.kind, order.itemID, order.rodName, parts[order.id])
		listing.ID, listing.Name = id, name
		out = append(out, legacyMarketItem{
			Listing: listing, Kind: kind, Part: part, Affixes: affixes,
			Search: strings.ToLower(name + " " + order.name + " " + order.username),
		})
	}
	return out, nil
}

// legacyMarketRevision exposes a monotonic market watermark built from the
// durable activity so a stale page response cannot mark a fresh query cached.
func (a *API) legacyMarketRevision(ctx context.Context) (int64, error) {
	var revision int64
	err := a.pool.QueryRow(ctx, `SELECT COALESCE(max(op),0) FROM (
 SELECT max(created_operation) AS op FROM fishing.market_orders
 UNION ALL SELECT max(closed_operation) FROM fishing.market_orders
 UNION ALL SELECT max(operation_id) FROM fishing.market_fills) AS activity`).Scan(&revision)
	if err != nil {
		return 0, identity.ErrStorage
	}
	return revision, nil
}

func legacyMarketValue(item legacyMarketItem, query legacyMarketQuery) float64 {
	if query.Sort != "affix" {
		switch query.Sort {
		case "time":
			return float64(item.Listing.T)
		case "price":
			return float64(item.Listing.Price)
		case "qty":
			return float64(item.Listing.Qty)
		}
		return 0
	}
	if query.Affix != "all" {
		for _, affix := range item.Affixes {
			if affix.Type == query.Affix {
				return affix.Value
			}
		}
		return -1e9
	}
	if len(item.Affixes) == 0 {
		return -1e9
	}
	sum := 0.0
	for _, affix := range item.Affixes {
		sum += affix.Value
	}
	return sum
}

func legacyMarketLess(left, right legacyMarketItem, query legacyMarketQuery) bool {
	sign := 1.0
	if query.Dir != "asc" {
		sign = -1
	}
	if delta := (legacyMarketValue(left, query) - legacyMarketValue(right, query)) * sign; delta != 0 {
		return delta < 0
	}
	if left.Listing.T != right.Listing.T {
		return left.Listing.T > right.Listing.T
	}
	return left.Listing.LID > right.Listing.LID
}

func legacyMarketAffixMatch(item legacyMarketItem, query legacyMarketQuery) bool {
	for _, affix := range item.Affixes {
		if query.Affix != "all" && affix.Type != query.Affix {
			continue
		}
		if query.hasMin && affix.Value < query.minV {
			continue
		}
		if query.hasMax && affix.Value > query.maxV {
			continue
		}
		return true
	}
	return false
}

// legacyMarket serves GET /api/market: the public listing page.
func (a *API) legacyMarket(w http.ResponseWriter, r *http.Request) {
	viewer := ""
	if session, err := a.optionalSession(r); err == nil {
		viewer = session.Username
	}
	query, message := parseLegacyMarketQuery(r.URL.Query(), viewer)
	if message != "" {
		legacyMarketError(w, message)
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	items, err := a.legacyMarketItems(r.Context(), c, nil)
	if err != nil {
		failure(w, err)
		return
	}
	selected := make([]legacyMarketItem, 0, len(items))
	mineCount := 0
	for _, item := range items {
		if viewer != "" && item.Listing.Seller == viewer {
			mineCount++
		}
		switch query.Scope {
		case "mine":
			if item.Listing.Seller != viewer {
				continue
			}
		case "others":
			if viewer != "" && item.Listing.Seller == viewer {
				continue
			}
		}
		selected = append(selected, item)
	}
	counts := map[string]int{"all": len(selected)}
	parts := map[string]int{}
	for _, item := range selected {
		counts[item.Kind]++
		if item.Kind == "component" && item.Part != "" {
			parts[item.Part]++
		}
	}
	filtered := make([]legacyMarketItem, 0, len(selected))
	for _, item := range selected {
		if query.Kind != "all" && item.Kind != query.Kind {
			continue
		}
		if query.Kind == "component" && query.Part != "all" && item.Part != query.Part {
			continue
		}
		if query.Q != "" && !strings.Contains(item.Search, query.Q) {
			continue
		}
		if query.Affix != "all" || query.hasMin || query.hasMax {
			if !legacyMarketAffixMatch(item, query) {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return legacyMarketLess(filtered[i], filtered[j], query) })
	total := len(filtered)
	pages := 1
	if total > 0 {
		pages = (total + query.Size - 1) / query.Size
	}
	current := query.Page
	if current > pages {
		current = pages
	}
	start := (current - 1) * query.Size
	if start > total {
		start = total
	}
	end := start + query.Size
	if end > total {
		end = total
	}
	listings := make([]legacyMarketListing, 0, end-start)
	for _, item := range filtered[start:end] {
		listings = append(listings, item.Listing)
	}
	revision, err := a.legacyMarketRevision(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{
		"listings": listings, "page": current, "pages": pages, "size": query.Size,
		"total": total, "mineCount": mineCount, "marketTotal": len(items),
		"counts": counts, "parts": parts, "revision": revision,
	})
}

// legacyMarketSnapshot is the legacy asset/rod snapshot every market write
// echoes back so the client can paint immediately.
func (a *API) legacyMarketSnapshot(r *http.Request, c *rules.Catalog, session identity.Session) (map[string]any, error) {
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"coins": profile["coins"], "inventory": profile["inventory"], "invRev": profile["invRev"], "rewardBindings": profile["rewardBindings"],
		"rodSlots": profile["rodSlots"], "rodSlotsCount": profile["rodSlotsCount"],
		"rodActiveSlot": profile["rodActiveSlot"], "rodLocked": profile["rodLocked"],
		"rodName": profile["rodName"], "nextRodSlotPrice": profile["nextRodSlotPrice"],
	}, nil
}

func (a *API) rodSlotCapacity(ctx context.Context, owner int64) int {
	var capacity int
	if err := a.pool.QueryRow(ctx, `SELECT rod_capacity FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&capacity); err != nil {
		return 1
	}
	return capacity
}

func (a *API) listingCapacity(ctx context.Context, owner int64) int {
	var capacity int
	if err := a.pool.QueryRow(ctx, `SELECT listing_capacity FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&capacity); err != nil {
		return 0
	}
	return capacity
}

// legacyFreeInstances lists up to limit free equipment instances of one
// signature, in durable id order.
func (a *API) legacyFreeInstances(ctx context.Context, owner int64, signature string, limit int64) ([]int64, error) {
	rows, err := a.pool.Query(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND NOT e.reward_bound AND e.attributes->>'signature'=$2
 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components rc WHERE rc.equipment_id=e.id)
 ORDER BY e.id LIMIT $3`, owner, signature, limit)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, identity.ErrStorage
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, identity.ErrStorage
	}
	return ids, nil
}

// legacyMarketWriteFailure reports a technical command failure. Business
// rejections never reach this path: the durable command boundary stores them as
// a terminal status (see legacyMarketStatusMessage).
func (a *API) legacyMarketWriteFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, assets.ErrInvalid):
		legacyMarketError(w, "请求参数无效")
	case errors.Is(err, assets.ErrUnauthenticated):
		failure(w, identity.ErrCredentials)
	case errors.Is(err, assets.ErrKeyConflict):
		legacyMarketError(w, "重复的请求编号")
	default:
		write(w, 503, map[string]any{"error": "retry_same_request"})
	}
}

// legacyMarketStatusMessage maps a durable market rejection onto the original
// frontend's Chinese text. total is the buyer-side amount used by the
// insufficient-funds message (0 when unknown).
func (a *API) legacyMarketStatusMessage(w http.ResponseWriter, r *http.Request, session identity.Session, status string, total int64) {
	switch status {
	case "listing_capacity":
		capacity := a.listingCapacity(r.Context(), session.AccountID)
		legacyMarketError(w, "挂单数量已达上限（同时最多 "+strconv.Itoa(capacity)+" 个，可在市集下架后再上架）")
	case "item_not_listable":
		legacyMarketError(w, "该物品不可上架")
	case "empty_rod":
		legacyMarketError(w, "该槽位没有已保存的钓竿")
	case "insufficient_funds":
		if total > 0 {
			legacyMarketError(w, "金币不足（需 "+strconv.FormatInt(total, 10)+"）")
		} else {
			legacyMarketError(w, "金币不足（上架费按定价总额与时长费率收取）")
		}
	case "equipment_unavailable", "equipment_locked":
		legacyMarketError(w, "该配件已锁定在钓竿上，请先卸下或删除对应钓竿")
	case "listing_not_found", "listing_closed", "listing_expired":
		write(w, 404, map[string]any{"error": "该挂单已不存在", "code": "listing_not_found"})
	case "not_listing_owner":
		write(w, 403, map[string]any{"error": "只能下架自己的挂单", "code": "not_listing_owner"})
	case "quantity_unavailable":
		legacyMarketError(w, "购买数量超过挂单数量")
	case "price_changed":
		legacyMarketError(w, "价格已变化，请刷新市集后重试")
	case "rod_capacity":
		capacity := a.rodSlotCapacity(r.Context(), session.AccountID)
		legacyMarketError(w, "钓竿槽位已满（"+strconv.Itoa(capacity)+"/"+strconv.Itoa(rodSlotMax)+"），请先购买槽位或清空一个槽位再购买整竿")
	case "feature_disabled":
		legacyMarketError(w, "该功能当前已关闭")
	default:
		legacyMarketError(w, status)
	}
}

// legacyMarketList serves POST /api/market/list for stacks, single components
// and whole rod slots.
func (a *API) legacyMarketList(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ID      *string `json:"id"`
		Qty     *int64  `json:"qty"`
		Price   *int64  `json:"price"`
		Hours   *int    `json:"hours"`
		RodSlot *int    `json:"rodSlot"`
	}
	if !decode(w, r, &in) {
		return
	}
	quantity := int64(1)
	if in.Qty != nil {
		if *in.Qty < 1 || *in.Qty > 10000 {
			legacyMarketError(w, "数量必须为 1～10000 的整数")
			return
		}
		quantity = *in.Qty
	}
	if in.ID != nil && len(*in.ID) == 0 {
		legacyMarketError(w, "物品格式错误")
		return
	}
	if in.Price == nil || *in.Price < 1 || *in.Price > 100000000 {
		legacyMarketError(w, "价格必须为 1～100000000 的整数")
		return
	}
	hours := 6
	if in.Hours != nil {
		if *in.Hours != 6 && *in.Hours != 12 && *in.Hours != 24 {
			legacyMarketError(w, "时长必须为 6、12 或 24")
			return
		}
		hours = *in.Hours
	}
	if in.RodSlot != nil && (*in.RodSlot < 0 || *in.RodSlot > 7) {
		legacyMarketError(w, "钓竿槽位必须为 0～7 的整数")
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	service := market.New(a.pool)
	created := []int64{}
	fee := int64(0)
	if in.RodSlot != nil {
		res, err := service.ListOrder(ctx, market.OrderRequest{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:market:list:rod"), RodSlot: in.RodSlot, UnitPrice: *in.Price, Hours: hours})
		if err != nil {
			a.legacyMarketWriteFailure(w, err)
			return
		}
		if res.Status != "listed" {
			a.legacyMarketStatusMessage(w, r, session, res.Status, 0)
			return
		}
		id, _ := strconv.ParseInt(res.ResourceID, 10, 64)
		created = append(created, id)
		fee += marketListingFee(*in.Price, hours)
	} else {
		if in.ID == nil {
			legacyMarketError(w, "该物品不可上架")
			return
		}
		if strings.HasPrefix(*in.ID, "rodset:") {
			legacyMarketError(w, "整根钓竿请在钓竿页选择槽位后上架")
			return
		}
		if _, _, _, isComponent := c.Instance(*in.ID); isComponent {
			instances, err := a.legacyFreeInstances(r.Context(), session.AccountID, *in.ID, quantity)
			if err != nil {
				failure(w, err)
				return
			}
			if int64(len(instances)) < quantity {
				legacyMarketError(w, "数量不足（组件可能已锁定在钓竿上，请先卸下或删除对应钓竿）")
				return
			}
			for _, equipmentID := range instances {
				res, err := service.ListOrder(ctx, market.OrderRequest{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:market:list:component"), EquipmentID: equipmentID, UnitPrice: *in.Price, Hours: hours})
				if err != nil {
					a.legacyMarketWriteFailure(w, err)
					return
				}
				if res.Status != "listed" {
					if len(created) > 0 {
						// The legacy contract has no partial-listing reply; report the
						// failure and let the client re-read /api/market.
						legacyMarketError(w, "部分上架失败，请刷新市集查看结果")
						return
					}
					a.legacyMarketStatusMessage(w, r, session, res.Status, 0)
					return
				}
				id, _ := strconv.ParseInt(res.ResourceID, 10, 64)
				created = append(created, id)
				fee += marketListingFee(*in.Price, hours)
			}
		} else {
			def, known := c.Item(*in.ID)
			if !known {
				legacyMarketError(w, "该物品不可上架")
				return
			}
			if def.Kind == "fish" {
				legacyMarketError(w, "鱼类暂时不能在市集上架（改版中：渔获请直接在商城·收购出售，大型/巨型鱼可按档位出售拿加成）")
				return
			}
			res, err := service.ListOrder(ctx, market.OrderRequest{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:market:list:stack"), ItemID: *in.ID, Quantity: quantity, UnitPrice: *in.Price, Hours: hours})
			if err != nil {
				a.legacyMarketWriteFailure(w, err)
				return
			}
			if res.Status != "listed" {
				a.legacyMarketStatusMessage(w, r, session, res.Status, 0)
				return
			}
			id, _ := strconv.ParseInt(res.ResourceID, 10, 64)
			created = append(created, id)
			fee += marketListingFee(*in.Price*quantity, hours)
		}
	}
	items, err := a.legacyMarketItems(r.Context(), c, created)
	if err != nil {
		failure(w, err)
		return
	}
	var listing any
	if len(items) > 0 {
		listing = items[0].Listing
	}
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	snapshot["ok"] = true
	snapshot["listing"] = listing
	snapshot["fee"] = fee
	write(w, 200, snapshot)
}

// marketListingFee mirrors the durable listing fee (ceil of total × rate).
func marketListingFee(total int64, hours int) int64 {
	rate := .01
	if hours == 12 {
		rate = .03
	} else if hours == 24 {
		rate = .05
	}
	return int64(math.Ceil(float64(total) * rate))
}

const rodSlotMax = 8

// legacyMarketBuy serves POST /api/market/buy, including partial fills and the
// whole-rod slot hand-off.
func (a *API) legacyMarketBuy(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		LID *int64 `json:"lid"`
		Qty *int64 `json:"qty"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Qty != nil && (*in.Qty < 1 || *in.Qty > 10000) {
		legacyMarketError(w, "数量必须为 1～10000 的整数")
		return
	}
	if in.LID == nil || *in.LID < 1 {
		write(w, 404, map[string]any{"error": "该挂单已不存在", "code": "listing_not_found"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	items, err := a.legacyMarketItems(r.Context(), c, []int64{*in.LID})
	if err != nil {
		failure(w, err)
		return
	}
	if len(items) == 0 {
		write(w, 404, map[string]any{"error": "该挂单已不存在", "code": "listing_not_found"})
		return
	}
	order := items[0]
	if order.Listing.Seller == session.Username {
		legacyMarketError(w, "不能购买自己的挂单")
		return
	}
	quantity := order.Listing.Qty
	if in.Qty != nil {
		quantity = *in.Qty
	}
	if quantity > order.Listing.Qty {
		legacyMarketError(w, "购买数量超过挂单数量")
		return
	}
	if order.Kind == "rod" && quantity != order.Listing.Qty {
		legacyMarketError(w, "整根钓竿只能整单购买")
		return
	}
	total := order.Listing.Price * quantity
	var coins int64
	_ = a.pool.QueryRow(r.Context(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins)
	if coins < total {
		legacyMarketError(w, "金币不足（需 "+strconv.FormatInt(total, 10)+"）")
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := market.New(a.pool).Fill(ctx, market.FillRequest{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:market:buy"), OrderID: *in.LID, Quantity: quantity, ExpectedUnitPrice: order.Listing.Price})
	if err != nil {
		a.legacyMarketWriteFailure(w, err)
		return
	}
	if res.Status != "purchased" {
		a.legacyMarketStatusMessage(w, r, session, res.Status, total)
		return
	}
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	snapshot["ok"] = true
	snapshot["qty"] = quantity
	snapshot["total"] = total
	snapshot["tax"] = int64(math.Ceil(float64(total) * .10))
	write(w, 200, snapshot)
}

// legacyMarketCancel serves POST /api/market/cancel.
func (a *API) legacyMarketCancel(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		LID *int64 `json:"lid"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.LID == nil || *in.LID < 1 {
		write(w, 404, map[string]any{"error": "该挂单已不存在", "code": "listing_not_found"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := market.New(a.pool).CloseOrder(ctx, session.AccountID, *in.LID, legacyMarketKey("legacy:market:cancel"), false)
	if err != nil {
		a.legacyMarketWriteFailure(w, err)
		return
	}
	if res.Status != "cancelled" && res.Status != "expired" {
		a.legacyMarketStatusMessage(w, r, session, res.Status, 0)
		return
	}
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	snapshot["ok"] = true
	write(w, 200, snapshot)
}

// legacyMarketHistory serves GET /api/market/history: the viewer's last 60
// market fills (buy and sell), rebuilt with the data.js item identity.
func (a *API) legacyMarketHistory(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	rows, err := a.pool.Query(r.Context(), `SELECT (1000*extract(epoch from f.created_at))::bigint,f.order_id,f.quantity,f.total,f.tax,
 o.unit_price,o.kind,COALESCE(o.item_id,''),o.rod_name,
 bi.username,bi.display_name,si.username,si.display_name
 FROM fishing.market_fills f
 JOIN fishing.market_orders o ON o.id=f.order_id
 JOIN fishing.identities bi ON bi.account_id=f.buyer_id
 JOIN fishing.identities si ON si.account_id=o.seller_id
 WHERE f.buyer_id=$1 OR o.seller_id=$1
 ORDER BY f.created_at DESC,f.operation_id DESC LIMIT 60`, session.AccountID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	type rawFill struct {
		created, orderID, quantity, total, tax, price int64
		kind, itemID, rodName                         string
		buyer, buyerName, seller, sellerName          string
	}
	list := []rawFill{}
	orderIDs := []int64{}
	for rows.Next() {
		var fill rawFill
		if err := rows.Scan(&fill.created, &fill.orderID, &fill.quantity, &fill.total, &fill.tax, &fill.price, &fill.kind, &fill.itemID, &fill.rodName, &fill.buyer, &fill.buyerName, &fill.seller, &fill.sellerName); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		list = append(list, fill)
		orderIDs = append(orderIDs, fill.orderID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()
	parts, err := a.legacyEquipmentParts(r.Context(), orderIDs)
	if err != nil {
		failure(w, err)
		return
	}
	trades := make([]map[string]any, 0, len(list))
	for _, fill := range list {
		id, name, _, _, _ := legacyOrderIdentity(c, fill.kind, fill.itemID, fill.rodName, parts[fill.orderID])
		trades = append(trades, map[string]any{
			"t": fill.created, "buyer": fill.buyer, "buyerName": fill.buyerName,
			"seller": fill.seller, "sellerName": fill.sellerName,
			"id": id, "name": name, "qty": fill.quantity, "price": fill.price,
			"total": fill.total, "tax": fill.tax,
		})
	}
	var username string
	if err := a.pool.QueryRow(r.Context(), `SELECT username FROM fishing.identities WHERE account_id=$1`, session.AccountID).Scan(&username); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	imported, err := a.legacyImportedMarketHistory(r.Context(), username)
	if err != nil {
		failure(w, err)
		return
	}
	trades = append(trades, imported...)
	sort.SliceStable(trades, func(i, j int) bool { return rules.Number(trades[i]["t"]) > rules.Number(trades[j]["t"]) })
	if len(trades) > 60 {
		trades = trades[:60]
	}
	write(w, 200, map[string]any{"trades": trades})
}
