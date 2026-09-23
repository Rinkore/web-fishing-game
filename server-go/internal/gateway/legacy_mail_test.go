package gateway

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fmt"
	"sync"
	"testing"
)

func TestIntegrationMailDeliveryOwnershipRetryAndRollback(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if code, _ := f.player("POST", "/api/admin/mail/send", `{}`); code != 401 {
		t.Fatalf("player admin access %d", code)
	}
	item := `{"item":{"id":"custom_test_badge","name":"测试纪念章","description":"自定义材料说明","rarity":"epic","price":0,"noSell":true},"requestKey":"custom-item-create"}`
	code, out := f.admin("POST", "/api/admin/mail/item", item)
	f.expect(code, out, 200, "")
	body := `{"target":"` + f.playerKey + `","subject":"测试附件","body":"邮件正文","requestKey":"send-test-mail","attachments":[{"itemId":"custom_test_badge","quantity":3},{"itemId":"relic","quantity":2},{"itemId":"rod_bamboo#epic#spd+10,skl+8","quantity":1}]}`
	code, out = f.admin("POST", "/api/admin/mail/send", body)
	f.expect(code, out, 200, "")
	id := out["result"].(map[string]any)["resourceId"].(string)
	code, again := f.admin("POST", "/api/admin/mail/send", body)
	f.expect(code, again, 200, "")
	if again["result"].(map[string]any)["resourceId"] != id {
		t.Fatal("duplicate mail")
	}
	code, out = f.admin("POST", "/api/admin/mail/item", `{"item":{"id":"custom_test_badge","name":"改名纪念章","rarity":"epic","price":0,"noSell":true},"requestKey":"custom-item-rename"}`)
	f.expect(code, out, 200, "")
	code, again = f.admin("POST", "/api/admin/mail/send", body)
	f.expect(code, again, 200, "")
	if again["result"].(map[string]any)["resourceId"] != id {
		t.Fatal("metadata edit invalidated retry")
	}
	code, out = f.player("GET", "/api/mail", "")
	f.expect(code, out, 200, "")
	if out["unread"] != float64(1) || out["pending"] != float64(1) {
		t.Fatal(out)
	}
	other, _ := f.register("mail_other", "其他玩家")
	claim := `{"id":"` + id + `","requestKey":"claim-mail-test"}`
	code, out = f.call("POST", "/api/mail/claim", claim, other)
	f.expect(code, out, 400, "mail_missing")
	code, out = f.player("POST", "/api/mail/read", `{"id":"`+id+`","requestKey":"read-mail-test"}`)
	f.expect(code, out, 200, "")
	code, out = f.player("GET", "/api/mail?summary=1", "")
	f.expect(code, out, 200, "")
	if out["unread"] != float64(0) || out["pending"] != float64(1) {
		t.Fatal(out)
	}
	// A ledger failure must leave both the attachments and claim marker untouched.
	_, err := f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.mail_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic mail fault'; END $$; CREATE TRIGGER mail_test_fault BEFORE INSERT ON fishing.inventory_entries FOR EACH ROW EXECUTE FUNCTION fishing.mail_test_fault()`)
	if err != nil {
		t.Fatal(err)
	}
	code, _ = f.player("POST", "/api/mail/claim", claim)
	if code != 503 {
		t.Fatalf("expected storage rollback %d", code)
	}
	var granted int64
	var claimed bool
	err = f.db.Admin.QueryRow(ctx, `SELECT claimed_at IS NOT NULL FROM fishing.mail_messages WHERE id=$1`, id).Scan(&claimed)
	if err != nil || claimed {
		t.Fatal("leaked claim", err)
	}
	if _, err = f.db.Admin.Exec(ctx, `DROP TRIGGER mail_test_fault ON fishing.inventory_entries`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = f.player("POST", "/api/mail/claim", fmt.Sprintf(`{"id":%q,"requestKey":"parallel-claim-%d"}`, id, i))
		}(i)
	}
	wg.Wait()
	for _, v := range codes {
		if v != 200 {
			t.Fatalf("claim status %d", v)
		}
	}
	err = f.db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='custom_test_badge'`, f.playerID).Scan(&granted)
	if err != nil || granted != 3 {
		t.Fatal("duplicate or missing grant", granted, err)
	}
	err = f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND attributes->>'signature'='rod_bamboo#epic#spd+10,skl+8'`, f.playerID).Scan(&granted)
	if err != nil || granted != 1 {
		t.Fatal("equipment grant", granted, err)
	}
	code, out = f.player("GET", "/api/me", "")
	f.expect(code, out, 200, "")
	if len(out["customItems"].([]any)) != 1 {
		t.Fatal("custom catalog missing")
	}
	code, out = f.player("GET", "/api/mail?summary=1", "")
	f.expect(code, out, 200, "")
	if out["pending"] != float64(0) {
		t.Fatal("pending claim")
	}
	code, out = f.admin("POST", "/api/admin/mail/send", `{"target":"`+f.playerKey+`","subject":"bad","requestKey":"invalid-item-mail","attachments":[{"itemId":"missing","quantity":1}]}`)
	if code != 400 {
		t.Fatal(code, out)
	}
	var count int
	if err = f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_messages`).Scan(&count); err != nil || count != 1 {
		t.Fatal("invalid mail leaked", count, err)
	}
	if _, err = f.db.Admin.Exec(ctx, `UPDATE fishing.identities SET admin=false WHERE username=$1`, f.adminKey); err != nil {
		t.Fatal(err)
	}
	code, _ = f.admin("POST", "/api/admin/mail/send", body)
	if code != 401 {
		t.Fatal("revoked admin", code)
	}
}

func TestIntegrationAdminExpeditionFinishAndConfig(t *testing.T) {
	f := newAdminFixture(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(context.Background(), f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	code, out := f.player("POST", "/api/sea/expedition/start", `{"route":"trade","hours":8,"requestKey":"admin-finish-start"}`)
	f.expect(code, out, 200, "")
	id := out["result"].(map[string]any)["resourceId"].(string)
	body := `{"target":"` + f.playerKey + `","id":"` + id + `","requestKey":"admin-finish-test","confirm":true}`
	code, out = f.player("POST", "/api/admin/expedition/finish", body)
	f.expect(code, out, 401, "")
	// Failure rolls back the full forced settlement as well.
	_, err = f.db.Admin.Exec(context.Background(), `CREATE FUNCTION fishing.finish_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic finish fault'; END $$; CREATE TRIGGER finish_test_fault BEFORE INSERT ON fishing.inventory_entries FOR EACH ROW EXECUTE FUNCTION fishing.finish_test_fault()`)
	if err != nil {
		t.Fatal(err)
	}
	code, out = f.admin("POST", "/api/admin/expedition/finish", body)
	if code != 503 {
		t.Fatal("expected rollback", code, out)
	}
	if _, err = f.db.Admin.Exec(context.Background(), `DROP TRIGGER finish_test_fault ON fishing.inventory_entries`); err != nil {
		t.Fatal(err)
	}
	before := f.coins(f.playerID)
	var wg sync.WaitGroup
	codes := make([]int, 6)
	for i := range codes {
		wg.Add(1)
		go func(i int) { defer wg.Done(); codes[i], _ = f.admin("POST", "/api/admin/expedition/finish", body) }(i)
	}
	wg.Wait()
	for _, code := range codes {
		if code != 200 {
			t.Fatal("concurrent finish", codes)
		}
	}
	if f.coins(f.playerID) <= before {
		t.Fatal("no reward")
	}
	code, out = f.player("POST", "/api/sea/expedition/claim", `{"id":"`+id+`","requestKey":"player-after-finish"}`)
	f.expect(code, out, 400, "expedition_claimed")
	code, out = f.admin("GET", "/api/admin/expedition?target="+f.playerKey, "")
	f.expect(code, out, 200, "")
	if out["player"].(map[string]any)["active"] != nil {
		t.Fatal("active after settlement")
	}
	cfg := out["config"].(map[string]any)
	cfg["ticket"] = float64(0)
	cfg["hours"] = []int{2}
	raw, _ := json.Marshal(map[string]any{"config": cfg, "sets": out["sets"], "expectedRevision": out["revision"], "requestKey": "edit-expedition-config"})
	code, res := f.admin("POST", "/api/admin/expedition/config", string(raw))
	f.expect(code, res, 200, "")
	raw, _ = json.Marshal(map[string]any{"config": cfg, "sets": out["sets"], "expectedRevision": out["revision"], "requestKey": "stale-expedition-config"})
	code, res = f.admin("POST", "/api/admin/expedition/config", string(raw))
	f.expect(code, res, 409, "catalog_revision_changed")
	code, res = f.player("POST", "/api/sea/expedition/start", `{"route":"trade","hours":8,"requestKey":"disabled-duration"}`)
	if code != 400 {
		t.Fatal("disabled duration", code, res)
	}
	code, res = f.player("POST", "/api/sea/expedition/start", `{"route":"trade","hours":2,"requestKey":"enabled-duration"}`)
	f.expect(code, res, 200, "")
	code, out = f.admin("GET", "/api/admin/expedition?target="+f.playerKey, "")
	f.expect(code, out, 200, "")
	cap := out["player"].(map[string]any)["captain"].(map[string]any)
	next := map[string]any{}
	for k, v := range cap {
		next[k] = v
	}
	next["marks"] = float64(123)
	raw, _ = json.Marshal(map[string]any{"target": f.playerKey, "before": cap, "after": next, "requestKey": "edit-captain-progress"})
	code, res = f.admin("POST", "/api/admin/expedition/player", string(raw))
	f.expect(code, res, 200, "")
	raw, _ = json.Marshal(map[string]any{"target": f.playerKey, "before": cap, "after": next, "requestKey": "stale-captain-progress"})
	code, res = f.admin("POST", "/api/admin/expedition/player", string(raw))
	f.expect(code, res, 400, "captain_changed")
}

