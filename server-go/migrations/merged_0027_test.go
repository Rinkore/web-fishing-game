package migrations_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

type migrationHistoryEntry struct {
	Checksum  string
	AppliedAt time.Time
}

func readMigrationHistory(t *testing.T, pool *pgxpool.Pool) map[string]migrationHistoryEntry {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT name,checksum,applied_at FROM public.fishing_schema_migrations ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := make(map[string]migrationHistoryEntry)
	for rows.Next() {
		var name string
		var entry migrationHistoryEntry
		if err := rows.Scan(&name, &entry.Checksum, &entry.AppliedAt); err != nil {
			t.Fatal(err)
		}
		out[name] = entry
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// Rebuild a previously published branch from its exact SQL bytes, without
// asking the current migrator to manufacture the historical fixture.
func applyHistorical0027Branch(t *testing.T, pool *pgxpool.Pool, branch string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE public.fishing_schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	names, err := filepath.Glob("*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name >= "0027" && name != branch {
			continue
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(data)); err != nil {
			t.Fatalf("historical %s: %v", name, err)
		}
		sum := sha256.Sum256(data)
		if _, err := pool.Exec(ctx, `INSERT INTO public.fishing_schema_migrations(name,checksum) VALUES($1,$2)`, name, hex.EncodeToString(sum[:])); err != nil {
			t.Fatal(err)
		}
	}
}

func seedMerged0027History(t *testing.T, pool *pgxpool.Pool, branch string) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
 INSERT INTO fishing.accounts OVERRIDING SYSTEM VALUE VALUES(1,'2026-09-01Z');
 INSERT INTO fishing.player_state(account_id) VALUES(1);
 INSERT INTO fishing.wallets(account_id,coins) VALUES(1,123);
 INSERT INTO fishing.item_definitions(id,kind) VALUES('crucian','fish');
 INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES(1,'historical-market',decode(repeat('22',32),'hex')),(1,'historical-catch',decode(repeat('33',32),'hex'));
 INSERT INTO fishing.asset_operations(id,actor_id,request_key,kind,rule_version) OVERRIDING SYSTEM VALUE VALUES(1,1,'historical-market','market_list','historic'),(2,1,'historical-catch','fishing_settle','historic');
 INSERT INTO fishing.market_orders(id,seller_id,kind,item_id,quantity,remaining,unit_price,hours,created_operation,created_at,expires_at) OVERRIDING SYSTEM VALUE VALUES(1,1,'stack','crucian',4,4,10,24,1,'2026-09-01Z','2026-09-02Z');
 INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at) VALUES(2,1,1,'crucian',1.25,'map','dock','2026-09-01Z');`); err != nil {
		t.Fatal(err)
	}
	if branch == "0027_admin_market.sql" {
		if _, err := pool.Exec(ctx, `INSERT INTO fishing.market_orders(id,seller_id,kind,item_id,quantity,remaining,unit_price,hours,created_operation,created_at,expires_at,source,supply_id) OVERRIDING SYSTEM VALUE VALUES(2,1,'stack','crucian',2,2,11,24,1,'2026-09-01Z','2026-09-02Z','admin','historical-supply')`); err != nil {
			t.Fatal(err)
		}
	}
	if branch == "0027_record_hides.sql" {
		if _, err := pool.Exec(ctx, `INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id,created_at) VALUES(2,1,'crucian','day','big',1,'2026-09-01Z'); UPDATE fishing.catch_record_moderation_guard SET revision=7`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestIntegrationMerged0027UpgradePaths(t *testing.T) {
	for _, test := range []struct{ name, branch string }{
		{name: "empty"},
		{name: "through0026", branch: "through0026"},
		{name: "adminMarketBranch", branch: "0027_admin_market.sql"},
		{name: "recordHidesBranch", branch: "0027_record_hides.sql"},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := testdb.New(t, false)
			ctx := context.Background()
			before := make(map[string]migrationHistoryEntry)
			if test.branch != "" {
				applyHistorical0027Branch(t, db.Admin, test.branch)
				seedMerged0027History(t, db.Admin, test.branch)
				before = readMigrationHistory(t, db.Admin)
			}
			if migrations.Check(ctx, db.Admin) == nil {
				t.Fatal("incomplete historical schema accepted as startup-ready")
			}
			if err := migrations.Apply(ctx, db.Admin); err != nil {
				t.Fatal(err)
			}
			if err := migrations.Check(ctx, db.Admin); err != nil {
				t.Fatal(err)
			}
			after := readMigrationHistory(t, db.Admin)
			if len(after) != migrations.Count() {
				t.Fatalf("history has %d steps; binary ships %d", len(after), migrations.Count())
			}
			for name, entry := range before {
				if after[name] != entry {
					t.Fatalf("upgrade rewrote historical migration %s", name)
				}
			}
			if test.branch == "" || test.branch == "through0026" {
				if after["0027_admin_market.sql"].AppliedAt.After(after["0027_record_hides.sql"].AppliedAt) {
					t.Fatal("new 0027 migrations were not applied in full-filename order")
				}
			}
			if err := migrations.Apply(ctx, db.Admin); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, readMigrationHistory(t, db.Admin)) {
				t.Fatal("repeated migration rewrote applied history")
			}
			if test.branch == "" {
				seedMerged0027History(t, db.Admin, "")
			}
			var intact bool
			if err := db.Admin.QueryRow(ctx, `SELECT
 (SELECT coins=123 FROM fishing.wallets WHERE account_id=1) AND
 (SELECT source='player' AND supply_id IS NULL AND quantity=4 AND remaining=4 AND unit_price=10 AND created_operation=1 AND created_at='2026-09-01Z' AND expires_at='2026-09-02Z' FROM fishing.market_orders WHERE id=1) AND
 (SELECT item_id='crucian' AND size=1.25 AND caught_at='2026-09-01Z' FROM fishing.catch_records WHERE operation_id=2 AND ordinal=1)`).Scan(&intact); err != nil || !intact {
				t.Fatal("upgrade changed market, catch or asset history", err)
			}
			if test.branch == "0027_admin_market.sql" {
				if err := db.Admin.QueryRow(ctx, `SELECT source='admin' AND supply_id='historical-supply' AND quantity=2 FROM fishing.market_orders WHERE id=2`).Scan(&intact); err != nil || !intact {
					t.Fatal("upgrade changed historical admin supply", err)
				}
			}
			if test.branch == "0027_record_hides.sql" {
				if err := db.Admin.QueryRow(ctx, `SELECT (SELECT revision=7 FROM fishing.catch_record_moderation_guard) AND (SELECT count(*)=1 FROM fishing.catch_record_hides WHERE operation_id=2 AND ordinal=1 AND board_range='day' AND board_kind='big' AND created_at='2026-09-01Z')`).Scan(&intact); err != nil || !intact {
					t.Fatal("upgrade changed historical record moderation", err)
				}
			}
			// Both resulting schemas remain usable, and their immutable identities
			// and ledgers remain guarded after fresh or historical upgrades.
			if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.market_orders(id,seller_id,kind,item_id,quantity,remaining,unit_price,hours,created_operation,expires_at,source,supply_id) OVERRIDING SYSTEM VALUE VALUES(3,1,'stack','crucian',1,1,1,6,1,'2026-09-02Z','admin','post-upgrade'); INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id) VALUES(2,1,'crucian','all','small',1)`); err != nil {
				t.Fatal("merged schema cannot write new supply and record hides", err)
			}
			for _, statement := range []string{
				`UPDATE fishing.market_orders SET source='admin' WHERE id=1`,
				`UPDATE fishing.market_orders SET supply_id='tampered' WHERE id=1`,
				`UPDATE fishing.catch_records SET size=2 WHERE operation_id=2 AND ordinal=1`,
				`DELETE FROM fishing.catch_record_hides`,
			} {
				if _, err := db.Admin.Exec(ctx, statement); err == nil {
					t.Fatal("merged schema allowed history mutation")
				}
			}
		})
	}
}

func TestIntegrationMerged0027RejectsChangedRecordHistory(t *testing.T) {
	db := testdb.New(t, false)
	ctx := context.Background()
	applyHistorical0027Branch(t, db.Admin, "0027_record_hides.sql")
	if _, err := db.Admin.Exec(ctx, `UPDATE public.fishing_schema_migrations SET checksum='tampered' WHERE name='0027_record_hides.sql'`); err != nil {
		t.Fatal(err)
	}
	before := readMigrationHistory(t, db.Admin)
	if migrations.Apply(ctx, db.Admin) == nil {
		t.Fatal("changed historical record migration accepted")
	}
	if !reflect.DeepEqual(before, readMigrationHistory(t, db.Admin)) {
		t.Fatal("rejected history was rewritten")
	}
	var present bool
	if err := db.Admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='fishing' AND table_name='market_orders' AND column_name='source')`).Scan(&present); err != nil || present {
		t.Fatal("rejected upgrade applied partial schema", err)
	}
}
