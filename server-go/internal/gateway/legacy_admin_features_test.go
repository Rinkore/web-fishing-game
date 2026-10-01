package gateway

import (
	"context"
	"testing"
)

func TestLegacyAdminFeatureProjectionPreservesClosedNativeGates(t *testing.T) {
	flags := map[string]bool{"market": false, "trade": false, "workshop": false, "chest": false, "mall": false, "sell": false, "autosell": false, "friends": true}
	view := legacyAdminFeatureFlags(flags)
	for _, key := range []string{"mall.buy", "mall.sell", "mall.autosell", "mall.list", "mall.marketbuy", "ground.trade", "chest.open"} {
		if view[key] {
			t.Errorf("closed native gate projected as enabled: %s", key)
		}
	}
	if len(flags) != 8 {
		t.Fatalf("projection changed caller flags: %v", flags)
	}
	for _, key := range []string{"bd", "records"} {
		if !legacyFeatureIDs()[key] {
			t.Errorf("group absent from accepted feature IDs: %s", key)
		}
	}
}

func TestIntegrationLegacyAdminFeaturesContract(t *testing.T) {
	f := newAdminFixture(t)
	if code, _ := f.call("GET", "/api/admin/features", "", ""); code != 401 {
		t.Fatalf("anonymous admin features: %d", code)
	}
	if code, _ := f.player("GET", "/api/admin/features", ""); code != 401 {
		t.Fatalf("player admin features: %d", code)
	}

	code, view := f.admin("GET", "/api/admin/features", "")
	f.expect(code, view, 200, "")
	features, ok := view["features"].(map[string]any)
	if !ok || features["fishing"] != true || features["fishing.cast"] != true || features["mall.buy"] != true {
		t.Fatalf("initial feature defaults: %v", view["features"])
	}
	groups, ok := view["groups"].([]any)
	if !ok || len(groups) != len(legacyFeatureGroups) {
		t.Fatalf("feature groups: %v", view["groups"])
	}

	code, body := f.admin("POST", "/api/admin/features", `{"features":{"unknown":false}}`)
	f.expect(code, body, 400, "未知功能或开关值不是布尔值")
	code, body = f.admin("POST", "/api/admin/features", `{"features":{"mall.buy":false},"featureOrder":{"menu":["mall"]}}`)
	f.expect(code, body, 400, "菜单排序包含未知、重复或缺失项")

	order := `{"menu":["mall","fishing","sea","character","ground","inventory","workshop","codex","feedback","logs","wiki"],"mall":["mall.marketbuy","mall.list","mall.buy","mall.sell","mall.autosell"]}`
	code, body = f.admin("POST", "/api/admin/features", `{"features":{"mall.buy":false,"adminBypass":true},"featureOrder":`+order+`}`)
	f.expect(code, body, 200, "")
	features = body["features"].(map[string]any)
	if features["mall.buy"] != false || features["adminBypass"] != true {
		t.Fatalf("saved feature state: %v", features)
	}
	featureOrder := body["featureOrder"].(map[string]any)
	menu := featureOrder["menu"].([]any)
	if menu[0] != "mall" {
		t.Fatalf("saved menu order: %v", featureOrder)
	}

	code, body = f.player("GET", "/api/features", "")
	f.expect(code, body, 200, "")
	features = body["features"].(map[string]any)
	if features["mall.buy"] != false || body["featureOrder"].(map[string]any)["menu"].([]any)[0] != "mall" {
		t.Fatalf("player projection: %v", body)
	}
	var audits int
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.admin_audit WHERE action='features/update'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Fatalf("feature audit rows: %d", audits)
	}
}
