package fishing

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"fishing.local/server/internal/modules/assets"
)

type Cursor struct {
	Due time.Time
	ID  int64
}
type queued struct {
	Candidate
	due time.Time
}
type Batch struct{ Candidates, Settled, Deferred, Failed int }

// Sweep is a bounded database-backed scheduler. It holds no resource locks
// while scanning. Cursor rotation prevents a permanently blocked oldest batch
// from starving later players. A restart rebuilds candidates from the database.
func (s *Service) Sweep(ctx context.Context, after Cursor, limit, workers int) (Cursor, Batch, error) {
	stats := Batch{}
	if limit < 1 || limit > 100 || workers < 1 || workers > 8 || after.ID < 0 {
		return after, stats, assets.ErrInvalid
	}
	read, stop := context.WithTimeout(ctx, 2*time.Second)
	rows, err := s.pool.Query(read, `SELECT owner_id,id,generation,next_seq,due_at FROM fishing.fishing_sessions WHERE state='active' AND due_at<=clock_timestamp() AND ($1::bigint=0 OR (due_at,id)>($2,$1)) ORDER BY due_at,id LIMIT $3`, after.ID, after.Due, limit)
	if err != nil {
		stop()
		return after, stats, assets.ErrUnavailable
	}
	batch := []queued{}
	for rows.Next() {
		var q queued
		if err = rows.Scan(&q.OwnerID, &q.SessionID, &q.Generation, &q.Sequence, &q.due); err != nil {
			break
		}
		batch = append(batch, q)
	}
	readErr := rows.Err()
	rows.Close()
	stop()
	if err != nil || readErr != nil {
		return after, stats, assets.ErrUnavailable
	}
	stats.Candidates = len(batch)
	if len(batch) < limit {
		after = Cursor{}
	} else {
		last := batch[len(batch)-1]
		after = Cursor{last.due, last.SessionID}
	}
	jobs := make(chan queued, len(batch))
	results := make(chan int, len(batch))
	for _, q := range batch {
		jobs <- q
	}
	close(jobs)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for q := range jobs {
				if ctx.Err() != nil {
					return
				}
				r, err := s.Settle(ctx, q.Candidate)
				switch {
				case errors.Is(err, assets.ErrDeferred):
					results <- 1
				case err != nil:
					results <- 2
				case r.Status == "settled":
					results <- 0
				}
			}
		}()
	}
	wg.Wait()
	close(results)
	for code := range results {
		switch code {
		case 0:
			stats.Settled++
		case 1:
			stats.Deferred++
		case 2:
			stats.Failed++
		}
	}
	if ctx.Err() != nil {
		return after, stats, ctx.Err()
	}
	return after, stats, nil
}

func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	after := Cursor{}
	var lastWarning time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		next, stats, err := s.Sweep(ctx, after, 64, 4)
		after = next
		if ctx.Err() != nil {
			return
		}
		if (err != nil || stats.Failed > 0) && time.Since(lastWarning) > 5*time.Second {
			logger.Warn("fishing_scheduler_retry", "failed_candidates", stats.Failed)
			lastWarning = time.Now()
		}
	}
}
