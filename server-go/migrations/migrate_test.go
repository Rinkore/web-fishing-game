package migrations_test

import (
	"context"
	"sync"
	"testing"

	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
)

func TestIntegrationMigrations(t *testing.T) {
	db := testdb.New(t, false)
	ctx := context.Background()
	if migrations.Check(ctx, db.Admin) == nil {
		t.Fatal("empty schema accepted")
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := migrations.Apply(ctx, db.Admin); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if err := migrations.Check(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Admin.QueryRow(ctx, "SELECT count(*) FROM public.fishing_schema_migrations").Scan(&count); err != nil || count != migrations.Count() {
		t.Fatalf("applied %d migrations, binary ships %d", count, migrations.Count())
	}
	if _, err := db.Admin.Exec(ctx, "UPDATE public.fishing_schema_migrations SET checksum='tampered'"); err != nil {
		t.Fatal(err)
	}
	if migrations.Check(ctx, db.Admin) == nil || migrations.Apply(ctx, db.Admin) == nil {
		t.Fatal("changed migration history accepted")
	}
}

func TestIntegrationDDLFailureRollsBack(t *testing.T) {
	db := testdb.New(t, false)
	ctx := context.Background()
	if _, err := db.Admin.Exec(ctx, "CREATE SCHEMA fishing"); err != nil {
		t.Fatal(err)
	}
	if migrations.Apply(ctx, db.Admin) == nil {
		t.Fatal("schema collision accepted")
	}
	var absent bool
	if err := db.Admin.QueryRow(ctx, "SELECT to_regclass('public.fishing_schema_migrations') IS NULL").Scan(&absent); err != nil || !absent {
		t.Fatal("failed migration left partial metadata")
	}
}
