package fishing

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/sea"
	"github.com/jackc/pgx/v5"
)

// Stream leases are per browser connection. Closing one tab cannot pause a
// different tab's cast. An expired final lease produces no offline income.
func (s *NativeService) Stream(ctx context.Context, owner int64, key, id, action string) (assets.Result, error) {
	if len(id) != 32 || (action != "open" && action != "heartbeat" && action != "close") {
		return assets.Result{}, assets.ErrInvalid
	}
	if s.live {
		c, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return assets.Result{}, err
		}
		copy := *s
		copy.catalog = c
		copy.live = false
		return copy.Stream(ctx, owner, key, id, action)
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "fishing_connection", RuleVersion: "legacy-presence-v1", Players: []int64{owner}, Input: struct{ ID, Action string }{id, action}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.gateway_streams WHERE owner_id=$1 AND expires_at<=clock_timestamp()`, owner); err != nil {
			return assets.Result{}, err
		}
		if action == "close" {
			if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.gateway_streams WHERE owner_id=$1 AND stream_id=$2`, owner, id); err != nil {
				return assets.Result{}, err
			}
		} else if action == "open" {
			var count int
			if err := t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.gateway_streams WHERE owner_id=$1`, owner).Scan(&count); err != nil {
				return assets.Result{}, err
			}
			if count >= 8 {
				return assets.Result{}, assets.Rejection("stream_limit")
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 seconds') ON CONFLICT(owner_id,stream_id) DO UPDATE SET expires_at=excluded.expires_at`, owner, id); err != nil {
				return assets.Result{}, err
			}
		} else {
			tag, err := t.SQL().Exec(ctx, `UPDATE fishing.gateway_streams SET expires_at=clock_timestamp()+interval '15 seconds' WHERE owner_id=$1 AND stream_id=$2`, owner, id)
			if err != nil {
				return assets.Result{}, err
			}
			if tag.RowsAffected() != 1 {
				return assets.Result{}, assets.Rejection("connection_expired")
			}
		}
		var alive int
		if err := t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.gateway_streams WHERE owner_id=$1`, owner).Scan(&alive); err != nil {
			return assets.Result{}, err
		}
		var generation int64
		var wasOnline bool
		err := t.SQL().QueryRow(ctx, `SELECT generation,expires_at>clock_timestamp() FROM fishing.fishing_connections WHERE owner_id=$1`, owner).Scan(&generation, &wasOnline)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, err
		}
		if generation == 0 {
			generation = 1
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.fishing_connections(owner_id,generation,expires_at) VALUES($1,$2,clock_timestamp()+CASE WHEN $3::int>0 THEN interval '15 seconds' ELSE interval '0 seconds' END) ON CONFLICT(owner_id) DO UPDATE SET expires_at=excluded.expires_at`, owner, generation, alive); err != nil {
			return assets.Result{}, err
		}
		if alive == 0 {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='paused',resume_enabled=true WHERE owner_id=$1 AND state='active'`, owner)
			return assets.Result{Status: "disconnected", Generation: generation}, err
		}
		if action == "open" {
			var state, ground, spot, version string
			err = t.SQL().QueryRow(ctx, `SELECT state,ground_id,spot_id,rule_version FROM fishing.native_fishing_sessions WHERE owner_id=$1`, owner).Scan(&state, &ground, &spot, &version)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return assets.Result{}, err
			}
			if state != "" && state != "stopped" && (state == "paused" || !wasOnline) {
				// Preserve a suspended recursive sequence and its pinned rules.
				copy := *s
				if version != s.version() {
					copy.catalog, err = catalog.ByVersion(ctx, t.SQL(), version)
					if err != nil {
						return assets.Result{}, err
					}
				}
				access, e := sea.New(s.pool, copy.catalog, s.location).ResolveFishing(ctx, t, owner, ground, spot)
				if e != nil {
					var rejection assets.Rejection
					if !errors.As(e, &rejection) {
						return assets.Result{}, e
					}
					_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1 WHERE owner_id=$1`, owner)
					if err != nil {
						return assets.Result{}, err
					}
				} else {
					_, info, e := copy.loadout(ctx, t, owner, access.Spot)
					if e != nil {
						return assets.Result{}, e
					}
					if _, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='active',resume_enabled=true,connection_generation=$2,due_at=clock_timestamp()+($3::double precision*interval '1 millisecond') WHERE owner_id=$1`, owner, generation, info.Interval); err != nil {
						return assets.Result{}, err
					}
				}
			}
		}
		return assets.Result{Status: "connected", Generation: generation}, nil
	})
}

// Status uses a read transaction so loadout and timing belong to one snapshot.
func (s *NativeService) Status(ctx context.Context, owner int64) (map[string]any, error) {
	if s.live {
		c, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return nil, err
		}
		copy := *s
		copy.catalog = c
		copy.live = false
		return copy.Status(ctx, owner)
	}
	var state, ground, spot string
	var gen, conn int64
	var due time.Time
	err := s.pool.QueryRow(ctx, `SELECT state,ground_id,spot_id,generation,connection_generation,due_at FROM fishing.native_fishing_sessions WHERE owner_id=$1`, owner).Scan(&state, &ground, &spot, &gen, &conn, &due)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{"active": false}, nil
	}
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	return map[string]any{"active": state == "active", "state": state, "groundId": ground, "spotId": spot, "generation": gen, "connectionGeneration": conn, "dueAt": due.UnixMilli()}, nil
}

func details(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }
