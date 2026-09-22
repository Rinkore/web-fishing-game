package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

type adminMarketInput struct {
	Token           string              `json:"token"`
	RequestKey      string              `json:"requestKey"`
	LID             json.RawMessage     `json:"lid"`
	OrderID         json.RawMessage     `json:"orderId"`
	Action          string              `json:"action"`
	Mode            string              `json:"mode"`
	Sellers         []string            `json:"sellers"`
	Seller          string              `json:"seller"`
	Batch           int                 `json:"batch"`
	IntervalSeconds int                 `json:"intervalSeconds"`
	Threshold       int                 `json:"threshold"`
	Target          int                 `json:"target"`
	Counts          map[string]int      `json:"counts"`
	Picks           map[string][]string `json:"picks"`
	Part            string              `json:"part"`
	Quality         map[string]float64  `json:"quality"`
	AffixMin        int                 `json:"affixMin"`
	AffixMax        int                 `json:"affixMax"`
	QtyMin          int                 `json:"qtyMin"`
	QtyMax          int                 `json:"qtyMax"`
	MulMin          float64             `json:"mulMin"`
	MulMax          float64             `json:"mulMax"`
	Hours           int                 `json:"hours"`
	DryRun          bool                `json:"dryRun"`
}

func parseAdminMarketID(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil && n > 0 {
		return n, true
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		n, err := strconv.ParseInt(strings.TrimSpace(text), 10, 64)
		return n, err == nil && n > 0
	}
	return 0, false
}

func adminMarketRequestKey(prefix, provided string) string {
	if strings.TrimSpace(provided) != "" {
		return strings.TrimSpace(provided)
	}
	return legacyMarketKey(prefix)
}

func adminMarketFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, assets.ErrInvalid):
		legacyMarketError(w, "请求参数无效")
	case errors.Is(err, assets.ErrUnauthenticated):
		failure(w, identity.ErrCredentials)
	case errors.Is(err, assets.ErrKeyConflict):
		legacyMarketError(w, "重复的请求编号")
	case errors.Is(err, assets.ErrCommitUnknown):
		write(w, 503, map[string]any{"error": "提交结果未知，请使用相同请求编号查询或重试"})
	default:
		write(w, 503, map[string]any{"error": "retry_same_request"})
	}
}

func (a *API) legacyAdminMarketReturn(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in adminMarketInput
	if !decode(w, r, &in) {
		return
	}
	id, valid := parseAdminMarketID(in.LID)
	if !valid {
		id, valid = parseAdminMarketID(in.OrderID)
	}
	if !valid {
		legacyMarketError(w, "挂单编号无效")
		return
	}
	key := adminMarketRequestKey("legacy:admin:market:return", in.RequestKey)
	marketService := market.New(a.pool)
	if _, err := marketService.ExpireOrders(r.Context(), 0); err != nil {
		adminMarketFailure(w, err)
		return
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := marketService.AdminReturn(ctx, market.AdminReturnRequest{ActorID: actor.AccountID, ActorName: actor.Name, RequestKey: key, OrderID: id})
	if err != nil {
		adminMarketFailure(w, err)
		return
	}
	if result.Status == "listing_not_found" {
		write(w, http.StatusNotFound, map[string]any{"error": "该挂单已不存在", "code": "listing_not_found"})
		return
	}
	if result.Status != "returned" {
		legacyMarketError(w, result.Status)
		return
	}
	var returned map[string]any
	if json.Unmarshal(result.Details, &returned) != nil {
		adminMarketFailure(w, assets.ErrUnavailable)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "returned": returned})
}

type marketSupplyRule struct {
	ID              string         `json:"id"`
	Enabled         bool           `json:"enabled"`
	Mode            string         `json:"mode"`
	Recipe          map[string]any `json:"recipe"`
	Batch           int            `json:"batch"`
	IntervalSeconds int            `json:"intervalSeconds"`
	Threshold       int            `json:"threshold"`
	Target          int            `json:"target"`
	Remaining       int            `json:"remaining"`
	RemainingCounts map[string]int `json:"remainingCounts"`
	Refilling       bool           `json:"refilling"`
	Created         int            `json:"created"`
	NextAt          int64          `json:"nextAt"`
	Error           string         `json:"error"`
	Stock           int            `json:"stock"`
}

