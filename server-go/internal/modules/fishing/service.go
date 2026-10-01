// Package fishing implements durable catalog-default and synthetic fishing
// cycles. Its trusted internal methods are not the legacy gameplay HTTP protocol.
package fishing

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	assets *assets.Service
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool, assets.New(pool)} }

type Connection struct {
	ActorID            int64
	RequestKey, Action string // connect, heartbeat, disconnect; trusted gateway only
	Generation         int64
}

func (s *Service) Connection(ctx context.Context, c Connection) (assets.Result, error) {
	if c.ActorID <= 0 || (c.Action == "connect" && c.Generation != 0) || (c.Action != "connect" && c.Generation <= 0) {
		return assets.Result{}, assets.ErrInvalid
	}
	if c.Action != "connect" && c.Action != "heartbeat" && c.Action != "disconnect" {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: c.ActorID, RequestKey: c.RequestKey, Kind: "fishing_connection", RuleVersion: "presence-prototype-v1", Players: []int64{c.ActorID}, Input: c}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var generation int64
		if c.Action == "connect" {
			err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.fishing_connections(owner_id,generation,expires_at) VALUES ($1,1,clock_timestamp()+interval '15 seconds') ON CONFLICT(owner_id) DO UPDATE SET generation=fishing.fishing_connections.generation+1,expires_at=clock_timestamp()+interval '15 seconds' RETURNING generation`, c.ActorID).Scan(&generation)
			if err != nil {
				return assets.Result{}, err
			}
		} else {
			var alive bool
			err := t.SQL().QueryRow(ctx, `SELECT generation,expires_at>clock_timestamp() FROM fishing.fishing_connections WHERE owner_id=$1 FOR UPDATE`, c.ActorID).Scan(&generation, &alive)
			if errors.Is(err, pgx.ErrNoRows) || err == nil && generation != c.Generation {
				return assets.Result{}, assets.Rejection("stale_connection")
			}
			if err != nil {
				return assets.Result{}, err
			}
			if c.Action == "heartbeat" {
				if !alive {
					return assets.Result{}, assets.Rejection("connection_expired")
				}
				_, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()+interval '15 seconds' WHERE owner_id=$1`, c.ActorID)
				return assets.Result{Status: "connected", Generation: generation}, err
			}
			if _, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp() WHERE owner_id=$1`, c.ActorID); err != nil {
				return assets.Result{}, err
			}
		}
		// New connections invalidate old gateway work; resuming requires Start.
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, c.ActorID); err != nil {
			return assets.Result{}, err
		}
		_, err := t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, c.ActorID)
		status := "connected"
		if c.Action == "disconnect" {
			status = "disconnected"
		}
		return assets.Result{Status: status, Generation: generation}, err
	})
}

type Start struct {
	ActorID                 int64
	RequestKey, RuleVersion string
	ConnectionGeneration    int64
	AutoSell                bool
}

func (s *Service) Start(ctx context.Context, r Start) (assets.Result, error) {
	if r.ActorID <= 0 || r.ConnectionGeneration <= 0 || len(r.RuleVersion) < 1 || len(r.RuleVersion) > 128 {
		return assets.Result{}, assets.ErrInvalid
	}
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return assets.Result{}, assets.ErrUnavailable
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "fishing_start", RuleVersion: r.RuleVersion, Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var online bool
		if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.fishing_connections WHERE owner_id=$1 AND generation=$2 AND expires_at>clock_timestamp())`, r.ActorID, r.ConnectionGeneration).Scan(&online); err != nil {
			return assets.Result{}, err
		}
		if !online {
			return assets.Result{}, assets.Rejection("connection_expired")
		}
		var interval int
		err := t.SQL().QueryRow(ctx, `SELECT interval_ms FROM fishing.fishing_rules WHERE version=$1`, r.RuleVersion).Scan(&interval)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("unknown_rule")
		}
		if err != nil {
			return assets.Result{}, err
		}
		var id, generation int64
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, r.ActorID); err != nil {
			return assets.Result{}, err
		}
		err = t.SQL().QueryRow(ctx, `INSERT INTO fishing.fishing_sessions(owner_id,generation,connection_generation,state,rule_version,private_seed,loadout_rev,auto_sell,due_at)
 SELECT account_id,1,$2,'active',$3,$4,loadout_rev,$5,clock_timestamp()+($6::bigint*interval '1 millisecond') FROM fishing.player_state WHERE account_id=$1
 ON CONFLICT(owner_id) DO UPDATE SET generation=fishing.fishing_sessions.generation+1,next_seq=1,connection_generation=EXCLUDED.connection_generation,state='active',rule_version=EXCLUDED.rule_version,private_seed=EXCLUDED.private_seed,loadout_rev=EXCLUDED.loadout_rev,auto_sell=EXCLUDED.auto_sell,due_at=EXCLUDED.due_at
 RETURNING id,generation`, r.ActorID, r.ConnectionGeneration, r.RuleVersion, seed[:], r.AutoSell, interval).Scan(&id, &generation)
		return assets.Result{Status: "started", ResourceID: strconv.FormatInt(id, 10), Generation: generation, Sequence: 1}, err
	})
}

type Stop struct {
	ActorID    int64
	RequestKey string
	Generation int64
}

