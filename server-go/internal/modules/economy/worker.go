package economy

import (
	"context"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fmt"
	"log/slog"
	"time"
)

func (s *Service) Sweep(ctx context.Context, after int64) (int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT s.owner_id,floor(extract(epoch FROM clock_timestamp())/5)::bigint FROM fishing.autosell_settings s JOIN fishing.fishing_connections c ON c.owner_id=s.owner_id JOIN fishing.identities i ON i.account_id=s.owner_id WHERE s.owner_id>$1 AND c.expires_at>clock_timestamp() AND NOT i.banned AND s.rules<>'{}'::jsonb ORDER BY s.owner_id LIMIT 64`, after)
	if err != nil {
		return after, err
	}
	type candidate struct{ id, bucket int64 }
	list := []candidate{}
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.bucket); err != nil {
			rows.Close()
			return after, err
		}
		list = append(list, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return after, err
	}
	for _, c := range list {
		_, err := s.autoSell(ctx, c.id, fmt.Sprintf("autosell:run:%d:%d", c.id, c.bucket), true)
		if err != nil && !errors.Is(err, assets.ErrDeferred) {
			return after, err
		}
		after = c.id
	}
	if len(list) < 64 {
		after = 0
	}
	return after, nil
}
func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var after int64
	var warned time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 5*time.Second)
		c, _, err := catalog.Effective(work, s.pool)
		next := after
		if err == nil {
			copy := *s
			copy.catalog = c
			next, err = copy.Sweep(work, after)
		}
		cancel()
		after = next
		if err != nil && ctx.Err() == nil && time.Since(warned) > 5*time.Second {
			logger.Warn("autosell_retry")
			warned = time.Now()
		}
	}
}
