package fishing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/sea"
	"github.com/jackc/pgx/v5"
)

// EvictZoneGuest rechecks authority under the same player/topology lock order
// as settlement. A permission restored after discovery is never evicted.
func zoneEvictionKey(key string) bool { return strings.HasPrefix(key, "fishing:zone-evict:") }

func (s *NativeService) EvictZoneGuest(ctx context.Context, c Candidate) (assets.Result, error) {
	if s.catalog == nil {
		current, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return assets.Result{}, err
		}
		copy := *s
		copy.catalog = current
		return copy.EvictZoneGuest(ctx, c)
	}
	key := fmt.Sprintf("fishing:zone-evict:%d:%d", c.SessionID, c.Generation)
	return s.assets.Run(ctx, assets.Command{ActorID: c.OwnerID, RequestKey: key, Kind: "fishing_stop", RuleVersion: "sea-access-v1", Players: []int64{c.OwnerID}, Input: struct{ ID, Generation int64 }{c.SessionID, c.Generation}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var generation int64
		var state, ground, spot string
		err := t.SQL().QueryRow(ctx, `SELECT generation,state,ground_id,spot_id FROM fishing.native_fishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`, c.SessionID, c.OwnerID).Scan(&generation, &state, &ground, &spot)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (state != "active" || generation != c.Generation || !strings.HasPrefix(ground, "sea:")) {
			return assets.Result{}, assets.ErrDeferred
		}
		if err != nil {
			return assets.Result{}, err
		}
		_, err = sea.New(s.pool, s.catalog, s.location).ResolveFishing(ctx, t, c.OwnerID, ground, spot)
		if err == nil {
			return assets.Result{}, assets.ErrDeferred
		}
		var rejection assets.Rejection
		if !errors.As(err, &rejection) {
			return assets.Result{}, err
		}
		if rejection != "sea_membership_required" && rejection != "sea_zone_expired" {
			return assets.Result{}, assets.ErrDeferred
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1,resume_enabled=false WHERE id=$1`, c.SessionID); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(map[string]string{"reason": string(rejection), "groundId": ground, "spotId": spot})
		return assets.Result{Status: "stopped", ResourceID: strconv.FormatInt(c.SessionID, 10), Generation: generation + 1, Details: details}, nil
	})
}

// SweepZoneGuests scans only revoked or expired zones, without waiting for a
// long cast to become due. Selection is advisory; EvictZoneGuest is authority.
func (s *NativeService) SweepZoneGuests(ctx context.Context, after int64, limit int) (int64, int, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return after, 0, assets.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT n.owner_id,n.id,n.generation,n.next_seq FROM fishing.native_fishing_sessions n
 WHERE n.id>$1 AND n.state='active' AND n.ground_id LIKE 'sea:%' AND (
 NOT EXISTS(SELECT 1 FROM fishing.sea_zones z WHERE z.owner_id::text=split_part(n.ground_id,':',2) AND z.id=split_part(n.ground_id,':',3) AND z.expires_at>statement_timestamp())
 OR (split_part(n.ground_id,':',2)<>n.owner_id::text AND NOT EXISTS(
 SELECT 1 FROM fishing.party_members a JOIN fishing.party_members b ON a.party_id=b.party_id JOIN fishing.parties p ON p.id=a.party_id AND p.active
 WHERE a.owner_id=n.owner_id AND b.owner_id::text=split_part(n.ground_id,':',2)))) ORDER BY n.id LIMIT $2`, after, limit)
	if err != nil {
		return after, 0, assets.ErrUnavailable
	}
	list := []Candidate{}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.OwnerID, &c.SessionID, &c.Generation, &c.Sequence); err != nil {
			rows.Close()
			return after, 0, err
		}
		list = append(list, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return after, 0, err
	}
	next := int64(0)
	if len(list) == limit {
		next = list[len(list)-1].SessionID
	}
	count := 0
	var firstErr error
	for _, c := range list {
		result, err := s.EvictZoneGuest(ctx, c)
		if errors.Is(err, assets.ErrDeferred) {
			continue
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if result.Status == "stopped" {
			count++
		}
	}
	return next, count, firstErr
}

func (s *NativeService) runWithZoneEvictions(ctx context.Context, logger *slog.Logger) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		var after int64
		var warned time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			next, _, err := s.SweepZoneGuests(ctx, after, 100)
			after = next
			if err != nil && ctx.Err() == nil && time.Since(warned) > 5*time.Second {
				logger.Warn("sea_eviction_retry")
				warned = time.Now()
			}
		}
	}()
	runScheduler(ctx, logger, s.Sweep)
	wg.Wait()
}
