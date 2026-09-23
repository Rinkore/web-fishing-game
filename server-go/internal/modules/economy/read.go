package economy

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"sort"
	"time"
)

type PriceView struct {
	ID        string  `json:"id"`
	Base      float64 `json:"base"`
	Price     float64 `json:"price"`
	SoldTotal int64   `json:"soldTotal"`
	SoldToday int64   `json:"soldToday"`
}

func (s *Service) Prices(ctx context.Context) ([]PriceView, error) {
	rows, err := s.pool.Query(ctx, `SELECT statement_timestamp(),item_id,state FROM (SELECT 1) singleton LEFT JOIN fishing.economy_prices ON true`)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	states := map[string]rules.SaleState{}
	var now time.Time
	for rows.Next() {
		var id *string
		var raw []byte
		if err := rows.Scan(&now, &id, &raw); err != nil {
			return nil, assets.ErrUnavailable
		}
		if id != nil {
			var st rules.SaleState
			if json.Unmarshal(raw, &st) != nil {
				return nil, assets.ErrUnavailable
			}
			states[*id] = st
		}
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	out := []PriceView{}
	for _, it := range s.catalog.Items {
		if !s.economic(it.ID) {
			continue
		}
		st := states[it.ID]
		today := st.SoldToday
		if st.Day != now.UTC().Format("2006-01-02") {
			today = 0
		}
		base := it.Price
		if override := s.catalog.PriceOverrideFor(it.ID, now.UnixMilli()); override.Base > 0 {
			base = rules.Round(override.Base)
		}
		out = append(out, PriceView{it.ID, base, s.price(it.ID, st, now.UnixMilli()), st.SoldTotal, today})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
func (s *Service) Settings(ctx context.Context, owner int64) (Settings, error) {
	var cfg Settings
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE((SELECT include_tiers FROM fishing.autosell_settings WHERE owner_id=$1),false),COALESCE((SELECT rules FROM fishing.autosell_settings WHERE owner_id=$1),'{}'::jsonb)`, owner).Scan(&cfg.IncludeTiers, &raw); err != nil {
		return cfg, assets.ErrUnavailable
	}
	if json.Unmarshal(raw, &cfg.Rules) != nil {
		return cfg, assets.ErrUnavailable
	}
	return cfg, nil
}
