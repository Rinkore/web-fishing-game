package economy

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationConfigurePreservesLegacyNoSellAndSerializesDisable(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	catalog, e := rules.Default()
	if e != nil {
		t.Fatal(e)
	}
	service := New(db.App, catalog)
	var owner int64
	if e = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); e != nil {
		t.Fatal(e)
	}
	for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, e = db.Admin.Exec(ctx, sql, owner); e != nil {
			t.Fatal(e)
		}
	}
	legacy := rules.AutoSellRule{On: true, Keep: float64(3), SlackPct: 4}
	seed := map[string]rules.AutoSellRule{"tide_sand": legacy}
	raw, _ := json.Marshal(seed)
	if _, e = db.Admin.Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,rules) VALUES($1,$2)`, owner, raw); e != nil {
		t.Fatal(e)
	}
	preserved := Settings{IncludeTiers: true, Rules: map[string]rules.AutoSellRule{"tide_sand": legacy, "crucian": {On: true, Keep: 0}}}
	if r, e := service.Configure(ctx, owner, "preserve-existing", preserved); e != nil || r.Status != "configured" {
		t.Fatal("legacy rule blocked unrelated configuration")
	}
	for name, cfg := range map[string]Settings{
		"unknown":        {Rules: map[string]rules.AutoSellRule{"not_an_item": {}}},
		"equipment":      {Rules: map[string]rules.AutoSellRule{"rod_bamboo": {}}},
		"new-nosell":     {Rules: map[string]rules.AutoSellRule{"dragon_scale": {On: false, Keep: 0}}},
		"changed-nosell": {Rules: map[string]rules.AutoSellRule{"tide_sand": {On: true, Keep: 4, SlackPct: 4}}},
	} {
		if r, e := service.Configure(ctx, owner, name, cfg); e == nil && r.Status == "configured" {
			t.Fatalf("forbidden configuration accepted: %s", name)
		}
	}
	// Hold the same player guard as Configure, then change the stored rule.
	// The queued stale save must validate only after the lock becomes available.
	locker, e := db.Admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer locker.Rollback(ctx)
	if _, e = locker.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, owner); e != nil {
		t.Fatal(e)
	}
	done := make(chan bool, 1)
	go func() {
		r, e := service.Configure(ctx, owner, "stale-preserve", preserved)
		done <- e == nil && r.Status == "configured"
	}()
	waiting := false
	deadline := time.Now().Add(800 * time.Millisecond)
	for time.Now().Before(deadline) {
		if e = db.Admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock')`, db.Role).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !waiting {
		t.Fatal("concurrent configure did not wait on player guard")
	}
	closed := legacy
	closed.On = false
	closedRaw, _ := json.Marshal(map[string]rules.AutoSellRule{"tide_sand": closed})
	if _, e = locker.Exec(ctx, `UPDATE fishing.autosell_settings SET rules=$2 WHERE owner_id=$1`, owner, closedRaw); e != nil {
		t.Fatal(e)
	}
	if e = locker.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case succeeded := <-done:
		if succeeded {
			t.Fatal("stale configuration re-enabled disabled no-sell rule")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued configure did not finish")
	}
	if r, e := service.Configure(ctx, owner, "keep-closed", Settings{Rules: map[string]rules.AutoSellRule{"tide_sand": closed}}); e != nil || r.Status != "configured" {
		t.Fatal("closed legacy rule could not be preserved")
	}
	if r, e := service.Configure(ctx, owner, "reenable", preserved); e == nil && r.Status == "configured" {
		t.Fatal("disabled no-sell rule re-enabled")
	}
	if r, e := service.Configure(ctx, owner, "remove", Settings{}); e != nil || r.Status != "configured" {
		t.Fatal("legacy no-sell rule could not be removed")
	}
	if r, e := service.Configure(ctx, owner, "recreate", Settings{Rules: map[string]rules.AutoSellRule{"tide_sand": closed}}); e == nil && r.Status == "configured" {
		t.Fatal("removed no-sell rule recreated")
	}
}
