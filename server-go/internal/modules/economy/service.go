package economy

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"sort"
	"strings"
	"time"
)

type Service struct {
	pool    *pgxpool.Pool
	assets  *assets.Service
	catalog *rules.Catalog
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service { return &Service{pool, assets.New(pool), c} }
func (s *Service) version() string                      { return s.catalog.Version + ":" + s.catalog.SourceSHA256 }
func (s *Service) economic(id string) bool {
	it, ok := s.catalog.Item(id)
	return ok && (it.Kind == "fish" || it.Kind == "material")
}

// Price rows are always acquired in sorted item order, after all player guards.
func lockPrices(ctx context.Context, t *assets.Transaction, ids []string) (map[string]rules.SaleState, error) {
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	out := map[string]rules.SaleState{}
	for _, id := range ids {
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.economy_prices(item_id) VALUES($1) ON CONFLICT DO NOTHING`, id); err != nil {
			return nil, err
		}
		var raw []byte
		if err := t.SQL().QueryRow(ctx, `SELECT state FROM fishing.economy_prices WHERE item_id=$1 FOR UPDATE`, id).Scan(&raw); err != nil {
			return nil, err
		}
		var st rules.SaleState
		if err := json.Unmarshal(raw, &st); err != nil {
			return nil, err
		}
		out[id] = st
	}
	return out, nil
}
func databaseTime(ctx context.Context, t *assets.Transaction) (int64, error) {
	var now time.Time
	err := t.SQL().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now)
	return now.UnixMilli(), err
}
func (s *Service) price(id string, st rules.SaleState, now int64) float64 {
	it, _ := s.catalog.Item(id)
	if st.LastMS == 0 {
		return it.Price
	}
	return rules.Price(it.Price, &st, rules.PriceOverride{}, now, s.catalog.PriceDynamicsFor(id))
}
func applyParts(ctx context.Context, t *assets.Transaction, owner int64, parts []rules.SalePart, states map[string]rules.SaleState, now int64, automatic bool, c *rules.Catalog) (assets.Result, error) {
	gain := int64(0)
	deltas := []assets.StackDelta{}
	for _, p := range parts {
		if math.IsNaN(p.Gain) || math.IsInf(p.Gain, 0) || p.Gain < 1 || p.Gain > float64(assets.MaxCoins) || p.Gain != math.Trunc(p.Gain) || int64(p.Gain) > assets.MaxCoins-gain {
			return assets.Result{}, assets.Rejection("coin_overflow")
		}
		gain += int64(p.Gain)
		deltas = append(deltas, assets.StackDelta{ItemID: p.ID, Tier: p.Tier, Quantity: -p.Quantity})
	}
	if err := t.Stacks(ctx, owner, deltas); err != nil {
		return assets.Result{}, err
	}
	if err := t.Coins(ctx, owner, gain); err != nil {
		return assets.Result{}, err
	}
	for _, p := range parts {
		st := rules.RegisterSale(states[p.ID], p.Quantity, now, c.PriceDynamicsFor(p.ID))
		states[p.ID] = st
		if st.SoldTotal < 0 || st.SoldTotal > assets.MaxCoins || st.SoldToday < 0 || st.SoldToday > assets.MaxCoins {
			return assets.Result{}, assets.Rejection("sales_overflow")
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.shop_sales(operation_id,owner_id,item_id,tier,quantity,unit,bonus,gain,automatic) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, t.OperationID(), owner, p.ID, p.Tier, p.Quantity, int64(p.Unit), int64(p.Bonus), int64(p.Gain), automatic); err != nil {
			return assets.Result{}, err
		}
	}
	ids := make([]string, 0, len(states))
	for id := range states {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		data, err := json.Marshal(states[id])
		if err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.economy_prices SET state=$2 WHERE item_id=$1`, id, data); err != nil {
			return assets.Result{}, err
		}
	}
	details, _ := json.Marshal(map[string]any{"gain": gain, "parts": parts})
	return assets.Result{Status: "sold", Details: details}, nil
}

type Sell struct {
	ActorID                  int64
	RequestKey, ItemID, Tier string
	Quantity                 int64
}

func (s *Service) Sell(ctx context.Context, r Sell) (assets.Result, error) {
	if r.Tier == "" {
		r.Tier = "normal"
	}
	it, _ := s.catalog.Item(r.ItemID)
	if r.ActorID < 1 || !s.economic(r.ItemID) || r.Quantity < 1 || r.Quantity > assets.MaxCoins || (r.Tier != "normal" && r.Tier != "large" && r.Tier != "giant") || (it.Kind != "fish" && r.Tier != "normal") {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "shop_sell", RuleVersion: s.version(), Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		states, err := lockPrices(ctx, t, []string{r.ItemID})
		if err != nil {
			return assets.Result{}, err
		}
		now, err := databaseTime(ctx, t)
		if err != nil {
			return assets.Result{}, err
		}
		unit := s.price(r.ItemID, states[r.ItemID], now)
		factor := map[string]float64{"normal": 0, "large": .5, "giant": 1.5}[r.Tier]
		bonus := rules.Round(unit * float64(r.Quantity) * factor)
		return applyParts(ctx, t, r.ActorID, []rules.SalePart{{ID: r.ItemID, Tier: r.Tier, Quantity: r.Quantity, Unit: unit, Bonus: bonus, Gain: unit*float64(r.Quantity) + bonus}}, states, now, false, s.catalog)
	})
}

