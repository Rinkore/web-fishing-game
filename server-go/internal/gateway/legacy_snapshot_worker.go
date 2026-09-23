package gateway

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const legacySnapshotBatchSize = 100

// RunLegacySnapshots consumes the existing operator snapshot policy. Each
// player is copied in a short transaction under the asset command guard;
// concurrent servers and manual backups share that guard and the durable due
// timestamp, so they cannot produce duplicate backups for the same interval.
func RunLegacySnapshots(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) {
	a := &API{pool: pool}
	run := func() {
		work, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		count, err := a.runLegacySnapshotBatch(work, time.Now())
		if err != nil && ctx.Err() == nil {
			logger.Error("player_snapshot_batch_failed", "completed", count, "error", err.Error())
		} else if count > 0 {
			logger.Info("player_snapshot_batch_completed", "count", count)
		}
	}
	run()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (a *API) runLegacySnapshotBatch(ctx context.Context, at time.Time) (int, error) {
	cfg, err := readLegacySnapshotCfg(ctx, a.pool)
	if err != nil || !cfg.Enabled {
		return 0, err
	}
	// Oldest due players go first; a failed or busy player cannot prevent the
	// remaining batch from receiving their backups.
	count := 0
	var failed error
	var afterTime, afterOwner int64 = -1, 0
	for {
		rows, err := a.pool.Query(ctx, `SELECT i.account_id,COALESCE((s.value->-1->>'ts')::bigint,0) FROM fishing.identities i
 LEFT JOIN fishing.operator_settings s ON s.key='users:snapshots:'||i.account_id::text
 WHERE NOT i.retired AND COALESCE((s.value->-1->>'ts')::bigint,0)<=$1
 AND (COALESCE((s.value->-1->>'ts')::bigint,0),i.account_id)>($3::bigint,$4::bigint)
 ORDER BY COALESCE((s.value->-1->>'ts')::bigint,0),i.account_id LIMIT $2`, at.Add(-time.Duration(cfg.IntervalMin)*time.Minute).UnixMilli(), legacySnapshotBatchSize, afterTime, afterOwner)
		if err != nil {
			return count, errors.Join(failed, err)
		}
		var owners []int64
		for rows.Next() {
			if err := rows.Scan(&afterOwner, &afterTime); err != nil {
				rows.Close()
				return count, errors.Join(failed, err)
			}
			owners = append(owners, afterOwner)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return count, errors.Join(failed, err)
		}
		for _, owner := range owners {
			if ctx.Err() != nil {
				return count, errors.Join(failed, ctx.Err())
			}
			written, err := a.writeDueLegacySnapshot(ctx, owner, at)
			if err != nil {
				failed = errors.Join(failed, err)
			} else if written {
				count++
			}
		}
		if len(owners) < legacySnapshotBatchSize {
			return count, failed
		}
	}
}

func (a *API) writeDueLegacySnapshot(ctx context.Context, owner int64, at time.Time) (bool, error) {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked int64
	err = tx.QueryRow(ctx, `SELECT p.account_id FROM fishing.player_state p JOIN fishing.identities i ON i.account_id=p.account_id
 WHERE p.account_id=$1 AND NOT i.retired FOR UPDATE OF p SKIP LOCKED`, owner).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Recheck after acquiring the player lock: another server/manual request
	// may have written a snapshot, or the operator may have disabled the job.
	cfg, err := readLegacySnapshotCfg(ctx, tx)
	if err != nil || !cfg.Enabled {
		return false, err
	}
	records, err := readLegacySnapshotRecords(ctx, tx, owner, true)
	if err != nil {
		return false, err
	}
	for _, record := range records {
		if at.Sub(time.UnixMilli(record.TS)) < time.Duration(cfg.IntervalMin)*time.Minute {
			return false, nil
		}
	}
	if _, err := a.writeLegacySnapshotAtTx(ctx, tx, owner, cfg, at); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}
