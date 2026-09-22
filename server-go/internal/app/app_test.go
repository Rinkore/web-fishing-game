package app

import (
	"context"
	"encoding/json"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
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
	if probe.Ping(ctx) == nil {
		t.Fatal("schema without item definitions ready")
	}
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
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

func TestIntegrationReadinessChecksCatalogDefinitions(t *testing.T) {
	for _, change := range []struct {
		name, sql string
	}{
		{"missing_fish", `DELETE FROM fishing.item_definitions WHERE id='crucian'`},
		{"wrong_kind", `UPDATE fishing.item_definitions SET kind='material' WHERE id='crucian'`},
		{"wrong_equipment_part", `UPDATE fishing.item_definitions SET part=CASE WHEN part='rod' THEN 'line' ELSE 'rod' END WHERE kind='equipment'`},
	} {
		t.Run(change.name, func(t *testing.T) {
			db := testdb.New(t, true)
			ctx := context.Background()
			c, err := rules.Default()
			if err != nil {
				t.Fatal(err)
			}
			if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
				t.Fatal(err)
			}
			// Readiness must work with the restricted runtime role and must
			// not require a published release for the built-in default rules.
			probe := dependencies{db.App}
			if err := probe.Ping(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Admin.Exec(ctx, change.sql); err != nil {
				t.Fatal(err)
			}
			if probe.Ping(ctx) == nil {
				t.Fatal("incompatible item definitions remained ready")
			}
		})
	}
}

func TestIntegrationReadinessUsesPublishedCatalog(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	c.Items = append(c.Items, rules.Item{ID: "readiness-material", Name: "Readiness fixture", Kind: "material"})
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	// Install a synthetic release that references one not-yet-seeded item.
	// This models an inconsistent restored database without bypassing checks
	// in the production publication command.
	_, err = db.Admin.Exec(ctx, `WITH account AS (
 INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id
), command AS (
 INSERT INTO fishing.command_results(actor_id,request_key,request_hash)
 SELECT id,'readiness-release',decode(repeat('00',32),'hex') FROM account RETURNING actor_id
), operation AS (
 INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version)
 SELECT actor_id,'readiness-release','catalog_publish','readiness-test' FROM command RETURNING id,actor_id
), release AS (
 INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog)
 SELECT id,actor_id,repeat('a',64),'readiness-test',$1::jsonb FROM operation RETURNING id
) UPDATE fishing.catalog_head SET release_id=(SELECT id FROM release) WHERE singleton`, raw)
	if err != nil {
		t.Fatal(err)
	}
	probe := dependencies{db.App}
	if probe.Ping(ctx) == nil {
		t.Fatal("checked built-in defaults instead of the published catalog")
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	if err := probe.Ping(ctx); err != nil {
		t.Fatal(err)
	}
}
