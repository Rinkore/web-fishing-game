// acceptance is a destructive, synthetic-only fixture runner. The database name
// guard prevents accidental operation on an application or production database.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance failed:", err)
		os.Exit(1)
	}
}
func numberEnv(name string, def, lo, hi int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		return 0, errors.New("invalid acceptance workload")
	}
	return n, nil
}
func fingerprint(ctx context.Context, p *pgxpool.Pool) (string, error) {
	// No names, credentials, secrets or equipment seeds enter the report.
	var snapshot string
	err := p.QueryRow(ctx, `SELECT json_build_array(
 (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY account_id),'[]') FROM (SELECT account_id,coins FROM fishing.wallets) x),
 (SELECT COALESCE(json_agg(row_to_json(x) ORDER BY owner_id,item_id,tier),'[]') FROM (SELECT owner_id,item_id,tier,quantity FROM fishing.inventory_stacks) x),
 (SELECT count(*) FROM fishing.asset_operations),(SELECT count(*) FROM fishing.fishing_settlements),
 (SELECT count(*) FROM fishing.market_fills),(SELECT count(*) FROM fishing.outbox_events),
 (SELECT count(*) FROM fishing.player_events))::text`).Scan(&snapshot)
	if err != nil {
		return "", errors.New("cannot compute durable fingerprint")
	}
	sum := sha256.Sum256([]byte(snapshot))
	return hex.EncodeToString(sum[:]), nil
}
func reconcile(ctx context.Context, p *pgxpool.Pool) error {
	var differences int64
	err := p.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM fishing.wallets w WHERE w.coins<>COALESCE((SELECT sum(delta) FROM fishing.asset_entries e WHERE e.account_id=w.account_id),0))+
 (SELECT count(*) FROM fishing.inventory_stacks s WHERE s.quantity<>COALESCE((SELECT sum(delta) FROM fishing.inventory_entries e WHERE (e.owner_id,e.item_id,e.tier)=(s.owner_id,s.item_id,s.tier)),0))+
 (SELECT count(*) FROM fishing.asset_operations a WHERE NOT EXISTS(SELECT 1 FROM fishing.outbox_events o WHERE o.operation_id=a.id))`).Scan(&differences)
	if err != nil || differences != 0 {
		return errors.New("ledger reconciliation failed")
	}
	return nil
}
func run() error {
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(os.Getenv("FISHING_GO_ACCEPTANCE_URL"))
	if err != nil || config.ConnConfig.Database != "fishing_acceptance" {
		return errors.New("requires isolated fishing_acceptance database")
	}
	config.MaxConns = 32
	config.ConnConfig.RuntimeParams["synchronous_commit"] = "on"
	config.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	p, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer p.Close()
	var fsync, full, syncCommit string
	if err := p.QueryRow(ctx, `SELECT current_setting('fsync'),current_setting('full_page_writes'),current_setting('synchronous_commit')`).Scan(&fsync, &full, &syncCommit); err != nil || fsync != "on" || full != "on" || syncCommit != "on" {
		return errors.New("durability configuration not enabled")
	}
	if os.Getenv("FISHING_GO_ACCEPTANCE_PHASE") == "verify" {
		if err := reconcile(ctx, p); err != nil {
			return err
		}
		actual, err := fingerprint(ctx, p)
		if err != nil {
			return err
		}
		var expected string
		if err := p.QueryRow(ctx, `SELECT fingerprint FROM public.acceptance_checkpoint WHERE id=1`).Scan(&expected); err != nil || actual != expected {
			return errors.New("committed data changed after database crash")
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"phase": "verify", "databaseCrashRecovery": "passed", "reconciliationDifferences": 0, "fingerprint": actual})
	}
	players, err := numberEnv("FISHING_GO_ACCEPTANCE_PLAYERS", 100, 1, 5000)
	if err != nil {
		return err
	}
	seconds, err := numberEnv("FISHING_GO_ACCEPTANCE_SECONDS", 60, 5, 3600)
	if err != nil {
		return err
	}
	if err := migrations.Apply(ctx, p); err != nil {
		return err
	}
	var count int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM fishing.accounts`).Scan(&count); err != nil || count != 0 {
		return errors.New("workload requires fresh synthetic database")
	}
	if _, err := p.Exec(ctx, `CREATE TABLE public.acceptance_checkpoint(id integer PRIMARY KEY,fingerprint text NOT NULL)`); err != nil {
		return errors.New("cannot create checkpoint")
	}
	if _, err := p.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('acceptance_fish','fish'),('acceptance_material','material'); INSERT INTO fishing.fishing_rules(version,interval_ms,bite_ppm,item_id,tier,quantity,sale_price) VALUES('acceptance-v1',800,1000000,'acceptance_fish','normal',1,10)`); err != nil {
		return errors.New("cannot seed synthetic rules")
	}
	assetSvc, fishSvc, marketSvc := assets.New(p), fishing.New(p), market.New(p)
	ids := make([]int64, players)
	gens := make([]int64, players)
	for i := range ids {
		if err := p.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&ids[i]); err != nil {
			return errors.New("account fixture failed")
		}
		for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
			if _, err := p.Exec(ctx, sql, ids[i]); err != nil {
				return errors.New("player fixture failed")
			}
		}
		if r, err := assetSvc.ApplyChange(ctx, assets.Change{ActorID: ids[i], RequestKey: "seed", Reason: "reward", RuleVersion: "acceptance-v1", Coins: 100000, Stacks: []assets.StackDelta{{ItemID: "acceptance_material", Tier: "normal", Quantity: 10000}}}); err != nil || r.Status != "applied" {
			return errors.New("asset fixture failed")
		}
		c, err := fishSvc.Connection(ctx, fishing.Connection{ActorID: ids[i], RequestKey: "connect", Action: "connect"})
		if err != nil {
			return err
		}
		gens[i] = c.Generation
		if _, err := fishSvc.Start(ctx, fishing.Start{ActorID: ids[i], RequestKey: "start", RuleVersion: "acceptance-v1", ConnectionGeneration: c.Generation, AutoSell: true}); err != nil {
			return err
		}
	}
	// Fixture startup is outside load timing; renew every lease before starting.
	if _, err := p.Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()+interval '15 seconds'`); err != nil {
		return errors.New("presence fixture failed")
	}
	if _, err := p.Exec(ctx, `UPDATE fishing.fishing_sessions SET due_at=clock_timestamp()+interval '800 milliseconds'`); err != nil {
		return errors.New("initial schedule fixture failed")
	}
	var walStart string
	var commitsStart int64
	_ = p.QueryRow(ctx, `SELECT pg_current_wal_lsn()::text`).Scan(&walStart)
	_ = p.QueryRow(ctx, `SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()`).Scan(&commitsStart)
	work, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); fishSvc.Run(work, slog.New(slog.NewTextHandler(io.Discard, nil))) }()
	var failures, operations atomic.Int64
	var mu sync.Mutex
	latencies := []float64{}
	start := time.Now()
	for i, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tick := time.NewTicker(5 * time.Second)
			defer tick.Stop()
			seq := 0
			for {
				select {
				case <-work.Done():
					return
				case <-tick.C:
					seq++
					opStart := time.Now()
					r, err := fishSvc.Connection(work, fishing.Connection{ActorID: id, RequestKey: fmt.Sprintf("heartbeat-%d", seq), Action: "heartbeat", Generation: gens[i]})
					if work.Err() != nil {
						return
					}
					if err != nil || r.Status != "connected" {
						failures.Add(1)
					}
					operations.Add(1)
					if players > 1 && i%10 == 0 {
						listed, err := marketSvc.ListOrder(work, market.OrderRequest{ActorID: id, RequestKey: fmt.Sprintf("list-%d", seq), ItemID: "acceptance_material", Quantity: 2, UnitPrice: 10, Hours: 6})
						if work.Err() != nil {
							return
						}
						if err != nil || listed.Status != "listed" {
							failures.Add(1)
						} else {
							order, _ := strconv.ParseInt(listed.ResourceID, 10, 64)
							fill := market.FillRequest{ActorID: ids[(i+1)%players], OrderID: order, Quantity: 2, ExpectedUnitPrice: 10, RequestKey: fmt.Sprintf("buy-%d-%d", i, seq)}
							r, err := marketSvc.Fill(work, fill)
							if work.Err() != nil {
								return
							}
							if err != nil || r.Status != "purchased" {
								failures.Add(1)
							} else {
								// Simulate lost response: discard result, retry identical command, compare operation IDs.
								again, err := marketSvc.Fill(work, fill)
								if err != nil || again.OperationID != r.OperationID {
									failures.Add(1)
								}
							}
							operations.Add(2)
						}
					}
					mu.Lock()
					latencies = append(latencies, float64(time.Since(opStart).Microseconds())/1000)
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)
	if err := reconcile(ctx, p); err != nil {
		return err
	}
	hash, err := fingerprint(ctx, p)
	if err != nil {
		return err
	}
	if _, err := p.Exec(ctx, `INSERT INTO public.acceptance_checkpoint(id,fingerprint) VALUES(1,$1)`, hash); err != nil {
		return errors.New("checkpoint commit failed")
	}
	var settlements int64
	var p95, p99 float64
	var size, commits int64
	var walBytes float64
	if err := p.QueryRow(ctx, `SELECT count(*),COALESCE(percentile_cont(.95) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM settled_at-due_at)*1000),0),COALESCE(percentile_cont(.99) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM settled_at-due_at)*1000),0) FROM fishing.fishing_settlements`).Scan(&settlements, &p95, &p99); err != nil {
		return errors.New("settlement measurements failed")
	}
	_ = p.QueryRow(ctx, `SELECT pg_database_size(current_database()),pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)`, walStart).Scan(&size, &walBytes)
	_ = p.QueryRow(ctx, `SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()`).Scan(&commits)
	sort.Float64s(latencies)
	mixedP95 := 0.0
	if len(latencies) > 0 {
		mixedP95 = latencies[int(float64(len(latencies)-1)*.95)]
	}
	report := map[string]any{"phase": "run", "scope": "synthetic fishing + formal market; not full gameplay capacity", "players": players, "seconds": elapsed.Seconds(), "intervalMs": 800, "cpus": runtime.NumCPU(), "settlements": settlements, "settlementsPerSecond": float64(settlements) / elapsed.Seconds(), "scheduleP95Ms": p95, "scheduleP99Ms": p99, "mixedCommandBatchP95Ms": mixedP95, "observedOperations": operations.Load(), "unexpectedFailures": failures.Load(), "databaseBytes": size, "walBytes": walBytes, "databaseCommits": commits - commitsStart, "reconciliationDifferences": 0, "fingerprint": hash, "durability": map[string]string{"fsync": fsync, "synchronousCommit": syncCommit, "fullPageWrites": full}}
	if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
		return err
	}
	if failures.Load() > 0 {
		return errors.New("workload reported unexpected failures")
	}
	return nil
}
