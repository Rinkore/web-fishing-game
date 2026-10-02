package catalog

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// legacyReleaseSnapshot builds the document an older binary would have
// published: the named constants are absent because that binary did not know
// about them yet, while the release's own operator override (a mall refresh
// time) is present and must survive the read.
func legacyReleaseSnapshot(t *testing.T, drop ...string) []byte {
	t.Helper()
	base, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(base)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &doc); err != nil {
		t.Fatal(err)
	}
	constants := map[string]json.RawMessage{}
	if err := json.Unmarshal(doc["constants"], &constants); err != nil {
		t.Fatal(err)
	}
	for _, name := range drop {
		if _, ok := constants[name]; !ok {
			t.Fatalf("built-in catalog has no constant %q to drop", name)
		}
		delete(constants, name)
	}
	if doc["constants"], err = json.Marshal(constants); err != nil {
		t.Fatal(err)
	}
	defaults := map[string]json.RawMessage{}
	if err := json.Unmarshal(doc["defaults"], &defaults); err != nil {
		t.Fatal(err)
	}
	mall := map[string]any{}
	if err := json.Unmarshal(defaults["mall"], &mall); err != nil {
		t.Fatal(err)
	}
	mall["refreshTime"] = "05:30"
	if defaults["mall"], err = json.Marshal(mall); err != nil {
		t.Fatal(err)
	}
	if doc["defaults"], err = json.Marshal(defaults); err != nil {
		t.Fatal(err)
	}
	doc["version"] = json.RawMessage(`"v0.23.4"`)
	snapshot, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

// TestIntegrationLegacyReleaseStaysPlayable pins the production incident end to
// end: the head pointed at a release published before HUT existed, so every hut
// command was rejected. The read path must serve the built-in section while
// keeping the values the release itself published.
func TestIntegrationLegacyReleaseStaysPlayable(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	snapshot := legacyReleaseSnapshot(t, "HUT")
	if _, err := db.Admin.Exec(ctx, `WITH account AS (
 INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id
), command AS (
 INSERT INTO fishing.command_results(actor_id,request_key,request_hash)
 SELECT id,'legacy-catalog-release',decode(repeat('00',32),'hex') FROM account RETURNING actor_id
), operation AS (
 INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version)
 SELECT actor_id,'legacy-catalog-release','catalog_publish','catch-v1:v0.23.4:legacy' FROM command RETURNING id,actor_id
), release AS (
 INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog)
 SELECT id,actor_id,repeat('b',64),'catch-v1:v0.23.4:legacy',$1::jsonb FROM operation RETURNING id
) UPDATE fishing.catalog_head SET release_id=(SELECT id FROM release) WHERE singleton`, snapshot); err != nil {
		t.Fatal(err)
	}

	c, revision, err := Effective(ctx, db.App)
	if err != nil {
		t.Fatal(err)
	}
	if revision == 0 {
		t.Fatal("the legacy release is not the served head")
	}
	if c.Version != "v0.23.4" {
		t.Fatalf("served catalog version = %q, want the published release", c.Version)
	}
	base, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if got := c.HutConfig(); !reflect.DeepEqual(got, base.HutConfig()) {
		t.Fatalf("hut config from the legacy release = %+v, want the built-in %+v", got, base.HutConfig())
	}
	if got := c.MallConfig().RefreshTime; got != "05:30" {
		t.Fatalf("the release's own mall override was replaced: %q", got)
	}
	// A pinned retry reads the same release, so it must stay consistent.
	pinned, err := ByVersion(ctx, db.App, "catch-v1:v0.23.4:legacy")
	if err != nil {
		t.Fatal(err)
	}
	if got := pinned.HutConfig(); !reflect.DeepEqual(got, base.HutConfig()) {
		t.Fatalf("pinned retry hut config = %+v, want the built-in %+v", got, base.HutConfig())
	}
}
