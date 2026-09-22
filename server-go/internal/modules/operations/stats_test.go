package operations

import (
	"context"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
)

// TestIntegrationStatsSamplerAndReport covers the durable sampling path behind
// the console heat map: the minute bucket, the 30 day retention and the
// aggregations the report publishes.
func TestIntegrationStatsSamplerAndReport(t *testing.T) {
	db := testdb.New(t, true)
	service := New(db.App)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		at := time.Now().Add(time.Duration(-(i+1)*10) * time.Minute).Truncate(time.Minute)
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.activity_samples(sampled_at,online,fishing,listings,trades,players,grounds,spots)
 VALUES($1,$2,1,2,3,4,'{"map":1}','{"map:dock":2}')`, at, 4+i); err != nil {
			t.Fatal(err)
		}
	}
	report, err := service.StatsReport(ctx, "1h", StatsFilter{}, "+08:00")
	if err != nil {
		t.Fatal(err)
	}
	if report.Samples.Min != 3 || len(report.Points) < 3 {
		t.Fatalf("sampled points: %+v", report)
	}
	if report.Peak.Online != 6 {
		t.Fatalf("peak online: %d", report.Peak.Online)
	}
	heat := false
	for _, row := range report.Heat {
		for _, cell := range row {
			if cell != nil {
				heat = true
			}
		}
	}
	if !heat {
		t.Fatal("heat grid lost the samples")
	}
	filtered, err := service.StatsReport(ctx, "1h", StatsFilter{Spot: "map:dock"}, "+08:00")
	if err != nil {
		t.Fatal(err)
	}
	if filtered.Points[0].Area == nil || *filtered.Points[0].Area != 2 {
		t.Fatalf("spot filter series: %+v", filtered.Points[0])
	}
	if _, err := service.StatsReport(ctx, "forever", StatsFilter{}, "+08:00"); err != nil {
		t.Fatalf("unknown range must fall back to 24h: %v", err)
	}

	if err := service.SampleOnce(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	// The bucket is the primary key: a repeated sample inside the same minute
	// must not duplicate it.
	if err := service.SampleOnce(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.activity_samples`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("sample retention: %d", count)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.activity_samples(sampled_at,online,fishing,listings,trades,players)
 VALUES(clock_timestamp()-interval '31 days',9,0,0,0,0)`); err != nil {
		t.Fatal(err)
	}
	if err := service.SampleOnce(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.activity_samples`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 4 {
		t.Fatalf("expired samples must be pruned: %d", count)
	}
}
