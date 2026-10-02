package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/operations"
	"github.com/jackc/pgx/v5"
)

func TestLegacyCastSpeedCapValidationBounds(t *testing.T) {
	settings := func(raw string) map[string]json.RawMessage {
		return map[string]json.RawMessage{"castSpeedCap": json.RawMessage(raw)}
	}
	if _, err := validateLegacySettings(settings("10000")); err != nil {
		t.Fatalf("10000%% cap rejected: %v", err)
	}
	if _, err := validateLegacySettings(settings("10001")); err == nil {
		t.Fatal("10001% cap accepted")
	}
	bonus := map[string]json.RawMessage{"castSpeedBonus": json.RawMessage("501")}
	if _, err := validateLegacySettings(bonus); err == nil {
		t.Fatal("speed bonus range was expanded")
	}
}

func TestIntegrationLegacyAdminConfigAuditContracts(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	c, _, err := catalog.Current(ctx, f.db.App)
	if err != nil {
		t.Fatal(err)
	}
	// The workshop submits every numeric field as a form string and this
	// checkbox as a boolean. Exercise the actual complete editor payload.
	raw, _ := json.Marshal(c.WorkshopConfig())
	var form map[string]any
	_ = json.Unmarshal(raw, &form)
	for key, value := range form {
		if _, ok := value.(float64); ok {
			form[key] = fmt.Sprint(value)
		}
	}
	form["token"], form["recastMinValue"] = "", true
	form["catalystRanges"] = map[string]any{}
	raw, _ = json.Marshal(form)
	code, body := f.admin("POST", "/api/admin/smelt/config", string(raw))
	f.expect(code, body, 200, "")
	c, _, err = catalog.Current(ctx, f.db.App)
	if err != nil || c.WorkshopConfig().RecastMinValue != 1 {
		t.Fatalf("workshop form not applied: %v", err)
	}
	for _, patch := range []string{`{"priceCfg":{"saleDivisor":3}}`, `{"dropCfg":{"material":-10}}`, `{"biteFormula":"unknown + 1","validateOnly":true}`, `{"chestCfg":{"costs":{"chest_abyss":{"costCoins":-1}}}}`} {
		if code, body := f.admin("POST", "/api/admin/settings", patch); code != 400 {
			t.Fatalf("invalid config accepted: %s %d %v", patch, code, body)
		}
	}
	_, revision, _ := catalog.Current(ctx, f.db.App)
	code, body = f.admin("POST", "/api/admin/settings", `{"biteFormula":"clamp(50 + skill, 0, 100)","evalVars":{"skill":25},"validateOnly":true}`)
	f.expect(code, body, 200, "")
	if body["prob"] != float64(75) {
		t.Fatalf("formula result: %v", body)
	}
	_, after, _ := catalog.Current(ctx, f.db.App)
	if after != revision {
		t.Fatal("formula validation published a release")
	}
	code, body = f.admin("POST", "/api/admin/settings", `{"castSpeedBonus":12,"castSpeedCap":10000,"castFormula":"interval / 2"}`)
	f.expect(code, body, 200, "")
	if body["castSpeedCap"] != float64(10000) {
		t.Fatalf("cast speed cap not persisted: %v", body)
	}
	code, body = f.admin("POST", "/api/admin/settings", `{"resetCastSpeed":true}`)
	f.expect(code, body, 200, "")
	if body["castSpeedBonus"] != float64(0) || body["castSpeedCap"] != float64(100) || body["castFormula"] == "" {
		t.Fatalf("reset response incomplete: %v", body)
	}
	code, body = f.admin("POST", "/api/admin/features", `{"features":{"mail":false}}`)
	f.expect(code, body, 200, "")
	if body["features"].(map[string]any)["mail"] != false {
		t.Fatal("mail toggle not persisted")
	}
	code, body = f.admin("POST", "/api/admin/snapshot/config", `{"cfg":{"enabled":false,"intervalMin":17,"keep":3}}`)
	f.expect(code, body, 200, "")
	code, body = f.admin("GET", "/api/admin/world", "")
	f.expect(code, body, 200, "")
	if body["snapshotCfg"].(map[string]any)["intervalMin"] != float64(17) || len(body["chests"].([]any)) == 0 || len(body["extraAffixRanges"].(map[string]any)) == 0 {
		t.Fatal("world compatibility fields missing")
	}
	code, body = f.admin("POST", "/api/admin/settings", `{"autoNotify":{"on":true,"rules":[{"min":0,"level":"none"}],"holdCount":1}}`)
	f.expect(code, body, 200, "")
	if err := operations.New(f.db.App).AutoNotifyOnce(ctx); err != nil {
		t.Fatal(err)
	}
	p := &legacyCatchPush{api: &API{pool: f.db.App}}
	if p.notifyLevel(ctx) != "none" {
		t.Fatal("auto notification did not reach catch feed")
	}
	_, beforeHash := (&API{pool: f.db.App}).legacyStoredConfig(ctx)
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.operator_settings SET value=jsonb_set(value,'{autoNotifyState,nextAt}','0') WHERE key='legacy:settings'`); err != nil {
		t.Fatal(err)
	}
	_, afterHash := (&API{pool: f.db.App}).legacyStoredConfig(ctx)
	if beforeHash != afterHash {
		t.Fatal("internal notification cursor changed public configuration hash")
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES('market_supply','{"id":"audit-plan","enabled":true,"created":42,"nextAt":12345,"remainingCounts":{}}')`); err != nil {
		t.Fatal(err)
	}
	code, body = f.admin("POST", "/api/admin/market/supply", `{"action":"pause"}`)
	f.expect(code, body, 200, "")
	code, body = f.admin("GET", "/api/admin/market/supply", "")
	f.expect(code, body, 200, "")
	if body["rule"].(map[string]any)["enabled"] != false {
		t.Fatal("market pause did not persist")
	}
	if rule := body["rule"].(map[string]any); rule["created"] != float64(42) || rule["nextAt"] != float64(12345) {
		t.Fatal("pause changed the supply cursor")
	}
}

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
	body := `{"refreshTime":"07:15","items":[{"id":"` + id + `","price":1,"limit":100}]}`
	if code, result := f.admin("POST", "/api/admin/mall/config", body); code != 200 {
		t.Fatalf("save mall config: %d %v", code, result)
	}
	code, view = f.player("GET", "/api/mall", "")
	if code != 200 || view["refreshTime"] != "7:15" || view["items"].([]any)[0].(map[string]any)["price"] != float64(1) || view["items"].([]any)[0].(map[string]any)["remain"] != float64(100) {
		t.Fatalf("saved mall config not read by gameplay: %d %v", code, view)
	}
	code, bought := f.player("POST", "/api/mall/buy", `{"id":"`+id+`","qty":100}`)
	if code != 200 || bought["qty"] != float64(100) || bought["cost"] != float64(100) || bought["coins"] != float64(400) {
		t.Fatalf("saved mall price not used by settlement: %d %v", code, bought)
	}
	inventory := bought["inventory"].(map[string]any)
	if inventory[id] != float64(100) {
		t.Fatalf("buy-all inventory: %v", inventory)
	}
	settled := bought["mall"].(map[string]any)["items"].([]any)[0].(map[string]any)
	if settled["bought"] != float64(100) || settled["remain"] != float64(0) {
		t.Fatalf("buy-all quota: %v", settled)
	}
}
