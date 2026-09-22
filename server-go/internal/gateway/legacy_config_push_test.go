package gateway

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func publishLegacyCatalog(t *testing.T, f *adminFixture, c *rules.Catalog, revision int64, key string) int64 {
	t.Helper()
	code, body := f.admin("POST", "/api/admin/v1/catalog", jsonString(map[string]any{
		"catalog": c, "requestKey": key, "expectedRevision": revision,
	}))
	if code != 200 {
		t.Fatalf("publish catalog: %d %v", code, body)
	}
	var id int64
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT release_id FROM fishing.catalog_head`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id <= revision {
		t.Fatalf("publication did not advance: %d %v", id, body)
	}
	return id
}

func TestIntegrationLegacyConfigurationPublication(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	var applied *rules.Catalog
	p := &legacyConfigPush{api: &API{pool: f.db.App}, apply: func(c *rules.Catalog) { applied = c }}
	fields := p.init(ctx)
	if fields["groundCfg"] == nil || applied == nil {
		t.Fatalf("init: %v", fields)
	}
	if initial := p.poll(ctx); len(initial) != 10 {
		t.Fatalf("initial configs: %d", len(initial))
	}
	if got := p.poll(ctx); len(got) != 0 {
		t.Fatalf("idle repeats: %v", got)
	}
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Runtime = map[string]any{
		"cast": map[string]any{"baseMs": float64(2500)}, "biteFormula": "25",
		"drop":       map[string]any{"material": float64(200)},
		"lootGroups": map[string]any{"fixture": []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}, {Pick: "material:rope", Weight: 1}}},
	}
	var grounds []map[string]any
	if err := json.Unmarshal(c.Constants["GROUNDS"], &grounds); err != nil {
		t.Fatal(err)
	}
	spot := grounds[0]["spots"].([]any)[0].(map[string]any)
	spot["pool"] = []rules.LootEntry{{Pick: "group:fixture", Weight: 6}, {Pick: "fish:crucian", Weight: 3}}
	c.Constants["GROUNDS"], _ = json.Marshal(grounds)
	var component map[string]any
	if err := json.Unmarshal(c.Defaults["component"], &component); err != nil {
		t.Fatal(err)
	}
	component["rollModel"] = "uniform"
	c.Defaults["component"], _ = json.Marshal(component)
	id := publishLegacyCatalog(t, f, c, 0, "config-first")
	frames := decodePersonalFrames(t, p.poll(ctx))
	seen := map[string]map[string]any{}
	for _, frame := range frames {
		seen[frame["type"].(string)] = frame
	}
	for _, kind := range []string{"componentcfg", "castcfg", "bitecfg", "groundcfg", "pricecfg"} {
		if seen[kind] == nil {
			t.Fatalf("missing %s: %v", kind, seen)
		}
	}
	if len(seen) != 5 || seen["castcfg"]["baseMs"] != float64(2500) || p.catalogRevision != id {
		t.Fatalf("published config: %v", seen)
	}
	quality := seen["componentcfg"]["componentCfg"].(map[string]any)["qualityWeights"]
	if _, ok := quality.(map[string]any); !ok {
		t.Fatalf("quality weights must remain an object: %v", quality)
	}
	if applied.CastRules(nil).BaseMS != 2500 {
		t.Fatal("connection still uses old catalog")
	}
	code, body := f.player("GET", "/api/grounds", "")
	if code != 200 || !reflect.DeepEqual(seen["groundcfg"]["grounds"], body["grounds"]) {
		t.Fatalf("HTTP/SSE differ: %d", code)
	}
	g := body["grounds"].([]any)[0].(map[string]any)
	s := g["spots"].([]any)[0].(map[string]any)
	pool := s["pool"].([]any)
	if s["pos"] == nil || len(pool) != 2 || pool[0].(map[string]any)["weight"] != float64(5) || pool[1].(map[string]any)["weight"] != float64(4) {
		t.Fatalf("flattened weighted pool or display metadata: %v", s)
	}
	// Publishing the same content advances durable history without causing a
	// storm of UI refresh/start requests on every connected browser.
	id = publishLegacyCatalog(t, f, c, id, "config-identical")
	if got := p.poll(ctx); len(got) != 0 || p.catalogRevision != id {
		t.Fatalf("identical publication: %v", got)
	}
	// A committed publication must survive a temporary read error.
	c.Runtime["cast"] = map[string]any{"baseMs": float64(3500)}
	id = publishLegacyCatalog(t, f, c, id, "config-retry")
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(ctx, "REVOKE SELECT ON fishing.catalog_releases FROM "+role); err != nil {
		t.Fatal(err)
	}
	if got := p.poll(ctx); len(got) != 0 || p.catalogRevision == id {
		t.Fatalf("failed read acknowledged: %v", got)
	}
	if _, err := f.db.Admin.Exec(ctx, "GRANT SELECT ON fishing.catalog_releases TO "+role); err != nil {
		t.Fatal(err)
	}
	got := decodePersonalFrames(t, p.poll(ctx))
	if len(got) != 1 || got[0]["type"] != "castcfg" || got[0]["baseMs"] != float64(3500) {
		t.Fatalf("retry: %v", got)
	}
	// A new connection starts from the current release and still sends the
	// complete config set even if no further publication occurs.
	reconnected := &legacyConfigPush{api: &API{pool: f.db.App}}
	reconnected.init(ctx)
	if reconnected.catalogRevision != id || len(reconnected.poll(ctx)) != 8 {
		t.Fatal("reconnect lost current publication")
	}
}

func TestIntegrationLegacyConfigInitWindowAndFeatureMapping(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	p := &legacyConfigPush{api: &API{pool: f.db.App}}
	p.init(ctx)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Runtime = map[string]any{"cast": map[string]any{"speedBonus": float64(50)}}
	publishLegacyCatalog(t, f, c, 0, "init-window")
	got := decodePersonalFrames(t, p.poll(ctx))
	if len(got) != 11 || got[len(got)-1]["speedBonus"] != float64(50) {
		t.Fatalf("init window: %v", got)
	}
	flags := map[string]bool{"market": false, "trade": false, "workshop": false, "chest": true, "mall": false, "sell": false, "autosell": true, "friends": true}
	body := jsonString(map[string]any{"flags": flags, "requestKey": "feature-config", "expectedRevision": "0"})
	code, _ := f.player("POST", "/api/admin/v1/features", body)
	if code == 200 {
		t.Fatal("player published operator config")
	}
	code, response := f.admin("POST", "/api/admin/v1/features", body)
	if code != 200 {
		t.Fatalf("feature publication: %d %v", code, response)
	}
	got = decodePersonalFrames(t, p.poll(ctx))
	if len(got) != 1 || got[0]["type"] != "features" {
		t.Fatalf("feature event: %v", got)
	}
	projected := got[0]["features"].(map[string]any)
	for _, id := range []string{"mall.list", "mall.marketbuy", "ground.trade", "workshop.smelt", "workshop.recast", "workshop.forge", "mall.buy", "mall.sell", "mall.autosell"} {
		if projected[id] != false {
			t.Fatalf("unmapped disabled action %s: %v", id, projected)
		}
	}
	if projected["workshop"] != nil || projected["mall"] != nil || projected["workshop.open"] != true {
		t.Fatalf("native action gate hid unrelated actions: %v", projected)
	}
	for _, path := range []string{"/api/features", "/api/me"} {
		code, view := f.player("GET", path, "")
		if code != 200 || !reflect.DeepEqual(view["features"], projected) {
			t.Fatalf("%s differs: %v", path, view["features"])
		}
	}
	if got := p.poll(ctx); len(got) != 0 {
		t.Fatalf("idle features: %v", got)
	}
}

func TestIntegrationLegacyConfigLiveStream(t *testing.T) {
	f := newAdminFixture(t)
	tradeFixture := &legacyTradeFixture{server: f.server, client: f.server.Client(), token: map[string]string{"viewer": f.playerToken}}
	feed := openLegacyTradeStream(t, tradeFixture, "viewer")
	defer feed.cancel()
	initial := feed.wait(t, "init", 10*time.Second)
	if initial["groundCfg"] == nil {
		t.Fatal("stream init has no current map")
	}
	feed.wait(t, "features", 10*time.Second) // drain the initial config set
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	c.Runtime = map[string]any{"cast": map[string]any{"minMs": float64(1200)}}
	id := publishLegacyCatalog(t, f, c, 0, "live-stream")
	frame := feed.wait(t, "castcfg", 10*time.Second)
	if frame["minMs"] != float64(1200) {
		t.Fatalf("live catalog %s: %v", strconv.FormatInt(id, 10), frame)
	}
}
