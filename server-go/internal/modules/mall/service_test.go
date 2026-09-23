package mall

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestIntegrationConcurrentLimitRetryResetAndRollback(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
		if _, err := db.Admin.Exec(ctx, sql, owner); err != nil {
			t.Fatal(err)
		}
	}
	a := assets.New(db.App)
	if _, err := a.ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: "fund", Reason: "reward", RuleVersion: "test-v1", Coins: 10000}); err != nil {
		t.Fatal(err)
	}
	s := New(db.App, c, time.UTC)
	results := make([]assets.Result, 8)
	errs := make([]error, 8)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Buy(ctx, Purchase{owner, fmt.Sprintf("buy-%d", i), "bait_pack", 5})
		}(i)
	}
	wg.Wait()
	success := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.Status == "purchased" {
			success++
		} else if r.Status != "mall_limit_exceeded" {
			t.Fatal(r.Status)
		}
		retry, err := s.Buy(ctx, Purchase{owner, fmt.Sprintf("buy-%d", i), "bait_pack", 5})
		if err != nil || retry.OperationID != r.OperationID || retry.Status != r.Status {
			t.Fatal("unstable retry", err)
		}
	}
	if success != 4 {
		t.Fatal("limit race", success)
	}
	view, err := s.View(ctx, owner)
	if err != nil || view.Items[0].Bought != 20 || *view.Items[0].Remain != 0 {
		t.Fatal("view", view, err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.mall_purchases SET cycle_key=cycle_key-1 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	r, err := s.Buy(ctx, Purchase{owner, "next-cycle", "bait_pack", 1})
	if err != nil || r.Status != "purchased" {
		t.Fatal("cycle reset", err, r.Status)
	}
	// Failure after wallet and inventory writes must also roll back the purchase counter.
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_mall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER fail_mall BEFORE INSERT OR UPDATE ON fishing.mall_purchases FOR EACH ROW EXECUTE FUNCTION fishing.fail_mall()`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Buy(ctx, Purchase{owner, "fault", "bait_pack", 1}); err == nil {
		t.Fatal("expected technical failure")
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_mall ON fishing.mall_purchases`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Buy(ctx, Purchase{owner, "fault", "bait_pack", 1})
	if err != nil || r.Status != "purchased" {
		t.Fatal("retry after rollback", err)
	}
	var coins, qty int64
	if err := db.Admin.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&coins); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='bait_pack' AND tier='normal'`, owner).Scan(&qty); err != nil {
		t.Fatal(err)
	}
	if coins != 9120 || qty != 22 {
		t.Fatal("rollback leaked assets", coins, qty)
	}
	// Insufficient funds must not consume a limited slot.
	r, err = s.Buy(ctx, Purchase{owner, "poor", "relic", 3})
	if err != nil || r.Status == "purchased" {
		t.Fatal("insufficient funds", err)
	}
	view, err = s.View(ctx, owner)
	var boughtRelic int64
	for _, item := range view.Items {
		if item.ID == "relic" {
			boughtRelic = item.Bought
		}
	}
	if err != nil || boughtRelic != 0 {
		t.Fatal("rejection consumed quota", err)
	}
}
