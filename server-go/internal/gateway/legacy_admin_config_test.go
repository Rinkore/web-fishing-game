package gateway

import (
	"context"
	"testing"
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
