package operations

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"fishing.local/server/internal/testdb"
)

func TestAutoNotifyHysteresisAndHold(t *testing.T) {
	cfg := AutoNotifyConfig{On: true, Rules: []AutoNotifyRule{{100, "records"}}, HysteresisPct: 10, HoldCount: 2}
	state, level := autoNotifyState{}, "all"
	for _, tc := range []struct {
		online int64
		want   string
		count  int
	}{{109, "all", 0}, {110, "all", 1}, {110, "records", 0}, {90, "records", 0}, {89, "records", 1}, {89, "all", 0}} {
		level, state = nextAutoNotify(cfg, level, tc.online, state)
		if level != tc.want || state.Count != tc.count {
			t.Fatalf("online=%d: level=%s count=%d", tc.online, level, state.Count)
		}
	}
	cfg.On = false
	level, state = nextAutoNotify(cfg, "offrange", 200, state)
	if level != "offrange" || state.Count != 0 {
		t.Fatal("disabled automation changed level")
	}
}

func TestIntegrationAutoNotifyTickIsSharedAndDisabledIsReadOnly(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('legacy:settings','{"notifyLevel":"all","autoNotify":{"on":true,"rules":[{"min":0,"level":"none"}],"hysteresisPct":10,"holdCount":2}}')`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- New(db.App).AutoNotifyOnce(ctx) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var raw []byte
	if err := db.Admin.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key='legacy:settings'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var setting struct {
		NotifyLevel string          `json:"notifyLevel"`
		State       autoNotifyState `json:"autoNotifyState"`
	}
	_ = json.Unmarshal(raw, &setting)
	if setting.NotifyLevel != "all" || setting.State.Count != 1 {
		t.Fatalf("two servers counted one tick twice: %s", raw)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.operator_settings SET value=jsonb_set(value,'{autoNotifyState,nextAt}','0') WHERE key='legacy:settings'`); err != nil {
		t.Fatal(err)
	}
	if err := New(db.App).AutoNotifyOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.operator_settings SET value=jsonb_set(value,'{autoNotify,on}','false') WHERE key='legacy:settings'`); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := db.Admin.QueryRow(ctx, `SELECT value::text FROM fishing.operator_settings WHERE key='legacy:settings'`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := New(db.App).AutoNotifyOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := db.Admin.QueryRow(ctx, `SELECT value::text FROM fishing.operator_settings WHERE key='legacy:settings'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("disabled automation wrote settings")
	}
}
