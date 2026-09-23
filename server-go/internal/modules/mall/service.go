package mall

import (
	"context"
	"encoding/json"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool     *pgxpool.Pool
	assets   *assets.Service
	catalog  *rules.Catalog
	location *time.Location
}

func New(pool *pgxpool.Pool, catalog *rules.Catalog, location *time.Location) *Service {
	if location == nil {
		location = time.Local
	}
	return &Service{pool: pool, assets: assets.New(pool), catalog: catalog, location: location}
}

type Purchase struct {
	ActorID            int64
	RequestKey, ItemID string
	Quantity           int64
}
type ItemView struct {
	rules.MallItem
	Bought int64  `json:"bought"`
	Remain *int64 `json:"remain"`
}
type View struct {
	rules.MallCycle
	Items []ItemView `json:"items"`
}

func (s *Service) Buy(ctx context.Context, r Purchase) (assets.Result, error) {
	if r.ActorID < 1 || r.Quantity < 1 || r.Quantity > 99 {
		return assets.Result{}, assets.ErrInvalid
	}
	cfg := s.catalog.MallConfig()
	var item rules.MallItem
	for _, it := range cfg.Items {
		if it.ID == r.ItemID {
			item = it
			break
		}
	}
	definition, exists := s.catalog.Item(item.ID)
	if !exists || definition.ExpeditionOnly || definition.Kind != "material" || item.Price < 0 || item.Price > 100000000 || item.Limit < 0 || item.Limit > 9999 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "mall_buy", RuleVersion: s.catalog.Version + ":" + s.catalog.SourceSHA256, Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var now time.Time
		if err := t.SQL().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			return assets.Result{}, err
		}
		cycle := rules.MallCycleOf(cfg.RefreshTime, now.In(s.location))
		var bought int64
		if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT quantity FROM fishing.mall_purchases WHERE owner_id=$1 AND item_id=$2 AND cycle_key=$3::date),0)`, r.ActorID, r.ItemID, cycle.Key).Scan(&bought); err != nil {
			return assets.Result{}, err
		}
		if item.Limit > 0 && bought+r.Quantity > item.Limit {
			return assets.Result{}, assets.Rejection("mall_limit_exceeded")
		}
		if bought > assets.MaxCoins-r.Quantity {
			return assets.Result{}, assets.Rejection("mall_quantity_overflow")
		}
		cost := item.Price * r.Quantity
		if err := t.Coins(ctx, r.ActorID, -cost); err != nil {
			return assets.Result{}, err
		}
		if err := t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: r.ItemID, Tier: "normal", Quantity: r.Quantity}}); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.mall_purchases(owner_id,item_id,cycle_key,quantity) VALUES($1,$2,$3::date,$4) ON CONFLICT(owner_id,item_id) DO UPDATE SET cycle_key=excluded.cycle_key,quantity=excluded.quantity`, r.ActorID, r.ItemID, cycle.Key, bought+r.Quantity); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(map[string]any{"id": r.ItemID, "quantity": r.Quantity, "cost": cost, "bought": bought + r.Quantity, "cycle": cycle})
		return assets.Result{Status: "purchased", Details: details}, nil
	})
}
func (s *Service) View(ctx context.Context, owner int64) (View, error) {
	if owner < 1 {
		return View{}, assets.ErrInvalid
	}
	cfg := s.catalog.MallConfig()
	// One statement observes purchase counters and the database time consistently.
	rows, err := s.pool.Query(ctx, `SELECT clock_timestamp(),item_id,cycle_key::text,quantity FROM (SELECT 1) singleton LEFT JOIN fishing.mall_purchases ON owner_id=$1`, owner)
	if err != nil {
		return View{}, assets.ErrUnavailable
	}
	defer rows.Close()
	var view View
	bought := map[string]int64{}
	for rows.Next() {
		var now time.Time
		var id, key *string
		var quantity *int64
		if err := rows.Scan(&now, &id, &key, &quantity); err != nil {
			return View{}, assets.ErrUnavailable
		}
		if view.Key == "" {
			view.MallCycle = rules.MallCycleOf(cfg.RefreshTime, now.In(s.location))
		}
		if key != nil && *key == view.Key {
			bought[*id] = *quantity
		}
	}
	if rows.Err() != nil {
		return View{}, assets.ErrUnavailable
	}
	view.Items = []ItemView{}
	for _, it := range cfg.Items {
		x := ItemView{MallItem: it, Bought: bought[it.ID]}
		if it.Limit > 0 {
			remaining := max(int64(0), it.Limit-x.Bought)
			x.Remain = &remaining
		}
		view.Items = append(view.Items, x)
	}
	return view, nil
}
