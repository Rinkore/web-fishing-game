package migration

import (
	"context"
	"testing"
	"time"

	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestRealResumeWaitsForStreamAndDoesNotPayOfflineCatches(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err = db.Admin.Exec(ctx, q, owner); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	rc := &RealContext{Tx: tx, Catalog: c, IDs: map[string]int64{"synthetic": owner}, Now: time.Now()}
	accounts := []RealAccount{{Key: "synthetic", Payload: map[string]any{"lastFishing": map[string]any{"groundId": "map", "spotId": "dock", "at": int64(1)}}}}
	if err = ImportRealResume(ctx, rc, accounts); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealResume(ctx, rc, accounts); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	s := fishing.NewNative(db.App, c)
	_, batch, err := s.Sweep(ctx, fishing.Cursor{}, 100, 1)
	if err != nil {
		t.Fatal(err)
	}
	if batch.Candidates != 0 || batch.Settled != 0 {
		t.Fatal("paused migrated session earned offline income")
	}
	var count int
	if err = db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.fishing_connections`).Scan(&count); err != nil || count != 0 {
		t.Fatal("migration manufactured a connection")
	}
	r, err := s.Stream(ctx, owner, "resume-test-open", "11111111111111111111111111111111", "open")
	if err != nil || r.Status != "connected" {
		t.Fatalf("stream did not resume: %v %s", err, r.Status)
	}
	var state string
	var due, now time.Time
	if err = db.Admin.QueryRow(ctx, `SELECT state,due_at,clock_timestamp() FROM fishing.native_fishing_sessions WHERE owner_id=$1`, owner).Scan(&state, &due, &now); err != nil {
		t.Fatal(err)
	}
	if state != "active" || !due.After(now) {
		t.Fatal("reconnect reused an offline deadline")
	}
	_, batch, err = s.Sweep(ctx, fishing.Cursor{}, 100, 1)
	if err != nil || batch.Settled != 0 {
		t.Fatal("reconnect paid prior elapsed time")
	}
	if err = db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.native_fishing_settlements`).Scan(&count); err != nil || count != 0 {
		t.Fatal("unexpected pre-cast settlement")
	}
	if _, err := s.Stream(ctx, owner, "resume-test-close", "11111111111111111111111111111111", "close"); err != nil {
		t.Fatal(err)
	}
}

func TestRealResumeArchivesRemovedLocations(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	rc := &RealContext{Catalog: c, IDs: map[string]int64{"old": 1, "valid": 2}}
	rows, err := planRealResume(rc, []RealAccount{{Key: "old", Payload: map[string]any{"lastFishing": map[string]any{"groundId": "stillwater", "spotId": "dock"}}}, {Key: "valid", Payload: map[string]any{"lastFishing": map[string]any{"groundId": "map", "spotId": "dock"}}}})
	if err != nil || len(rows) != 1 || rows[0].owner != 2 {
		t.Fatal("removed source location was revived")
	}
}
