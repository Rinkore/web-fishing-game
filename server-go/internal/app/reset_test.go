package app

import (
	"context"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5"
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
