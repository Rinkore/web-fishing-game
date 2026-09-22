package gateway

import (
	"math"
	"net/http"
	"sort"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

// Legacy autosell bridge. The durable module stores {includeTiers, rules};
// the legacy client speaks {items, tier} with toggle/bulk/remove deltas.

func (a *API) legacyAutoSell(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	svc := economy.New(a.pool, c)
	cfg, err := svc.Settings(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	plan := a.legacyAutoSellPlan(r, c, session.AccountID, cfg)
	write(w, 200, map[string]any{"ok": true, "items": cfg.Rules, "batch": legacyAutoSellBatch(c), "tier": cfg.IncludeTiers, "plan": plan})
}

func legacyAutoSellBatch(c *rules.Catalog) int64 {
	if c != nil {
		if n, ok := c.Runtime["autoSellBatch"].(float64); ok && n >= 1 && n <= 10000 {
			return int64(n)
		}
	}
	return 100
}

// legacyAutoSellPlan rebuilds the read-only preview the legacy right rail uses.
func (a *API) legacyAutoSellPlan(r *http.Request, c *rules.Catalog, owner int64, cfg economy.Settings) map[string]any {
	plan := map[string]any{"pool": int64(0), "blocked": int64(0), "batch": legacyAutoSellBatch(c), "ready": 0, "items": map[string]any{}}
	prices, err := economy.New(a.pool, c).Prices(r.Context())
	if err != nil {
		return plan
	}
	priceOf := map[string]float64{}
	for _, p := range prices {
		priceOf[p.ID] = p.Price
	}
	items := map[string]any{}
	var pool, blocked int64
	for id, rule := range cfg.Rules {
		if !rule.On {
			continue
		}
		def, ok := c.Item(id)
		if !ok || (def.Kind != "fish" && def.Kind != "material") {
			continue
		}
		var normal, large, giant int64
		if err := a.pool.QueryRow(r.Context(), `SELECT COALESCE(sum(quantity) FILTER(WHERE tier='normal'),0)::bigint,COALESCE(sum(quantity) FILTER(WHERE tier='large'),0)::bigint,COALESCE(sum(quantity) FILTER(WHERE tier='giant'),0)::bigint FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2`, owner, id).Scan(&normal, &large, &giant); err != nil {
			continue
		}
		have := normal
		if cfg.IncludeTiers {
			have += large + giant
		}
		keep := int64(math.Floor(rules.Number(rule.Keep)))
		if keep < 0 {
			keep = 0
		}
		excess := have - keep
		if excess <= 0 {
			continue
		}
		hit := rules.AutoSellHit(def.Price, priceOf[id], rule)
		if hit == "" {
			blocked += excess
			continue
		}
		pool += excess
		items[id] = map[string]any{"excess": excess, "keep": keep, "by": hit}
	}
	plan["pool"] = pool
	plan["blocked"] = blocked
	plan["ready"] = int64(len(items))
	plan["items"] = items
	return plan
}

func (a *API) legacyAutoSellSet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Tier       *bool    `json:"tier"`
		ID         string   `json:"id"`
		Scope      string   `json:"scope"`
		Bulk       string   `json:"bulk"`
		On         *bool    `json:"on"`
		Remove     bool     `json:"remove"`
		MinPct     *float64 `json:"minPct"`
		MinPrice   *float64 `json:"minPrice"`
		SlackPct   *float64 `json:"slackPct"`
		SlackPrice *float64 `json:"slackPrice"`
		Keep       *float64 `json:"keep"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	svc := economy.New(a.pool, c)
	cfg, err := svc.Settings(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	if cfg.Rules == nil {
		cfg.Rules = map[string]rules.AutoSellRule{}
	}

	// Tier-only request: flip the "also sell large/giant" switch.
	if in.Tier != nil && in.Bulk == "" && in.ID == "" && in.Scope == "" {
		cfg.IncludeTiers = *in.Tier
	} else {
		toggleOnly := in.MinPct == nil && in.MinPrice == nil && in.SlackPct == nil && in.SlackPrice == nil && in.Keep == nil
		ids := []string{}
		if in.Bulk != "" {
			switch in.Bulk {
			case "all":
				ids = a.autoSellEligibleIDs(c, "")
			case "fish", "material":
				ids = a.autoSellEligibleIDs(c, in.Bulk)
			default:
				failure(w, identity.ErrInvalid)
				return
			}
		} else {
			id := in.ID
			if id == "" {
				id = in.Scope
			}
			def, ok := c.Item(id)
			if !ok || (def.Kind != "fish" && def.Kind != "material") {
				failure(w, identity.ErrInvalid)
				return
			}
			ids = []string{id}
		}
		for _, id := range ids {
			if in.Remove {
				delete(cfg.Rules, id)
				continue
			}
			if toggleOnly {
				prev, exists := cfg.Rules[id]
				if !exists {
					continue
				}
				prev.On = in.On == nil || *in.On
				cfg.Rules[id] = prev
				continue
			}
			rule := rules.AutoSellRule{
				On:         in.On == nil || *in.On,
				MinPct:     in.MinPct,
				MinPrice:   in.MinPrice,
				SlackPct:   derefOr(in.SlackPct, 0),
				SlackPrice: derefOr(in.SlackPrice, 0),
				Keep:       derefOr(in.Keep, 0),
			}
			cfg.Rules[id] = rule
		}
	}

	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := svc.Configure(ctx, session.AccountID, "legacy:autosell:"+strconv.FormatInt(timeNowMS(), 10), cfg)
	if err != nil {
		failure(w, err)
		return
	}
	if res.Status != "configured" {
		assetResponse(w, res, nil)
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	shop := a.legacyShopSnapshot(r, c)
	write(w, 200, map[string]any{
		"ok": true, "items": cfg.Rules, "batch": legacyAutoSellBatch(c), "tier": cfg.IncludeTiers,
		"plan": a.legacyAutoSellPlan(r, c, session.AccountID, cfg), "sold": nil,
		"coins": profile["coins"], "inventory": profile["inventory"], "invRev": profile["invRev"], "shop": shop,
	})
}

func (a *API) legacyShopSnapshot(r *http.Request, c *rules.Catalog) map[string]any {
	out, _ := a.legacyShopData(r.Context(), c)
	if out == nil {
		out = map[string]any{}
	}
	return out
}

func (a *API) autoSellEligibleIDs(c *rules.Catalog, kind string) []string {
	ids := []string{}
	for _, it := range c.Items {
		if kind != "" && it.Kind != kind {
			continue
		}
		if it.Kind == "fish" || it.Kind == "material" {
			ids = append(ids, it.ID)
		}
	}
	sort.Strings(ids)
	return ids
}

func derefOr(v *float64, fallback float64) float64 {
	if v == nil {
		return fallback
	}
	return *v
}