func TestIntegrationSeaSettingsActuallyPersist(t *testing.T) {
	f := newAdminFixture(t)
	code, out := f.admin("POST", "/api/admin/settings", `{"seaCfg":{"sea":{"zoneTtlMin":60,"chartCost":7,"nightglow":{"rare":19}},"ship":{"names":["测试船",null,null,null,null],"upCoins":[1,2,3,4,5]}}}`)
	f.expect(code, out, 200, "")
	code, out = f.admin("GET", "/api/admin/world", "")
	f.expect(code, out, 200, "")
	sea := out["sea"].(map[string]any)
	if sea["zoneTtlMin"] != float64(60) || sea["chartCost"] != float64(7) || sea["nightglow"].(map[string]any)["rare"] != float64(19) {
		t.Fatal("sea edit not persisted", sea)
	}
	code, out = f.player("GET", "/api/sea", "")
	f.expect(code, out, 200, "")
	if out["chartCost"] != float64(7) {
		t.Fatal("player sees stale rules")
	}
	code, out = f.admin("POST", "/api/admin/settings", `{"seaCfg":{"sea":{"chartCost":-1}}}`)
	f.expect(code, out, 400, "")
	code, out = f.admin("POST", "/api/admin/settings", `{"seaCfg":{}}`)
	f.expect(code, out, 200, "")
	code, out = f.player("GET", "/api/sea", "")
	f.expect(code, out, 200, "")
	if out["chartCost"] != float64(3) {
		t.Fatal("reset not persisted")
	}
}