func (s *Service) Stop(ctx context.Context, r Stop) (assets.Result, error) {
	if zoneEvictionKey(r.RequestKey) {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.ActorID <= 0 || r.Generation <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "fishing_stop", RuleVersion: "fishing-prototype-v1", Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var id, generation int64
		err := t.SQL().QueryRow(ctx, `UPDATE fishing.fishing_sessions SET state='stopped',generation=generation+1 WHERE owner_id=$1 AND generation=$2 RETURNING id,generation`, r.ActorID, r.Generation).Scan(&id, &generation)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("stale_session")
		}
		return assets.Result{Status: "stopped", ResourceID: strconv.FormatInt(id, 10), Generation: generation}, err
	})
}

type Candidate struct{ OwnerID, SessionID, Generation, Sequence int64 }

func (c Candidate) Key() string {
	return fmt.Sprintf("fishing:settle:%d:%d:%d", c.SessionID, c.Generation, c.Sequence)
}

// Settle executes exactly the expected candidate, never substitutes a newer seq.
func (s *Service) Settle(ctx context.Context, c Candidate) (assets.Result, error) {
	if c.OwnerID <= 0 || c.SessionID <= 0 || c.Generation <= 0 || c.Sequence <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: c.OwnerID, RequestKey: c.Key(), Kind: "fishing_settle", RuleVersion: "fishing-prototype-v1", Players: []int64{c.OwnerID}, Input: c}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var generation, seq, connection, loadout, currentLoadout int64
		var state, rule, item, tier string
		var seed []byte
		var due time.Time
		var autoSell bool
		err := t.SQL().QueryRow(ctx, `SELECT generation,next_seq,connection_generation,state,rule_version,private_seed,loadout_rev,auto_sell,due_at FROM fishing.fishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`, c.SessionID, c.OwnerID).Scan(&generation, &seq, &connection, &state, &rule, &seed, &loadout, &autoSell, &due)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (state != "active" || generation != c.Generation || seq != c.Sequence) {
			return assets.Result{}, assets.Rejection("stale_cycle")
		}
		if err != nil {
			return assets.Result{}, err
		}
		var now time.Time
		var online bool
		if err = t.SQL().QueryRow(ctx, `SELECT clock_timestamp(),EXISTS(SELECT 1 FROM fishing.fishing_connections WHERE owner_id=$1 AND generation=$2 AND expires_at>clock_timestamp()),loadout_rev FROM fishing.player_state WHERE account_id=$1`, c.OwnerID, connection).Scan(&now, &online, &currentLoadout); err != nil {
			return assets.Result{}, err
		}
		r := assets.Result{ResourceID: strconv.FormatInt(c.SessionID, 10), Generation: generation, Sequence: seq}
		if !online {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE id=$1`, c.SessionID)
			r.Status = "paused"
			r.Generation++
			return r, err
		}
		var interval, ppm, quantity int
		var salePrice int64
		if err = t.SQL().QueryRow(ctx, `SELECT interval_ms,bite_ppm,item_id,tier,quantity,sale_price FROM fishing.fishing_rules WHERE version=$1`, rule).Scan(&interval, &ppm, &item, &tier, &quantity, &salePrice); err != nil {
			return assets.Result{}, err
		}
		if currentLoadout != loadout {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET generation=generation+1,next_seq=1,loadout_rev=$2,due_at=$3 WHERE id=$1`, c.SessionID, currentLoadout, now.Add(time.Duration(interval)*time.Millisecond))
			r.Status = "rescheduled"
			r.Generation++
			r.Sequence = 1
			return r, err
		}
		if now.Before(due) {
			return assets.Result{}, assets.ErrDeferred
		}
		caught, sold := 0, 0
		coins := int64(0)
		if sample(seed, c.SessionID, generation, seq, 1000000) < uint64(ppm) {
			caught = quantity
		}
		if caught > 0 {
			if autoSell && tier == "normal" && salePrice > 0 {
				sold = caught
				coins = int64(sold) * salePrice
				err = t.Coins(ctx, c.OwnerID, coins)
			} else {
				err = t.Stacks(ctx, c.OwnerID, []assets.StackDelta{{ItemID: item, Tier: tier, Quantity: int64(caught)}})
			}
			if err != nil {
				// Capacity can change later: do not cache a rejected cycle forever.
				var rejected assets.Rejection
				if errors.As(err, &rejected) {
					return assets.Result{}, assets.ErrDeferred
				}
				return assets.Result{}, err
			}
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.fishing_settlements(session_id,generation,seq,operation_id,rule_version,random_version,caught,sold,coins,due_at,settled_at) VALUES ($1,$2,$3,$4,$5,'hmac-sha256-v1',$6,$7,$8,$9,$10)`, c.SessionID, generation, seq, t.OperationID(), rule, caught, sold, coins, due, now); err != nil {
			return assets.Result{}, err
		}
		// Start the next interval from current DB time; never loop over downtime.
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET next_seq=next_seq+1,due_at=$2 WHERE id=$1`, c.SessionID, now.Add(time.Duration(interval)*time.Millisecond)); err != nil {
			return assets.Result{}, err
		}
		r.Status = "settled"
		return r, nil
	})
}
