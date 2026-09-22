package app

import (
	"context"
	"testing"

	"fishing.local/server/internal/testdb"
	"fishing.local/server/migrations"
)

func TestIntegrationReadinessChecksSchema(t *testing.T) {
	db := testdb.New(t, false)
	probe := dependencies{db.Admin}
	ctx := context.Background()
	if probe.Ping(ctx) == nil {
		t.Fatal("empty schema ready")
	}
	if err := migrations.Apply(ctx, db.Admin); err != nil {
		t.Fatal(err)
	}
	if err := probe.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, "UPDATE public.fishing_schema_migrations SET checksum='incompatible'"); err != nil {
		t.Fatal(err)
	}
	if probe.Ping(ctx) == nil {
		t.Fatal("schema changed but remained ready")
	}
}
