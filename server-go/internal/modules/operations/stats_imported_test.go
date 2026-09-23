package operations

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
)

func TestIntegrationImportedStatsPreserveWeightsAndAvoidOverlap(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	hour := time.Now().Add(-2 * time.Hour).Truncate(time.Hour)
	old := map[string]any{"statMin": []any{map[string]any{"t": hour.Add(30 * time.Minute).UnixMilli()}}, "statHour": []any{map[string]any{"t": hour.UnixMilli(), "n": 30, "oSum": 300, "oMax": 15, "fSum": 60, "lSum": 90, "trSum": 30, "uLast": 50, "gSum": map[string]int{"map": 60}, "sSum": map[string]int{"map:dock": 30}}}, "statPeak": map[string]any{"online": 80, "t": hour.Add(-time.Hour).UnixMilli()}}
	raw, _ := json.Marshal(old)
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('migration:stats',$1)`, raw); err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{hour.Add(30 * time.Minute), hour.Add(31 * time.Minute)} {
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.activity_samples(sampled_at,online,fishing,listings,trades,players,grounds,spots) VALUES($1,20,4,6,2,51,'{"map":4}','{"map:dock":2}')`, at); err != nil {
			t.Fatal(err)
		}
	}
	report, err := New(db.App).StatsReport(ctx, "7d", StatsFilter{Spot: "map:dock"}, "+00:00")
	if err != nil {
		t.Fatal(err)
	}
	var point *StatsPoint
	for i := range report.Points {
		if report.Points[i].T == hour.UnixMilli() {
			point = &report.Points[i]
			break
		}
	}
	if point == nil || point.N != 31 || point.Online != 10.3 || point.OnlineMax != 20 || point.Area == nil || *point.Area != 1 {
		t.Fatalf("hourly aggregates overlap or lose weights: %+v", point)
	}
	if report.Peak.Online != 80 {
		t.Fatal("historic peak lost")
	}
	if report.Samples.Hour != 1 {
		t.Fatal("hour overlap double-counted")
	}
}
