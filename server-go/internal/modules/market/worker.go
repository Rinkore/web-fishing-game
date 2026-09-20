package market

import (
	"context"
	"log/slog"
	"time"
)

func (s *Service) RunExpiry(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var after int64
	var lastWarning time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		batch, cancel := context.WithTimeout(ctx, 5*time.Second)
		next, err := s.Expire(batch, after, 64)
		cancel()
		after = next
		if ctx.Err() != nil {
			return
		}
		if err != nil && time.Since(lastWarning) > 5*time.Second {
			logger.Warn("market_expiry_retry")
			lastWarning = time.Now()
		}
	}
}
