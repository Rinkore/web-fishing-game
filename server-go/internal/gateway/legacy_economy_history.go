package gateway

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

// History remains available after a catalog update makes a material unsellable.
// This quote is read-only; the economy module still enforces NoSell for trades.
func (a *API) legacyHistoryQuote(ctx context.Context, c *rules.Catalog, id string) (economy.PriceView, bool, error) {
	it, exists := c.Item(id)
	if !exists || (it.Kind != "fish" && it.Kind != "material") {
		return economy.PriceView{}, false, nil
	}
	var now time.Time
	var raw []byte
	if err := a.pool.QueryRow(ctx, `SELECT statement_timestamp(),COALESCE((SELECT state FROM fishing.economy_prices WHERE item_id=$1),'{}'::jsonb)`, id).Scan(&now, &raw); err != nil {
		return economy.PriceView{}, false, identity.ErrStorage
	}
	var state rules.SaleState
	if json.Unmarshal(raw, &state) != nil {
		return economy.PriceView{}, false, identity.ErrStorage
	}
	var priceState *rules.SaleState
	if state.LastMS != 0 {
		priceState = &state
	}
	base := c.EconomyBase(id, now.UnixMilli())
	price := rules.Price(it.Price, priceState, c.PriceOverrideFor(id, now.UnixMilli()), now.UnixMilli(), c.PriceDynamicsFor(id))
	if base == 0 && it.NoSell {
		price = 0
	}
	today := state.SoldToday
	if state.Day != now.UTC().Format("2006-01-02") {
		today = 0
	}
	return economy.PriceView{ID: id, Base: base, Price: price, SoldTotal: state.SoldTotal, SoldToday: today}, true, nil
}

func (a *API) legacyEconomicHistory(ctx context.Context, kind, id string, limit int) ([]map[string]any, error) {
	rows, err := a.pool.Query(ctx, `SELECT payload FROM fishing.legacy_economy_history WHERE kind=$1 AND item_id=$2 ORDER BY occurred_at DESC,ordinal DESC LIMIT $3`, kind, id, limit)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var raw []byte
		var v map[string]any
		if rows.Scan(&raw) != nil || json.Unmarshal(raw, &v) != nil {
			return nil, identity.ErrStorage
		}
		out = append(out, v)
	}
	if rows.Err() != nil {
		return nil, identity.ErrStorage
	}
	return out, nil
}

func (a *API) legacyImportedMarketHistory(ctx context.Context, username string) ([]map[string]any, error) {
	rows, err := a.pool.Query(ctx, `SELECT payload FROM fishing.legacy_economy_history WHERE kind='market' AND (lower(payload->>'buyer')=$1 OR lower(payload->>'seller')=$1) ORDER BY occurred_at DESC,ordinal DESC LIMIT 60`, username)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var raw []byte
		var v map[string]any
		if rows.Scan(&raw) != nil || json.Unmarshal(raw, &v) != nil {
			return nil, identity.ErrStorage
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a *API) legacyEconomyConsole(ctx context.Context, c *rules.Catalog) (map[string]any, error) {
	prices, err := economy.New(a.pool, c).Prices(ctx)
	if err != nil {
		return nil, err
	}
	items := []map[string]any{}
	now := time.Now().UnixMilli()
	for _, p := range prices {
		it, _ := c.Item(p.ID)
		tier := c.FishTier(p.ID)
		if it.Kind == "material" {
			tier = "material"
		}
		row := map[string]any{"id": p.ID, "name": it.Name, "kind": it.Kind, "tier": tier, "base": p.Base, "price": p.Price, "soldToday": p.SoldToday, "soldTotal": p.SoldTotal, "m": math.Round(p.Price / p.Base * 100)}
		o := c.PriceOverrideFor(p.ID, now)
		if o.Base > 0 || o.Multiplier > 0 {
			row["ov"] = map[string]any{"base": o.Base, "m": o.Multiplier, "until": o.UntilMS}
		}
		items = append(items, row)
	}
	log, err := a.legacyEconomicHistory(ctx, "audit", "", 200)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(log)-1; i < j; i, j = i+1, j-1 {
		log[i], log[j] = log[j], log[i]
	}
	return map[string]any{"economyCatalog": items, "economyLog": log}, nil
}

func applyLegacyPriceOverride(c *rules.Catalog, raw json.RawMessage, now int64) error {
	var patch struct {
		ID         string   `json:"id"`
		Clear      bool     `json:"clear"`
		Base       *float64 `json:"base"`
		Multiplier *float64 `json:"m"`
		Minutes    *float64 `json:"untilMin"`
	}
	if json.Unmarshal(raw, &patch) != nil {
		return identity.ErrInvalid
	}
	it, ok := c.Item(patch.ID)
	if !ok || (it.Kind != "fish" && it.Kind != "material") {
		return identity.ErrInvalid
	}
	if c.Runtime == nil {
		c.Runtime = map[string]any{}
	}
	all, _ := c.Runtime["priceOverrides"].(map[string]any)
	if all == nil {
		all = map[string]any{}
	}
	if patch.Clear {
		delete(all, patch.ID)
	} else {
		v := map[string]any{}
		if patch.Base != nil {
			n := *patch.Base
			if math.IsNaN(n) || math.IsInf(n, 0) || n < 1 || n > 1e9 {
				return identity.ErrInvalid
			}
			v["base"] = math.Round(n)
		}
		if patch.Multiplier != nil {
			n := *patch.Multiplier
			if math.IsNaN(n) || math.IsInf(n, 0) || n < .05 || n > 10 {
				return identity.ErrInvalid
			}
			v["m"] = n
		}
		if patch.Minutes != nil {
			n := *patch.Minutes
			if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 525600 {
				return identity.ErrInvalid
			}
			if n > 0 {
				v["until"] = float64(now) + n*60000
			}
		}
		if len(v) == 0 {
			return identity.ErrInvalid
		}
		all[patch.ID] = v
	}
	c.Runtime["priceOverrides"] = all
	return nil
}