func (a *API) readMarketSupply(ctx context.Context, q assets.SQL) (*marketSupplyRule, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key='market_supply'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rule marketSupplyRule
	if err := json.Unmarshal(raw, &rule); err != nil || rule.ID == "" {
		return nil, identity.ErrStorage
	}
	if rule.RemainingCounts == nil {
		rule.RemainingCounts = map[string]int{}
	}
	var stock int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM fishing.market_orders WHERE source='admin' AND supply_id=$1 AND state='open' AND remaining>0 AND expires_at>clock_timestamp()`, rule.ID).Scan(&stock); err != nil {
		return nil, err
	}
	rule.Stock = stock
	return &rule, nil
}

func (a *API) legacyAdminMarketSupplyGet(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	rule, err := a.readMarketSupply(r.Context(), a.pool)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, http.StatusOK, map[string]any{"rule": rule})
}

func (in adminMarketInput) bulkOptions() market.BulkOptions {
	return market.BulkOptions{Counts: in.Counts, Picks: in.Picks, Part: strings.TrimSpace(in.Part), Quality: in.Quality, AffixMin: in.AffixMin, AffixMax: in.AffixMax, QtyMin: in.QtyMin, QtyMax: in.QtyMax, MulMin: in.MulMin, MulMax: in.MulMax, Hours: in.Hours}
}

func (in adminMarketInput) recipe() map[string]any {
	recipe := map[string]any{"counts": in.Counts}
	if len(in.Sellers) > 0 {
		recipe["sellers"] = in.Sellers
	} else if strings.TrimSpace(in.Seller) != "" {
		recipe["seller"] = strings.TrimSpace(in.Seller)
	}
	if len(in.Picks) > 0 {
		recipe["picks"] = in.Picks
	}
	if in.Hours != 0 {
		recipe["hours"] = in.Hours
	}
	if in.Part != "" {
		recipe["part"] = in.Part
	}
	if len(in.Quality) > 0 {
		recipe["quality"] = in.Quality
	}
	for key, value := range map[string]int{"affixMin": in.AffixMin, "affixMax": in.AffixMax, "qtyMin": in.QtyMin, "qtyMax": in.QtyMax} {
		if value != 0 {
			recipe[key] = value
		}
	}
	for key, value := range map[string]float64{"mulMin": in.MulMin, "mulMax": in.MulMax} {
		if value != 0 {
			recipe[key] = value
		}
	}
	return recipe
}

func supplySellerInput(in adminMarketInput) []string {
	if len(in.Sellers) > 0 {
		return in.Sellers
	}
	if strings.TrimSpace(in.Seller) != "" {
		return []string{in.Seller}
	}
	return nil
}

func (a *API) adminMarketSellers(ctx context.Context, keys []string) ([]market.Seller, error) {
	if len(keys) < 1 || len(keys) > 100 {
		return nil, errors.New("seller_list")
	}
	normalized := []string{}
	seen := map[string]bool{}
	for _, raw := range keys {
		key := strings.ToLower(strings.TrimSpace(raw))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		normalized = append(normalized, key)
	}
	if len(normalized) < 1 {
		return nil, errors.New("seller_list")
	}
	rows, err := a.pool.Query(ctx, `SELECT lower(username),account_id,display_name,banned,retired FROM fishing.identities WHERE lower(username)=ANY($1::text[])`, normalized)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	byKey := map[string]market.Seller{}
	for rows.Next() {
		var seller market.Seller
		var banned, retired bool
		if err := rows.Scan(&seller.Key, &seller.ID, &seller.Name, &banned, &retired); err != nil {
			return nil, identity.ErrStorage
		}
		if banned || retired {
			continue
		}
		byKey[seller.Key] = seller
	}
	if err := rows.Err(); err != nil {
		return nil, identity.ErrStorage
	}
	out := make([]market.Seller, 0, len(normalized))
	for _, key := range normalized {
		seller, ok := byKey[key]
		if !ok {
			return nil, errors.New("seller_list")
		}
		out = append(out, seller)
	}
	return out, nil
}

func randomSupplyID() string {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "supply-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return "supply-" + hex.EncodeToString(raw[:])
}

func (a *API) legacyAdminMarketSupplyPost(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in adminMarketInput
	if !decode(w, r, &in) {
		return
	}
	key := adminMarketRequestKey("legacy:admin:market:supply", in.RequestKey)
	if in.Action != "pause" {
		if in.Mode != "gradual" && in.Mode != "restock" {
			legacyMarketError(w, "未知上架模式")
			return
		}
		if in.Batch < 1 || in.Batch > 500 || in.IntervalSeconds < 1 || in.IntervalSeconds > 86400 {
			legacyMarketError(w, "每批1~500条，间隔1~86400秒")
			return
		}
		if in.Mode == "restock" && (in.Threshold < 1 || in.Threshold > 5000 || in.Target < in.Threshold || in.Target > 5000) {
			legacyMarketError(w, "阈值与目标需为1~5000整数，目标不能小于阈值")
			return
		}
		if _, err := a.adminMarketSellers(r.Context(), supplySellerInput(in)); err != nil {
			legacyMarketError(w, "卖家名单无效")
			return
		}
		plan, err := market.BuildBulkPlan(mustCatalog(a, r.Context()), in.bulkOptions(), market.BulkSeed(key))
		if err != nil {
			legacyMarketError(w, err.Error())
			return
		}
		want := 0
		for _, n := range in.Counts {
			if n > 0 {
				want += n
			}
		}
		if len(plan.Items) != want {
			legacyMarketError(w, "选项包含不可生成的物品")
			return
		}
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := assets.New(a.pool).Run(ctx, assets.Command{ActorID: actor.AccountID, RequestKey: key, Kind: "admin_grant", RuleVersion: "admin-market-v1", Players: []int64{actor.AccountID}, Input: struct {
		Action string
		Body   adminMarketInput
	}{in.Action, in}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var rule *marketSupplyRule
		if in.Action == "pause" {
			current, err := a.readMarketSupply(ctx, t.SQL())
			if err != nil {
				return assets.Result{}, err
			}
			if current != nil {
				current.Enabled = false
				rule = current
				raw, _ := json.Marshal(current)
				if _, err := t.SQL().Exec(ctx, `UPDATE fishing.operator_settings SET value=$2,updated_at=clock_timestamp() WHERE key='market_supply'`, raw); err != nil {
					return assets.Result{}, err
				}
			}
		} else {
			plan, err := market.BuildBulkPlan(mustCatalog(a, ctx), in.bulkOptions(), market.BulkSeed(key))
			if err != nil {
				return assets.Result{}, assets.Rejection(err.Error())
			}
			counts := map[string]int{}
			for kind, n := range in.Counts {
				if n > 0 {
					counts[kind] = n
				}
			}
			rule = &marketSupplyRule{ID: randomSupplyID(), Enabled: true, Mode: in.Mode, Recipe: in.recipe(), Batch: in.Batch, IntervalSeconds: in.IntervalSeconds, Threshold: in.Threshold, Target: in.Target, Remaining: len(plan.Items), RemainingCounts: counts, NextAt: time.Now().Add(time.Duration(in.IntervalSeconds) * time.Second).UnixMilli()}
			raw, _ := json.Marshal(rule)
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES('market_supply',$1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, raw); err != nil {
				return assets.Result{}, err
			}
		}
		if err := legacyAdminAudit(ctx, t.SQL(), actor, "market/supply", nil, "market_supply", in.Action+" mode="+in.Mode); err != nil {
			return assets.Result{}, err
		}
		raw, _ := json.Marshal(map[string]any{"rule": rule})
		return assets.Result{Status: "updated", Details: raw}, nil
	})
	if err != nil {
		adminMarketFailure(w, err)
		return
	}
	if result.Status != "updated" {
		legacyMarketError(w, result.Status)
		return
	}
	var out struct {
		Rule *marketSupplyRule `json:"rule"`
	}
	if json.Unmarshal(result.Details, &out) != nil {
		adminMarketFailure(w, assets.ErrUnavailable)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "rule": out.Rule})
}

func mustCatalog(a *API, ctx context.Context) *rules.Catalog {
	c, err := a.catalog(ctx)
	if err != nil {
		return nil
	}
	return c
}

func (a *API) legacyAdminMarketBulk(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in adminMarketInput
	if !decode(w, r, &in) {
		return
	}
	keys := in.Sellers
	if len(keys) == 0 && strings.TrimSpace(in.Seller) != "" {
		keys = []string{in.Seller}
	}
	sellers, err := a.adminMarketSellers(r.Context(), keys)
	if err != nil {
		legacyMarketError(w, "请选择有效且未封禁的卖家名单（最多100人）")
		return
	}
	key := adminMarketRequestKey("legacy:admin:market:bulk", in.RequestKey)
	catalog, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	plan, err := market.BuildBulkPlan(catalog, in.bulkOptions(), market.BulkSeed(key))
	if err != nil {
		legacyMarketError(w, err.Error())
		return
	}
	first := sellers[0]
	if in.DryRun {
		write(w, http.StatusOK, map[string]any{"ok": true, "dryRun": true, "seller": map[string]any{"key": first.Key, "name": first.Name}, "count": len(plan.Items), "samples": bulkSamples(catalog, plan.Items), "totalValue": bulkTotal(plan.Items), "hours": plan.Hours, "mul": plan.Mul, "byKind": plan.ByKind})
		return
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := market.New(a.pool).AdminBulk(ctx, market.AdminBulkRequest{ActorID: actor.AccountID, ActorName: actor.Name, RequestKey: key, Sellers: sellers, Plan: plan})
	if err != nil {
		adminMarketFailure(w, err)
		return
	}
	if result.Status != "supplied" {
		legacyMarketError(w, result.Status)
		return
	}
	var detail struct {
		Created    []map[string]any `json:"created"`
		TotalValue int64            `json:"totalValue"`
		Hours      int              `json:"hours"`
		Mul        string           `json:"mul"`
		ByKind     map[string]int   `json:"byKind"`
	}
	if json.Unmarshal(result.Details, &detail) != nil {
		adminMarketFailure(w, assets.ErrUnavailable)
		return
	}
	samples := detail.Created
	if len(samples) > 8 {
		samples = samples[:8]
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "created": len(detail.Created), "hours": detail.Hours, "mul": detail.Mul, "byKind": detail.ByKind, "seller": map[string]any{"key": first.Key, "name": first.Name}, "samples": samples, "totalValue": detail.TotalValue})
}

func bulkSamples(c *rules.Catalog, items []market.BulkItem) []map[string]any {
	limit := len(items)
	if limit > 8 {
		limit = 8
	}
	out := make([]map[string]any, 0, limit)
	for _, item := range items[:limit] {
		quality := any(nil)
		affixN := 0
		if item.Kind == "component" && c != nil {
			if meta, ok := c.ComponentMeta(item.ID); ok {
				quality = meta.Quality
				affixN = len(meta.Affixes)
			}
		}
		out = append(out, map[string]any{"id": item.ID, "name": item.Name, "kind": item.Kind, "quality": quality, "affixN": affixN, "qty": item.Quantity, "price": item.Price})
	}
	return out
}

func bulkTotal(items []market.BulkItem) int64 {
	total := int64(0)
	for _, item := range items {
		if item.Quantity > 0 && item.Price <= assets.MaxCoins/item.Quantity {
			total += item.Quantity * item.Price
		}
	}
	return total
}
