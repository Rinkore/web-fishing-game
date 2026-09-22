package trade

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
)

func (s *Service) Expire(ctx context.Context, id, actor int64) (assets.Result, error) {
	v, err := s.View(ctx, id, actor)
	if err != nil {
		return assets.Result{}, err
	}
	key := "trade:expire:" + strconv.FormatInt(id, 10)
	return s.assets.Run(ctx, assets.Command{ActorID: v.AID, RequestKey: key, Kind: "trade_expire", RuleVersion: "trade-v1", Players: []int64{v.AID, v.BID}, Input: struct{ ID int64 }{id}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		v, err := read(ctx, t.SQL(), id, v.AID, true)
		if err != nil {
			return assets.Result{}, err
		}
		if v.State != "invited" && v.State != "accepted" {
			return assets.Result{}, assets.Rejection("trade_closed")
		}
		alive, err := online(ctx, t.SQL(), v.AID, v.BID)
		if err != nil {
			return assets.Result{}, err
		}
		if alive && !v.expired {
			return assets.Result{}, assets.ErrDeferred
		}
		return closeTrade(ctx, t, v, "expired")
	})
}
func (s *Service) Sweep(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT t.id,t.a_id FROM fishing.trades t WHERE t.state IN ('invited','accepted') AND (t.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM fishing.fishing_connections c WHERE c.owner_id=t.a_id AND c.expires_at>clock_timestamp()) OR NOT EXISTS(SELECT 1 FROM fishing.fishing_connections c WHERE c.owner_id=t.b_id AND c.expires_at>clock_timestamp())) ORDER BY t.id LIMIT 64`)
	if err != nil {
		return err
	}
	type candidate struct{ id, actor int64 }
	list := []candidate{}
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.actor); err != nil {
			rows.Close()
			return err
		}
		list = append(list, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range list {
		if _, err := s.Expire(ctx, c.id, c.actor); err != nil && err != assets.ErrDeferred {
			return err
		}
	}
	return nil
}
func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			work, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := s.Sweep(work)
			cancel()
			if err != nil && ctx.Err() == nil {
				logger.Warn("trade_expiry_deferred")
			}
		}
	}
}
