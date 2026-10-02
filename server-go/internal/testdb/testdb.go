// Package testdb creates isolated, synthetic databases only when explicitly
// pointed at a bootstrap database named fishing_test. Never use real saves.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Admin, App *pgxpool.Pool
	Role       string
}

// Grant adds SELECT/INSERT/UPDATE on the given schema-qualified, comma
// separated tables to the restricted application role. Bridged legacy domains
// that add their own migration call this before seeding; the grant stays
// explicit per table so the fixture keeps its least-privilege property (the app
// role must remain unable to touch operator and audit data).
func (db DB) Grant(t *testing.T, tables string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON "+tables+" TO "+pgx.Identifier{db.Role}.Sanitize()); err != nil {
		t.Fatal("cannot grant extra legacy permissions")
	}
}

func New(t *testing.T, migrate bool) DB {
	t.Helper()
	dsn := os.Getenv("FISHING_GO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL via FISHING_GO_TEST_DATABASE_URL")
	}
	c, err := pgxpool.ParseConfig(dsn)
	if err != nil || c.ConnConfig.Database != "fishing_test" {
		t.Fatal("integration bootstrap database must be fishing_test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	bootstrap, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		t.Fatal("cannot connect to integration bootstrap")
	}
	var random [10]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "fishing_test_" + hex.EncodeToString(random[:])
	role := name + "_app"
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(secret[:])
	quote := func(s string) string { return pgx.Identifier{s}.Sanitize() }
	if _, err := bootstrap.Exec(ctx, "CREATE DATABASE "+quote(name)); err != nil {
		bootstrap.Close()
		t.Fatal("cannot create isolated database")
	}
	db := DB{}
	t.Cleanup(func() {
		if db.App != nil {
			db.App.Close()
		}
		if db.Admin != nil {
			db.Admin.Close()
		}
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := bootstrap.Exec(cleanup, "DROP DATABASE "+quote(name)+" WITH (FORCE)"); err != nil {
			t.Error("isolated test database cleanup failed")
		}
		if _, err := bootstrap.Exec(cleanup, "DROP ROLE IF EXISTS "+quote(role)); err != nil {
			t.Error("isolated test role cleanup failed")
		}
		bootstrap.Close()
	})
	c = c.Copy()
	c.ConnConfig.Database = name
	c.MaxConns = 8
	db.Admin, err = pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		t.Fatal("cannot open isolated database")
	}
	if !migrate {
		return db
	}
	if err := migrations.Apply(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, "CREATE ROLE "+quote(role)+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"+password+"'"); err != nil {
		t.Fatal("cannot create restricted test role")
	}
	db.Role = role
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.gear_progress TO "+quote(role)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.house_state TO "+quote(role)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.house_steals TO "+quote(role)); err != nil {
		t.Fatal(err)
	}
	grants := "GRANT USAGE ON SCHEMA fishing TO " + quote(role) + `; GRANT SELECT ON public.fishing_schema_migrations TO ` + quote(role) + `; GRANT SELECT ON fishing.accounts TO ` + quote(role) + `; GRANT SELECT, UPDATE ON fishing.player_state, fishing.wallets TO ` + quote(role) + `; GRANT SELECT, INSERT, UPDATE ON fishing.command_results TO ` + quote(role) + `; GRANT SELECT, INSERT ON fishing.asset_operations, fishing.asset_entries, fishing.outbox_events TO ` + quote(role) + `; GRANT SELECT ON fishing.item_definitions TO ` + quote(role) + `; GRANT SELECT,INSERT,UPDATE ON fishing.inventory_stacks,fishing.equipment_instances,fishing.rod_loadouts TO ` + quote(role) + `; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.rod_components TO ` + quote(role) + `; GRANT SELECT,INSERT ON fishing.inventory_entries,fishing.equipment_entries,fishing.rod_entries TO ` + quote(role) + `; GRANT USAGE ON ALL SEQUENCES IN SCHEMA fishing TO ` + quote(role)
	if _, err := db.Admin.Exec(ctx, grants); err != nil {
		t.Fatal("cannot grant test application permissions")
	}
	prototypeGrants := "GRANT SELECT ON fishing.fishing_rules TO " + quote(role) +
		"; GRANT SELECT,INSERT,UPDATE ON fishing.fishing_connections,fishing.fishing_sessions,fishing.market_listings TO " + quote(role) +
		"; GRANT SELECT,INSERT ON fishing.fishing_settlements TO " + quote(role)
	if _, err := db.Admin.Exec(ctx, prototypeGrants); err != nil {
		t.Fatal("cannot grant prototype application permissions")
	}
	identityGrants := "GRANT INSERT ON fishing.accounts,fishing.player_state,fishing.wallets TO " + quote(role) +
		"; GRANT SELECT,INSERT,UPDATE ON fishing.identities TO " + quote(role) +
		"; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.auth_sessions,fishing.auth_attempts TO " + quote(role) +
		"; GRANT SELECT,INSERT ON fishing.player_events TO " + quote(role)
	if _, err := db.Admin.Exec(ctx, identityGrants); err != nil {
		t.Fatal("cannot grant identity permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.trades TO "+quote(role)); err != nil {
		t.Fatal("cannot grant trade permissions")
	}
	appConfig := c.Copy()
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.gateway_streams TO "+quote(role)); err != nil {
		t.Fatal("cannot grant stream permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.catalog_releases TO "+quote(role)+"; GRANT SELECT,UPDATE ON fishing.catalog_head TO "+quote(role)+"; GRANT INSERT ON fishing.item_definitions TO "+quote(role)); err != nil {
		t.Fatal("cannot grant catalog permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.catch_continuations TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.catch_segments TO "+quote(role)); err != nil {
		t.Fatal("cannot grant catch continuation permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.native_fishing_sessions TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.native_fishing_settlements,fishing.catch_records TO "+quote(role)); err != nil {
		t.Fatal("cannot grant native fishing permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.catch_record_hides TO "+quote(role)+"; GRANT SELECT,UPDATE ON fishing.catch_record_moderation_guard TO "+quote(role)); err != nil {
		t.Fatal("cannot grant record moderation permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,UPDATE ON fishing.party_guard TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE ON fishing.parties TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.party_members,fishing.party_invites TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.party_events TO "+quote(role)); err != nil {
		t.Fatal("cannot grant party permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.sea_quest_boards TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.sea_quest_roots TO "+quote(role)); err != nil {
		t.Fatal("cannot grant quest permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.sea_zones,fishing.sea_expeditions,fishing.sea_captains,fishing.mail_messages,fishing.mail_attachments,fishing.mail_batches,fishing.mail_recipients TO "+quote(role)); err != nil {
		t.Fatal("cannot grant voyage permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT ON fishing.mail_tracking TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.player_activity,fishing.inventory_binding_entries TO "+quote(role)); err != nil {
		t.Fatal("cannot grant mail binding permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.sea_players TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.sea_progress_entries TO "+quote(role)); err != nil {
		t.Fatal("cannot grant sea permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.feature_releases TO "+quote(role)+"; GRANT SELECT,UPDATE ON fishing.feature_head TO "+quote(role)); err != nil {
		t.Fatal("cannot grant feature publication permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT ON fishing.legacy_economy_history TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE ON fishing.economy_prices,fishing.autosell_settings TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.shop_sales TO "+quote(role)); err != nil {
		t.Fatal("cannot grant economy permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.friend_relations TO "+quote(role)); err != nil {
		t.Fatal("cannot grant friend permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.mall_purchases TO "+quote(role)); err != nil {
		t.Fatal("cannot grant mall permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.random_intents TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.chest_pity,fishing.player_codex TO "+quote(role)); err != nil {
		t.Fatal("cannot grant workshop permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.market_orders TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.market_order_equipment,fishing.market_fills,fishing.market_charges TO "+quote(role)); err != nil {
		t.Fatal("cannot grant order permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE ON fishing.subscription_settings,fishing.feedback_cooldowns,fishing.operator_settings TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.feedback_entries TO "+quote(role)); err != nil {
		t.Fatal("cannot grant notification permissions")
	}
	// The console audit table is append only for the application role; the
	// enrollment trail stays out of its reach on purpose.
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT ON fishing.admin_audit TO "+quote(role)+"; GRANT SELECT,INSERT,DELETE ON fishing.activity_samples TO "+quote(role)); err != nil {
		t.Fatal("cannot grant operator console permissions")
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.registration_limits,fishing.registration_challenges TO "+quote(role)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, "GRANT SELECT,UPDATE ON fishing.banner_state TO "+quote(role)+"; GRANT SELECT,INSERT ON fishing.banner_events TO "+quote(role)+"; GRANT SELECT,INSERT,UPDATE,DELETE ON fishing.banner_watchers TO "+quote(role)); err != nil {
		t.Fatal("cannot grant banner permissions")
	}
	appConfig.ConnConfig.User = role
	appConfig.ConnConfig.Password = password
	appConfig.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	appConfig.ConnConfig.RuntimeParams["lock_timeout"] = "1000"
	appConfig.ConnConfig.RuntimeParams["synchronous_commit"] = "on"
	db.App, err = pgxpool.NewWithConfig(ctx, appConfig)
	if err != nil || db.App.Ping(ctx) != nil {
		t.Fatal("cannot open restricted application pool")
	}
	return db
}