type Settings struct {
	IncludeTiers bool                          `json:"includeTiers"`
	Rules        map[string]rules.AutoSellRule `json:"rules"`
}

func (s *Service) Configure(ctx context.Context, owner int64, key string, cfg Settings) (assets.Result, error) {
	if len(cfg.Rules) > 200 {
		return assets.Result{}, assets.ErrInvalid
	}
	for id, r := range cfg.Rules {
		if !s.economic(id) {
			return assets.Result{}, assets.ErrInvalid
		}
		keep := rules.Number(r.Keep)
		if math.IsNaN(keep) || math.IsInf(keep, 0) || keep < 0 || keep > float64(assets.MaxCoins) || keep != math.Trunc(keep) {
			return assets.Result{}, assets.ErrInvalid
		}
		for _, p := range []*float64{r.MinPct, r.MinPrice, &r.SlackPct, &r.SlackPrice} {
			if p != nil && (math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 || *p > float64(assets.MaxCoins)) {
				return assets.Result{}, assets.ErrInvalid
			}
		}
	}
	if cfg.Rules == nil {
		cfg.Rules = map[string]rules.AutoSellRule{}
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "autosell_config", RuleVersion: s.version(), Players: []int64{owner}, Input: cfg}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		data, err := json.Marshal(cfg.Rules)
		if err != nil {
			return assets.Result{}, err
		}
		_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,include_tiers,rules) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET include_tiers=excluded.include_tiers,rules=excluded.rules`, owner, cfg.IncludeTiers, data)
		return assets.Result{Status: "configured"}, err
	})
}
func (s *Service) AutoSell(ctx context.Context, owner int64, key string) (assets.Result, error) {
	if strings.HasPrefix(key, "autosell:run:") {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.autoSell(ctx, owner, key, false)
}
func (s *Service) autoSell(ctx context.Context, owner int64, key string, requireOnline bool) (assets.Result, error) {
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "autosell_run", RuleVersion: s.version(), Players: []int64{owner}, Input: struct{}{}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if requireOnline {
			var online bool
			if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.fishing_connections c JOIN fishing.identities i ON i.account_id=c.owner_id WHERE c.owner_id=$1 AND c.expires_at>clock_timestamp() AND NOT i.banned)`, owner).Scan(&online); err != nil {
				return assets.Result{}, err
			}
			if !online {
				return assets.Result{}, assets.ErrDeferred
			}
		}
		var cfg Settings
		var raw []byte
		if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT include_tiers FROM fishing.autosell_settings WHERE owner_id=$1),false),COALESCE((SELECT rules FROM fishing.autosell_settings WHERE owner_id=$1),'{}'::jsonb)`, owner).Scan(&cfg.IncludeTiers, &raw); err != nil {
			return assets.Result{}, err
		}
		if err := json.Unmarshal(raw, &cfg.Rules); err != nil {
			return assets.Result{}, err
		}
		ids := []string{}
		for id, r := range cfg.Rules {
			if r.On {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		if len(ids) == 0 {
			return assets.Result{}, assets.ErrDeferred
		}
		states, err := lockPrices(ctx, t, ids)
		if err != nil {
			return assets.Result{}, err
		}
		now, err := databaseTime(ctx, t)
		if err != nil {
			return assets.Result{}, err
		}
		inputs := []rules.AutoSellInput{}
		for _, id := range ids {
			it, _ := s.catalog.Item(id)
			x := rules.AutoSellInput{ID: id, Rule: cfg.Rules[id], Base: it.Price, Price: s.price(id, states[id], now)}
			if err := t.SQL().QueryRow(ctx, `SELECT COALESCE(sum(quantity) FILTER(WHERE tier='normal'),0)::bigint,COALESCE(sum(quantity) FILTER(WHERE tier='large'),0)::bigint,COALESCE(sum(quantity) FILTER(WHERE tier='giant'),0)::bigint FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2`, owner, id).Scan(&x.Normal, &x.Large, &x.Giant); err != nil {
				return assets.Result{}, err
			}
			inputs = append(inputs, x)
		}
		batch := int64(100)
		if n, ok := s.catalog.Runtime["autoSellBatch"].(float64); ok && n >= 1 && n <= 10000 {
			batch = int64(n)
		}
		plan := s.catalog.PlanAutoSell(inputs, cfg.IncludeTiers, batch)
		if len(plan.Parts) == 0 {
			return assets.Result{}, assets.ErrDeferred
		}
		return applyParts(ctx, t, owner, plan.Parts, states, now, true, s.catalog)
	})
}
