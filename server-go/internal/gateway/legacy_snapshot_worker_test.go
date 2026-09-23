package gateway

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestIntegrationLegacySnapshotWorkerPolicyAndConcurrentRuns(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	a := &API{pool: f.db.App}
	setPolicy := func(enabled bool) {
		t.Helper()
		if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('snapshot',jsonb_build_object('enabled',$1::boolean,'intervalMin',1,'keep',2)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, enabled); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Now()
	setPolicy(false)
	if count, err := a.runLegacySnapshotBatch(ctx, at); err != nil || count != 0 {
		t.Fatalf("disabled worker: %d %v", count, err)
	}
	setPolicy(true)
	// A busy account is skipped without blocking other player backups.
	blocker, err := f.db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, f.playerID); err != nil {
		t.Fatal(err)
	}
	if count, err := a.runLegacySnapshotBatch(ctx, at); err != nil || count != 1 {
		t.Fatalf("busy player batch: %d %v", count, err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if count, err := a.runLegacySnapshotBatch(ctx, at); err != nil || count != 1 {
		t.Fatalf("retry busy player: %d %v", count, err)
	}
	if count, err := a.runLegacySnapshotBatch(ctx, at.Add(59*time.Second)); err != nil || count != 0 {
		t.Fatalf("interval ignored: %d %v", count, err)
	}
	// Multiple server processes may run the scheduler, but the row guard and
	// timestamp check permit only one snapshot for each account in an interval.
	var group sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			count, err := a.runLegacySnapshotBatch(ctx, at.Add(time.Minute))
			if err != nil {
				t.Error(err)
			}
			results <- count
		}()
	}
	group.Wait()
	close(results)
	total := 0
	for count := range results {
		total += count
	}
	if total != 2 {
		t.Fatalf("concurrent workers wrote %d snapshots", total)
	}
	if count, err := a.runLegacySnapshotBatch(ctx, at.Add(2*time.Minute)); err != nil || count != 2 {
		t.Fatalf("next interval: %d %v", count, err)
	}
	records, err := readLegacySnapshotRecords(ctx, f.db.App, f.playerID, false)
	if err != nil || len(records) != 2 || records[0].TS != at.Add(time.Minute).UnixMilli() || records[1].TS != at.Add(2*time.Minute).UnixMilli() {
		t.Fatalf("retention: %+v %v", records, err)
	}
	setPolicy(false)
	if count, err := a.runLegacySnapshotBatch(ctx, at.Add(3*time.Minute)); err != nil || count != 0 {
		t.Fatalf("updated disabled policy ignored: %d %v", count, err)
	}

	// A corrupt player's record must be reported without preventing healthy
	// accounts from receiving their due backups.
	setPolicy(true)
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.operator_settings SET value='{}' WHERE key=$1`, snapshotSettingKey(f.playerID)); err != nil {
		t.Fatal(err)
	}
	if count, err := a.runLegacySnapshotBatch(ctx, at.Add(3*time.Minute)); err == nil || count != 1 {
		t.Fatalf("corrupt snapshot must remain visible and isolated: %d %v", count, err)
	}
}
