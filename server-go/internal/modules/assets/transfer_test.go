package assets

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestInvalidTransferNeverAccessesDB(t *testing.T) {
	s := New(nil)
	for _, r := range []Transfer{{}, {1, 1, 1, "same"}, {1, 2, 0, "zero"}, {1, 2, MaxCoins + 1, "overflow"}, {1, 2, 1, "space key"}} {
		if _, err := s.TransferCoins(context.Background(), r); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid request accepted")
		}
	}
	if retryable(errors.New("network")) || retryable(&pgconn.PgError{Code: "23514"}) || !retryable(&pgconn.PgError{Code: "40P01"}) || !retryable(&pgconn.PgError{Code: "40001"}) {
		t.Fatal("unsafe retry classification")
	}
}

func TestIntegrationTransfers(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	s := New(db.App)
	initial := map[int64]int64{}
	seed := func(coins int64) int64 {
		t.Helper()
		var id int64
		if err := db.Admin.QueryRow(ctx, "INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id").Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(ctx, "INSERT INTO fishing.player_state(account_id) VALUES ($1)", id); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(ctx, "INSERT INTO fishing.wallets(account_id,coins) VALUES ($1,$2)", id, coins); err != nil {
			t.Fatal(err)
		}
		initial[id] = coins
		return id
	}
	balance := func(id int64) int64 {
		t.Helper()
		var n int64
		if err := db.Admin.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	check := func(r Transfer, status string) Result {
		t.Helper()
		result, err := s.TransferCoins(ctx, r)
		if err != nil || result.Status != status {
			t.Fatalf("status=%s error=%v; want %s", result.Status, err, status)
		}
		return result
	}

	t.Run("restricted-role", func(t *testing.T) {
		var super bool
		if err := db.App.QueryRow(ctx, "SELECT rolsuper FROM pg_roles WHERE rolname=current_user").Scan(&super); err != nil || super {
			t.Fatal("test application is privileged")
		}
		if _, err := db.App.Exec(ctx, "CREATE TABLE fishing.forbidden (id int)"); err == nil {
			t.Fatal("app can run DDL")
		}
		if _, err := db.App.Exec(ctx, "SET ROLE fishing_test_admin"); err == nil {
			t.Fatal("app can escalate to test administrator")
		}
	})
	t.Run("concurrent-replay-conflict-and-lookup", func(t *testing.T) {
		a, b := seed(100), seed(0)
		r := Transfer{a, b, 17, "duplicate"}
		var wg sync.WaitGroup
		results := make(chan Result, 16)
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				result, err := s.TransferCoins(ctx, r)
				if err != nil {
					t.Error(err)
					return
				}
				results <- result
			}()
		}
		wg.Wait()
		close(results)
		var first Result
		for result := range results {
			if first.OperationID == "" {
				first = result
			}
			if result != first {
				t.Error("replay changed result")
			}
		}
		if first.Status != "transferred" || balance(a) != 83 || balance(b) != 17 {
			t.Fatal("duplicate transfer changed assets")
		}
		stored, err := s.Lookup(ctx, a, r.RequestKey)
		if err != nil || stored != first {
			t.Fatal("lookup differs")
		}
		if _, err := s.Lookup(ctx, b, r.RequestKey); !errors.Is(err, ErrNotFound) {
			t.Fatal("lookup crossed actor boundary")
		}
		r.Amount++
		if _, err := s.TransferCoins(ctx, r); !errors.Is(err, ErrKeyConflict) {
			t.Fatal("key mismatch accepted")
		}
		if balance(a) != 83 {
			t.Fatal("conflicting request changed balance")
		}
	})
	t.Run("opposing-transfers-lock-order", func(t *testing.T) {
		a, b := seed(1000), seed(1000)
		var wg sync.WaitGroup
		for i := 0; i < 40; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				from, to := a, b
				if i%2 == 1 {
					from, to = b, a
				}
				result, err := s.TransferCoins(ctx, Transfer{from, to, 1, fmt.Sprintf("opposite-%d", i)})
				if err != nil || result.Status != "transferred" {
					t.Errorf("concurrent transfer failed: %v %s", err, result.Status)
				}
			}(i)
		}
		wg.Wait()
		if balance(a) != 1000 || balance(b) != 1000 {
			t.Fatal("opposing transfer balances differ")
		}
	})
	t.Run("concurrent-overspend", func(t *testing.T) {
		a, b := seed(10), seed(0)
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				r, err := s.TransferCoins(ctx, Transfer{a, b, 1, fmt.Sprintf("spend-%d", i)})
				if err != nil || r.Status != "transferred" && r.Status != "insufficient_funds" {
					t.Errorf("bad result %s %v", r.Status, err)
				}
			}(i)
		}
		wg.Wait()
		if balance(a) != 0 || balance(b) != 10 {
			t.Fatal("overspend or loss")
		}
	})
	t.Run("terminal-rejection-is-stable", func(t *testing.T) {
		a, b, c := seed(0), seed(0), seed(100)
		r := Transfer{a, b, 10, "rejected"}
		first := check(r, "insufficient_funds")
		check(Transfer{c, a, 20, "fund"}, "transferred")
		if replay := check(r, "insufficient_funds"); replay != first || balance(a) != 20 {
			t.Fatal("rejected request executed on retry")
		}
	})
	t.Run("missing-recipient-and-overflow", func(t *testing.T) {
		a, b := seed(100), seed(MaxCoins)
		check(Transfer{a, b, 1, "overflow"}, "balance_limit")
		check(Transfer{a, 999999999, 1, "missing"}, "account_not_found")
		if balance(a) != 100 || balance(b) != MaxCoins {
			t.Fatal("rejected transfer mutated balance")
		}
	})
	t.Run("failure-after-wallet-writes-rolls-back-everything", func(t *testing.T) {
		a, b := seed(100), seed(0)
		_, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
CREATE TRIGGER fail_outbox BEFORE INSERT ON fishing.outbox_events FOR EACH ROW EXECUTE FUNCTION fishing.fail_outbox()`)
		if err != nil {
			t.Fatal(err)
		}
		r := Transfer{a, b, 10, "rollback"}
		if _, err := s.TransferCoins(ctx, r); !errors.Is(err, ErrUnavailable) {
			t.Fatal("injected failure not surfaced")
		}
		if balance(a) != 100 || balance(b) != 0 {
			t.Fatal("partial wallet writes committed")
		}
		if _, err := s.Lookup(ctx, a, r.RequestKey); !errors.Is(err, ErrNotFound) {
			t.Fatal("partial command result committed")
		}
		var count int
		if err := db.Admin.QueryRow(ctx, "SELECT count(*) FROM fishing.asset_operations WHERE actor_id=$1", a).Scan(&count); err != nil || count != 0 {
			t.Fatal("partial operation committed")
		}
		if _, err := db.Admin.Exec(ctx, "DROP TRIGGER fail_outbox ON fishing.outbox_events; DROP FUNCTION fishing.fail_outbox()"); err != nil {
			t.Fatal(err)
		}
		check(r, "transferred")
	})
	t.Run("cancelled-lock-wait-can-retry", func(t *testing.T) {
		a, b := seed(10), seed(0)
		tx, err := db.Admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, "SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE", a); err != nil {
			t.Fatal(err)
		}
		short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		r := Transfer{a, b, 1, "cancelled"}
		_, err = s.TransferCoins(short, r)
		cancel()
		if err == nil || balance(a) != 10 {
			t.Fatal("cancelled request changed balance")
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		check(r, "transferred")
	})
	t.Run("confirmed-database-aborts-retry-whole-command", func(t *testing.T) {
		a, b := seed(100), seed(0)
		_, err := db.Admin.Exec(ctx, `CREATE SEQUENCE fishing.retry_attempts;
CREATE FUNCTION fishing.retry_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE attempt bigint;
BEGIN
  attempt := nextval('fishing.retry_attempts');
  IF attempt=1 THEN RAISE EXCEPTION 'injected serialization abort' USING ERRCODE='40001'; END IF;
  IF attempt=2 THEN RAISE EXCEPTION 'injected deadlock abort' USING ERRCODE='40P01'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retry_operation BEFORE INSERT ON fishing.asset_operations FOR EACH ROW EXECUTE FUNCTION fishing.retry_operation()`)
		if err != nil {
			t.Fatal(err)
		}
		check(Transfer{a, b, 10, "retry-aborts"}, "transferred")
		var attempts int
		if err := db.Admin.QueryRow(ctx, "SELECT last_value FROM fishing.retry_attempts").Scan(&attempts); err != nil || attempts != 3 {
			t.Fatal("did not retry exactly two confirmed aborts")
		}
		if balance(a) != 90 || balance(b) != 10 {
			t.Fatal("retry duplicated balance effect")
		}
		if _, err := db.Admin.Exec(ctx, `CREATE OR REPLACE FUNCTION fishing.retry_operation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN PERFORM nextval('fishing.retry_attempts'); RAISE EXCEPTION 'injected permanent abort' USING ERRCODE='40001'; END $$`); err != nil {
			t.Fatal(err)
		}
		if _, err := s.TransferCoins(ctx, Transfer{a, b, 10, "retry-limit"}); !errors.Is(err, ErrUnavailable) {
			t.Fatal("permanent abort incorrectly accepted")
		}
		if err := db.Admin.QueryRow(ctx, "SELECT last_value FROM fishing.retry_attempts").Scan(&attempts); err != nil || attempts != 6 {
			t.Fatal("retry exceeded three-attempt budget")
		}
		if balance(a) != 90 || balance(b) != 10 {
			t.Fatal("aborted attempts changed assets")
		}
		if _, err := db.Admin.Exec(ctx, "DROP TRIGGER retry_operation ON fishing.asset_operations; DROP FUNCTION fishing.retry_operation(); DROP SEQUENCE fishing.retry_attempts"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("ledger-outbox-and-revisions-reconcile", func(t *testing.T) {
		var bad int
		queries := []string{
			`SELECT count(*) FROM (SELECT o.id FROM fishing.asset_operations o LEFT JOIN fishing.asset_entries e ON e.operation_id=o.id GROUP BY o.id HAVING count(e.*)<>2 OR sum(e.delta)<>0) q`,
			`SELECT count(*) FROM fishing.asset_operations o LEFT JOIN fishing.outbox_events e ON e.operation_id=o.id WHERE e.id IS NULL`,
			`SELECT count(*) FROM fishing.command_results WHERE result IS NULL`,
			`SELECT count(*) FROM fishing.player_state p WHERE p.assets_rev<>(SELECT count(*) FROM fishing.asset_entries e WHERE e.account_id=p.account_id)`,
		}
		for _, q := range queries {
			if err := db.Admin.QueryRow(ctx, q).Scan(&bad); err != nil || bad != 0 {
				t.Fatalf("reconciliation failed count=%d error=%v", bad, err)
			}
		}
		for id, start := range initial {
			var delta int64
			if err := db.Admin.QueryRow(ctx, "SELECT COALESCE(sum(delta),0)::bigint FROM fishing.asset_entries WHERE account_id=$1", id).Scan(&delta); err != nil {
				t.Fatal(err)
			}
			if balance(id) != start+delta {
				t.Fatal("wallet does not reconcile to opening balance and ledger")
			}
		}
	})
}
