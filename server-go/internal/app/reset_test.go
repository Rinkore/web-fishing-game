package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIntegrationFreshSaveClearsPlayersKeepsSchema(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	var account int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,'saltydog','Salty','123456','fixture')`,
		`INSERT INTO fishing.player_state(account_id) VALUES($1)`,
		`INSERT INTO fishing.wallets(account_id,coins) VALUES($1,500)`,
		`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'crucian','fish','normal',3)`,
		`INSERT INTO fishing.autosell_settings(owner_id,rules) VALUES($1,'{"enabled":true}')`,
	} {
		if _, err := db.Admin.Exec(ctx, statement, account); err != nil {
			t.Fatal(err)
		}
	}
	definitions, err := countRows(ctx, db.Admin, "item_definitions")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanFreshSave(ctx, db.Admin)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Rows["accounts"] != 1 || plan.Rows["inventory_stacks"] != 1 {
		t.Fatalf("plan lost the row counts: %v", plan.Rows)
	}
	if !contains(plan.Cleared, "accounts") || !contains(plan.Cleared, "wiki_guides") {
		t.Fatalf("plan does not clear player data: %v", plan.Cleared)
	}
	for _, name := range []string{"item_definitions", "operator_settings", "mail_tracking", "wiki_state"} {
		if !contains(plan.Preserved, name) {
			t.Fatalf("plan does not preserve %s: %v", name, plan.Preserved)
		}
		if contains(plan.Cleared, name) {
			t.Fatalf("plan clears preserved table %s", name)
		}
	}

	summary, err := FreshSave(ctx, db.Admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Cleared) == 0 || len(summary.Preserved) == 0 {
		t.Fatalf("reset summary is empty: %+v", summary)
	}
	for _, name := range []string{"accounts", "identities", "player_state", "wallets", "inventory_stacks", "autosell_settings"} {
		rows, err := countRows(ctx, db.Admin, name)
		if err != nil {
			t.Fatal(err)
		}
		if rows != 0 {
			t.Fatalf("%s still holds %d rows after the reset", name, rows)
		}
	}
	for _, name := range []string{"banner_state", "mail_tracking", "party_guard", "wiki_state"} {
		rows, err := countRows(ctx, db.Admin, name)
		if err != nil {
			t.Fatal(err)
		}
		if rows != 1 {
			t.Fatalf("preserved table %s lost its serializer row: %d", name, rows)
		}
	}
	// The catalog and feature heads are cleared with their release history, so
	// the reset must recreate the empty head rows the migrations seeded.
	for _, name := range []string{"catalog_head", "feature_head"} {
		rows, err := countRows(ctx, db.Admin, name)
		if err != nil {
			t.Fatal(err)
		}
		if rows != 1 {
			t.Fatalf("rebuilt table %s is not in its initial state: %d rows", name, rows)
		}
	}
	restored, err := countRows(ctx, db.Admin, "item_definitions")
	if err != nil {
		t.Fatal(err)
	}
	if restored != definitions {
		t.Fatalf("item definitions changed from %d to %d", definitions, restored)
	}
	var officialGuides int64
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.wiki_guides WHERE kind='official'`).Scan(&officialGuides); err != nil {
		t.Fatal(err)
	}
	if officialGuides == 0 {
		t.Fatal("official wiki content was not restored")
	}
	var userGuides int64
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.wiki_guides WHERE kind='user'`).Scan(&userGuides); err != nil {
		t.Fatal(err)
	}
	if userGuides != 0 {
		t.Fatalf("player wiki submissions survived the reset: %d", userGuides)
	}
	if err := migrations.Check(ctx, db.Admin); err != nil {
		t.Fatal("reset changed the schema ledger")
	}
	if err := (dependencies{db.App}).Ping(ctx); err != nil {
		t.Fatalf("runtime readiness failed after the reset: %v", err)
	}
	var reused int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&reused); err != nil {
		t.Fatal(err)
	}
	if reused != 1 {
		t.Fatalf("account sequence did not restart: %d", reused)
	}
}

func TestIntegrationFreshSaveRefusesWhileGameIsConnected(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	config := db.Admin.Config().ConnConfig.Copy()
	config.RuntimeParams["application_name"] = "fishing-go"
	other, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(context.Background())
	if _, err := FreshSave(ctx, db.Admin); err == nil || !strings.Contains(err.Error(), "stop the game service") {
		t.Fatalf("reset did not refuse a connected game: %v", err)
	}
}

// TestIntegrationFreshSaveKeepsPublishedConfig covers the production shape of a
// fresh save: the console already published rules and feature flags, so the
// reset must drop the players while the server keeps running the same
// configuration.
func TestIntegrationFreshSaveKeepsPublishedConfig(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	catalogDefaults, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, catalogDefaults); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(catalogDefaults)
	if err != nil {
		t.Fatal(err)
	}
	publisher := insertFixtureAccount(t, ctx, db.Admin, "publisher")
	player := insertFixtureAccount(t, ctx, db.Admin, "saltydog")

	catalogOp := insertFixtureOperation(t, ctx, db.Admin, publisher, "fixture:catalog", "catalog_publish")
	digest := sha256.Sum256(raw)
	var catalogRelease int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog) VALUES($1,$2,$3,$4,$5) RETURNING id`,
		catalogOp, publisher, hex.EncodeToString(digest[:]), catalog.Version(catalogDefaults), raw).Scan(&catalogRelease); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.catalog_head SET release_id=$1 WHERE singleton`, catalogRelease); err != nil {
		t.Fatal(err)
	}
	flags, err := json.Marshal(map[string]bool{"market": true, "trade": true})
	if err != nil {
		t.Fatal(err)
	}
	featureOp := insertFixtureOperation(t, ctx, db.Admin, publisher, "fixture:features", "feature_publish")
	flagDigest := sha256.Sum256(flags)
	var featureRelease int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.feature_releases(operation_id,actor_id,schema_version,digest,flags) VALUES($1,$2,1,$3,$4) RETURNING id`,
		featureOp, publisher, hex.EncodeToString(flagDigest[:]), flags).Scan(&featureRelease); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.feature_head SET release_id=$1 WHERE singleton`, featureRelease); err != nil {
		t.Fatal(err)
	}
	// A player transfer pins nothing and must not survive the reset.
	insertFixtureOperation(t, ctx, db.Admin, player, "fixture:transfer", "coin_transfer")

	wantRetained := map[string]int64{"accounts": 1, "asset_operations": 2, "command_results": 2}
	plan, err := PlanFreshSave(ctx, db.Admin)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"catalog_releases", "catalog_head", "feature_releases", "feature_head"} {
		if !contains(plan.Preserved, name) {
			t.Fatalf("plan does not preserve %s: %v", name, plan.Preserved)
		}
		if contains(plan.Cleared, name) {
			t.Fatalf("plan clears the published configuration table %s", name)
		}
	}
	if contains(plan.Preserved, "accounts") || contains(plan.Cleared, "accounts") {
		t.Fatalf("plan does not prune accounts: preserved=%v cleared=%v", plan.Preserved, plan.Cleared)
	}
	for name, want := range wantRetained {
		if plan.Retained[name] != want {
			t.Fatalf("plan keeps %d rows in %s, want %d: %v", plan.Retained[name], name, want, plan.Retained)
		}
	}

	summary, err := FreshSave(ctx, db.Admin)
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range wantRetained {
		if summary.Retained[name] != want {
			t.Fatalf("reset kept %d rows in %s, want %d: %v", summary.Retained[name], name, want, summary.Retained)
		}
	}
	effective, revision, err := catalog.Current(ctx, db.App)
	if err != nil {
		t.Fatal(err)
	}
	if revision != catalogRelease || catalog.Version(effective) != catalog.Version(catalogDefaults) {
		t.Fatalf("the published catalog changed: revision=%d want=%d", revision, catalogRelease)
	}
	var publishedFeatures int64
	if err := db.Admin.QueryRow(ctx, `SELECT release_id FROM fishing.feature_head WHERE singleton`).Scan(&publishedFeatures); err != nil {
		t.Fatal(err)
	}
	if publishedFeatures != featureRelease {
		t.Fatalf("the published feature flags changed: %d", publishedFeatures)
	}
	for _, name := range []string{"identities", "player_state", "wallets", "inventory_stacks", "autosell_settings"} {
		rows, err := countRows(ctx, db.Admin, name)
		if err != nil {
			t.Fatal(err)
		}
		if rows != 0 {
			t.Fatalf("%s still holds %d rows after the reset", name, rows)
		}
	}
	var survivor int64
	if err := db.Admin.QueryRow(ctx, `SELECT id FROM fishing.accounts`).Scan(&survivor); err != nil {
		t.Fatal(err)
	}
	if survivor != publisher {
		t.Fatalf("the reset kept account %d instead of the publisher %d", survivor, publisher)
	}
	var reused int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&reused); err != nil {
		t.Fatal(err)
	}
	if reused == publisher || reused == player {
		t.Fatalf("the reset reused an identity that a kept row still holds: %d", reused)
	}
	if err := migrations.Check(ctx, db.Admin); err != nil {
		t.Fatal("reset changed the schema ledger")
	}
	if err := (dependencies{db.App}).Ping(ctx); err != nil {
		t.Fatalf("runtime readiness failed after the reset: %v", err)
	}
}

func insertFixtureAccount(t *testing.T, ctx context.Context, pool *pgxpool.Pool, username string) int64 {
	t.Helper()
	var account int64
	if err := pool.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,$2,$2,'123456','fixture')`, account, username); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES($1)`, account); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,500)`, account); err != nil {
		t.Fatal(err)
	}
	return account
}

// insertFixtureOperation commits the command result and audited operation a
// console publication (or any other command) leaves behind.
func insertFixtureOperation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, actor int64, key, kind string) int64 {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,'{"status":"published"}')`,
		actor, key, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	var operation int64
	if err := pool.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,$3,'fixture') RETURNING id`,
		actor, key, kind).Scan(&operation); err != nil {
		t.Fatal(err)
	}
	return operation
}

func countRows(ctx context.Context, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, table string) (int64, error) {
	var rows int64
	err := pool.QueryRow(ctx, "SELECT count(*) FROM fishing."+pgx.Identifier{table}.Sanitize()).Scan(&rows)
	return rows, err
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
