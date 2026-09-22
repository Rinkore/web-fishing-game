package migration

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"fishing.local/server/internal/testdb"
)

func writeFixture(t *testing.T, root string) {
	t.Helper()
	files := map[string]string{
		"accounts/alice.json": `{"id":"legacy-1","username":"alice","name":"Alice","qq":"000001","pwHash":"$scrypt$synthetic$alice","coins":100,"inventory":{"crucian":5},"bigfish":{"crucian":{"L":1,"G":1}},"codex":{"crucian":{"count":2}}}`,
		"market.json":         `{"listings":[{"lid":7,"seller":"alice","id":"crucian","qty":2,"remaining":2,"price":10,"state":"escrowed"}]}`,
		"records.json":        `{}`,
		"economy.json":        `{}`,
		"config.json":         `{"items":[{"id":"crucian","kind":"fish"}]}`,
	}
	for name, body := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImportFailureRecoveryAndIdempotency(t *testing.T) {
	db := testdb.New(t, true)
	root := t.TempDir()
	writeFixture(t, root)
	ctx := context.Background()
	failed, err := Import(ctx, db.Admin, Options{Root: root, SourceVersion: "v0.21.4", RunID: "11111111-1111-5111-8111-111111111111", FailAfter: 1})
	if err == nil || failed.State != "" {
		t.Fatalf("fault injection unexpectedly succeeded: %+v %v", failed, err)
	}
	var state string
	if err := db.Admin.QueryRow(ctx, `SELECT state FROM fishing.migration_runs WHERE id=$1`, failed.RunID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "failed" {
		t.Fatalf("failed state not durable: %s", state)
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.accounts`); n != 0 {
		t.Fatalf("partial account survived failed transaction: %d", n)
	}
	result, err := Import(ctx, db.Admin, Options{Root: root, SourceVersion: "v0.21.4", RunID: failed.RunID})
	if err != nil || result.State != "reconciled" || !result.Reconciled {
		t.Fatalf("recovery import failed: %+v %v", result, err)
	}
	checked, err := Reconcile(ctx, db.Admin, failed.RunID)
	if err != nil || !checked.Reconciled || len(checked.Diffs) != 0 {
		t.Fatalf("field-level reconciliation failed: %+v %v", checked, err)
	}
	again, err := Import(ctx, db.Admin, Options{Root: root, SourceVersion: "v0.21.4", RunID: failed.RunID})
	if err != nil || again.State != "reconciled" {
		t.Fatalf("repeat import not idempotent: %+v %v", again, err)
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.accounts`); n != 1 {
		t.Fatalf("duplicate account after repeat: %d", n)
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.asset_operations`); n != 2 {
		t.Fatalf("opening/listing operations duplicated or missing: %d", n)
	}
	if n := count(t, db, `SELECT quantity FROM fishing.inventory_stacks WHERE item_id='crucian' AND tier='normal'`); n != 1 {
		t.Fatalf("escrow conservation failed, available quantity=%d", n)
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.market_orders WHERE remaining=2 AND state='open'`); n != 1 {
		t.Fatalf("escrow order missing: %d", n)
	}
}

func TestImportPersistsBlockingGapAfterRollback(t *testing.T) {
	db := testdb.New(t, true)
	root := t.TempDir()
	writeFixture(t, root)
	if err := os.WriteFile(filepath.Join(root, "records.json"), []byte(`{"bigRecords":{"crucian":{"owner":"legacy-1","value":42}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := Import(context.Background(), db.Admin, Options{Root: root, SourceVersion: "v0.21.4", RunID: "22222222-2222-5222-8222-222222222222"})
	if err == nil || !errors.Is(err, ErrBlocked) || result.State != "failed" || len(result.Gaps) == 0 {
		t.Fatalf("blocking source was accepted: %+v %v", result, err)
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.migration_gaps WHERE run_id='22222222-2222-5222-8222-222222222222' AND blocking`); n == 0 {
		t.Fatal("blocking gap was not durable")
	}
	if n := count(t, db, `SELECT count(*) FROM fishing.accounts`); n != 0 {
		t.Fatalf("blocked import wrote business rows: %d", n)
	}
}

func count(t *testing.T, db testdb.DB, query string) int {
	t.Helper()
	var n int
	if err := db.Admin.QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
