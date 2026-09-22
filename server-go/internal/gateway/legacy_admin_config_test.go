package gateway

import (
	"context"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/catalog"
	"github.com/jackc/pgx/v5"
)

func TestIntegrationLegacyAdminConfigResetPublishesDefaults(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	p := &legacyConfigPush{api: &API{pool: f.db.App}}
	p.init(ctx)
	p.poll(ctx)
	for _, tc := range []struct{ path, changed, field, frame string }{
		{"/api/admin/mall/config", `{"refreshTime":"07:15"}`, "mallCfg", "mallcfg"},
		{"/api/admin/smelt/config", `{"baseRate":1}`, "smeltCfg", "smeltcfg"},
		{"/api/admin/records/config", `{"scale":200,"x":10,"y":20}`, "recordsCfg", "recordscfg"},
	} {
		code, body := f.admin("POST", tc.path, tc.changed)
		f.expect(code, body, 200, "")
		p.poll(ctx)
		code, body = f.admin("POST", tc.path, `{"reset":true}`)
		f.expect(code, body, 200, "")
		found := false
		for _, frame := range decodePersonalFrames(t, p.poll(ctx)) {
			if frame["type"] == tc.frame {
				found = true
				if jsonString(frame[tc.field]) != jsonString(body[tc.field]) {
					t.Fatalf("reset response differs from push: %s", tc.path)
				}
			}
		}
		if !found {
			t.Fatalf("reset did not publish defaults: %s", tc.path)
		}
	}
}

func TestIntegrationLegacyAdminSettingsValidateOnly(t *testing.T) {
	f := newAdminFixture(t)
	code, body := f.admin("POST", "/api/admin/settings", `{"notifyLevel":"rare"}`)
	f.expect(code, body, 200, "")
	code, body = f.admin("POST", "/api/admin/settings", `{"notifyLevel":"off","validateOnly":true}`)
	f.expect(code, body, 200, "")
	var stored string
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT value->>'notifyLevel' FROM fishing.operator_settings WHERE key=$1`, legacySettingsKey).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "rare" {
		t.Fatalf("validation changed stored setting: %s", stored)
	}
	var count int
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.admin_audit WHERE action='settings/update'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("validation added mutation audit: %d", count)
	}
	code, body = f.admin("POST", "/api/admin/settings", `{"notifyLevel":"invalid","validateOnly":true}`)
	f.expect(code, body, 400, "未知的通知等级")
}

func TestIntegrationLegacySettingsConcurrentMergeAndRollback(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if code, body := f.admin("POST", "/api/admin/settings", `{"notifyLevel":"rare"}`); code != 200 {
		t.Fatalf("seed setting: %d %v", code, body)
	}
	var wg sync.WaitGroup
	errs := make(chan int, 2)
	for _, body := range []string{`{"autoSellCfg":{"batch":7}}`, `{"dropCfg":{"material":250}}`} {
		wg.Add(1)
		go func(body string) {
			defer wg.Done()
			code, result := f.admin("POST", "/api/admin/settings", body)
			errs <- code
			if code != 200 {
				t.Logf("concurrent body %s: %v", body, result)
			}
		}(body)
	}
	wg.Wait()
	close(errs)
	for code := range errs {
		if code != 200 {
			t.Fatalf("concurrent setting update: %d", code)
		}
	}
	c, _, err := catalog.Current(ctx, f.db.App)
	if err != nil {
		t.Fatal(err)
	}
	if c.Runtime["autoSellBatch"] != float64(7) || c.DefaultLootConfig().Material != 250 {
		t.Fatalf("concurrent patches lost: runtime=%v loot=%+v", c.Runtime, c.DefaultLootConfig())
	}
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(ctx, "REVOKE INSERT ON fishing.catalog_releases FROM "+role); err != nil {
		t.Fatal(err)
	}
	code, _ := f.admin("POST", "/api/admin/settings", `{"notifyLevel":"off"}`)
	if code == 200 {
		t.Fatal("failed setting write unexpectedly succeeded")
	}
	if _, err := f.db.Admin.Exec(ctx, "GRANT INSERT ON fishing.catalog_releases TO "+role); err != nil {
		t.Fatal(err)
	}
	var stored []byte
	if err := f.db.Admin.QueryRow(ctx, `SELECT value->>'notifyLevel' FROM fishing.operator_settings WHERE key=$1`, legacySettingsKey).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if string(stored) != `rare` {
		t.Fatalf("failed write changed setting: %s", stored)
	}
}

func TestIntegrationLegacyMallSettingChangesSettlement(t *testing.T) {
	f := newAdminFixture(t)
	code, view := f.player("GET", "/api/mall", "")
	if code != 200 || len(view["items"].([]any)) == 0 {
		t.Fatalf("mall view: %d %v", code, view)
	}
	id := view["items"].([]any)[0].(map[string]any)["id"].(string)
	body := `{"refreshTime":"07:15","items":[{"id":"` + id + `","price":1,"limit":1}]}`
	if code, result := f.admin("POST", "/api/admin/mall/config", body); code != 200 {
		t.Fatalf("save mall config: %d %v", code, result)
	}
	code, view = f.player("GET", "/api/mall", "")
	if code != 200 || view["refreshTime"] != "7:15" || view["items"].([]any)[0].(map[string]any)["price"] != float64(1) {
		t.Fatalf("saved mall config not read by gameplay: %d %v", code, view)
	}
	code, bought := f.player("POST", "/api/mall/buy", `{"id":"`+id+`","qty":1}`)
	if code != 200 || bought["cost"] != float64(1) {
		t.Fatalf("saved mall price not used by settlement: %d %v", code, bought)
	}
}
