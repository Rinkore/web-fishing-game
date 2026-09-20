package migrations_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"reflect"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
)

func TestIntegrationUpgradePreservesCoinHistory(t *testing.T) {
	db := testdb.New(t, false)
	ctx := context.Background()
	ddl, err := os.ReadFile("0001_asset_core.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, string(ddl)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, `CREATE TABLE public.fishing_schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(ddl)
	if _, err = db.Admin.Exec(ctx, `INSERT INTO public.fishing_schema_migrations(name,checksum) VALUES ('0001_asset_core.sql',$1)`, hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	// Seed the published v1 fingerprint, result and event contract explicitly,
	// rather than deriving the compatibility fixture from the new implementation.
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.accounts OVERRIDING SYSTEM VALUE VALUES (1,now()),(2,now()); INSERT INTO fishing.player_state(account_id,assets_rev) VALUES (1,1),(2,1); INSERT INTO fishing.wallets(account_id,coins) VALUES (1,75),(2,25)`); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("coin-transfer-v1:1:2:25"))
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES (1,'v1-transfer',$1,'{"status":"transferred","operationId":"1","senderBalance":75,"recipientBalance":25}')`, hash[:]); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES (1,'v1-transfer','coin_transfer','coin-transfer-v1'); INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES (1,1,-25,75),(1,2,25,25); INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES (1,'coins_transferred','{"sender":"1","recipient":"2","amount":25}')`); err != nil {
		t.Fatal(err)
	}
	if migrations.Check(ctx, db.Admin) == nil {
		t.Fatal("old schema accepted as ready")
	}
	if err = migrations.Apply(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	if err = migrations.Apply(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	if err = migrations.Check(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	s := assets.New(db.Admin)
	want := assets.Result{Status: "transferred", OperationID: "1", SenderBalance: 75, RecipientBalance: 25}
	r, err := s.TransferCoins(ctx, assets.Transfer{ActorID: 1, RecipientID: 2, Amount: 25, RequestKey: "v1-transfer"})
	if err != nil || !reflect.DeepEqual(r, want) {
		t.Fatalf("old request replay: %v %+v", err, r)
	}
	lookup, err := s.Lookup(ctx, 1, "v1-transfer")
	if err != nil || !reflect.DeepEqual(lookup, want) {
		t.Fatal("old result lookup changed")
	}
	var intact bool
	if err = db.Admin.QueryRow(ctx, `SELECT (SELECT coins FROM fishing.wallets WHERE account_id=1)=75 AND (SELECT coins FROM fishing.wallets WHERE account_id=2)=25 AND (SELECT count(*) FROM fishing.asset_operations)=1 AND (SELECT count(*) FROM fishing.asset_entries)=2 AND (SELECT count(*) FROM fishing.outbox_events)=1 AND (SELECT bool_and(assets_rev=1 AND rod_capacity=1) FROM fishing.player_state) AND (SELECT payload='{"sender":"1","recipient":"2","amount":25}'::jsonb FROM fishing.outbox_events WHERE operation_id=1)`).Scan(&intact); err != nil || !intact {
		t.Fatal("upgrade/replay changed existing assets or history")
	}
	r, err = s.TransferCoins(ctx, assets.Transfer{ActorID: 1, RecipientID: 2, Amount: 5, RequestKey: "v2-transfer"})
	if err != nil || r.Status != "transferred" || r.SenderBalance != 70 || r.RecipientBalance != 30 {
		t.Fatal("new transfer failed after upgrade")
	}
	if err = db.Admin.QueryRow(ctx, `SELECT payload='{"sender":"1","recipient":"2","amount":5}'::jsonb FROM fishing.outbox_events WHERE operation_id=$1`, r.OperationID).Scan(&intact); err != nil || !intact {
		t.Fatal("new transfer changed existing event contract")
	}
}
