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

type DB struct{ Admin, App *pgxpool.Pool }

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
	appConfig := c.Copy()
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
