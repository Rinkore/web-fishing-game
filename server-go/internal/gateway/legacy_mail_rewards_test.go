package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/mail"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

func TestIntegrationMailRewardBindingConsumptionAndSales(t *testing.T) {
	for _, inherit := range []bool{true, false} {
		t.Run(fmt.Sprint(inherit), func(t *testing.T) {
			f := newAdminFixture(t)
			ctx := context.Background()
			c, err := rules.Default()
			if err != nil {
				t.Fatal(err)
			}
			if err := workshop.SeedDefinitions(ctx, f.db.Admin, c); err != nil {
				t.Fatal(err)
			}
			code, out := f.admin("POST", "/api/admin/mail/send", fmt.Sprintf(`{"target":%q,"subject":"绑定奖励","requestKey":"bound-send","attachments":[{"itemId":"relic","quantity":5,"bindOutputs":%t},{"itemId":"crucian","tier":"giant","quantity":2},{"itemId":"rod_bamboo#epic#spd+10","quantity":1,"bindOutputs":%t}]}`, f.playerKey, inherit, inherit))
			f.expect(code, out, 200, "")
			id := out["result"].(map[string]any)["resourceId"].(string)
			code, out = f.player("POST", "/api/mail/claim", fmt.Sprintf(`{"id":%q,"requestKey":"bound-claim"}`, id))
			f.expect(code, out, 200, "")
			var total, bound, propagate int64
			check := func(item, tier string, wantTotal, wantBound, wantInherit int64) {
				t.Helper()
				err := f.db.Admin.QueryRow(ctx, `SELECT quantity,bound_quantity,inherit_quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier=$3`, f.playerID, item, tier).Scan(&total, &bound, &propagate)
				if err != nil || total != wantTotal || bound != wantBound || propagate != wantInherit {
					t.Fatalf("binding totals %s: %d %d %d (%v)", item, total, bound, propagate, err)
				}
			}
			expected := int64(0)
			if inherit {
				expected = 5
			}
			check("relic", "normal", 5, 5, expected)
			check("crucian", "giant", 2, 2, 2)
			// Restoring the same snapshot must preserve bound subsets and never
			// retain an extra copy of loose bound equipment.
			code, out = f.admin("POST", "/api/admin/users/snapshot-now", fmt.Sprintf(`{"target":%q}`, f.playerKey))
			f.expect(code, out, 200, "")
			code, out = f.admin("GET", "/api/admin/users/snapshots?key="+f.playerKey, "")
			f.expect(code, out, 200, "")
			snapshotName := out["snapshots"].([]any)[0].(map[string]any)["name"].(string)
			code, out = f.admin("POST", "/api/admin/users/rollback", fmt.Sprintf(`{"target":%q,"snap":%q,"confirm":true}`, f.playerKey, snapshotName))
			f.expect(code, out, 200, "")
			check("relic", "normal", 5, 5, expected)
			check("crucian", "giant", 2, 2, 2)
			var loose int
			if err = f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available' AND reward_bound`, f.playerID).Scan(&loose); err != nil || loose != 1 {
				t.Fatal("snapshot duplicated or unbound equipment", loose, err)
			}
			service := assets.New(f.db.App)
			r, err := service.ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: "ordinary-fish", RuleVersion: "test", Reason: "reward", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "giant", Quantity: 3}}})
			if err != nil || r.Status != "applied" {
				t.Fatal(r, err)
			}
			r, err = economy.New(f.db.App, c).Sell(ctx, economy.Sell{ActorID: f.playerID, RequestKey: "oversell", ItemID: "crucian", Tier: "giant", Quantity: 4})
			if err != nil || r.Status != "reward_bound" {
				t.Fatal("bound sale", r, err)
			}
			r, err = economy.New(f.db.App, c).Sell(ctx, economy.Sell{ActorID: f.playerID, RequestKey: "ordinary-sale", ItemID: "crucian", Tier: "giant", Quantity: 3})
			if err != nil || r.Status != "sold" {
				t.Fatal(r, err)
			}
			check("crucian", "giant", 2, 2, 2)
			var equipment int64
			if err = f.db.Admin.QueryRow(ctx, `SELECT id FROM fishing.equipment_instances WHERE owner_id=$1 AND reward_bound`, f.playerID).Scan(&equipment); err != nil {
				t.Fatal(err)
			}
			r, err = economy.New(f.db.App, c).SellEquipment(ctx, f.playerID, equipment, "bound-equipment-sale")
			if err != nil || r.Status != "reward_bound" {
				t.Fatal("equipment sale", r, err)
			}
			r, err = market.New(f.db.App).List(ctx, market.List{ActorID: f.playerID, RequestKey: "bound-list", ItemID: "relic", Tier: "normal", Quantity: 1, Price: 10, Lifetime: time.Hour})
			if err != nil || r.Status != "reward_bound" {
				t.Fatal("market bypass", r, err)
			}
			r, err = market.New(f.db.App).List(ctx, market.List{ActorID: f.playerID, RequestKey: "bound-gear-list", EquipmentID: equipment, Price: 10, Lifetime: time.Hour})
			if err != nil || r.Status != "equipment_unavailable" {
				t.Fatal("equipment market bypass", r, err)
			}
			_, other := f.register("reward_recipient", "其他玩家")
			r, err = service.ExchangeAssets(ctx, assets.Exchange{ActorID: f.playerID, RecipientID: other, RequestKey: "bound-transfer", Stacks: []assets.StackDelta{{ItemID: "relic", Tier: "normal", Quantity: 1}}})
			if err != nil || r.Status != "reward_bound" {
				t.Fatal("transfer", r, err)
			}
			r, err = service.ExchangeAssets(ctx, assets.Exchange{ActorID: f.playerID, RecipientID: other, RequestKey: "bound-gear-transfer", Equipment: []int64{equipment}})
			if err != nil || r.Status != "reward_bound" {
				t.Fatal("gear transfer", r, err)
			}
			r, err = service.ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: "bound-craft", RuleVersion: "test", Reason: "craft", Stacks: []assets.StackDelta{{ItemID: "relic", Tier: "normal", Quantity: -2}, {ItemID: "stardust", Tier: "normal", Quantity: 1}}, Consume: []int64{equipment}, Create: []assets.EquipmentSpec{{DefinitionID: "rod_bamboo", Part: "rod", Attributes: json.RawMessage(`{"signature":"rod_bamboo#epic#spd+11"}`)}}})
			if err != nil || r.Status != "applied" {
				t.Fatal("craft", r, err)
			}
			n := int64(0)
			if inherit {
				n = 1
			}
			check("stardust", "normal", 1, n, n)
			remain := int64(0)
			if inherit {
				remain = 3
			}
			check("relic", "normal", 3, 3, remain)
			var gearBound, gearInherit bool
			if err = f.db.Admin.QueryRow(ctx, `SELECT reward_bound,bind_outputs FROM fishing.equipment_instances WHERE id=$1`, r.EquipmentIDs[0]).Scan(&gearBound, &gearInherit); err != nil || gearBound != inherit || gearInherit != inherit {
				t.Fatal("craft equipment policy", err)
			}
			r, err = service.ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: "second-craft", RuleVersion: "test", Reason: "craft", Stacks: []assets.StackDelta{{ItemID: "stardust", Tier: "normal", Quantity: -1}, {ItemID: "dragonpearl", Tier: "normal", Quantity: 1}}})
			if err != nil || r.Status != "applied" {
				t.Fatal(r, err)
			}
			check("dragonpearl", "normal", 1, n, n)
			code, out = f.player("GET", "/api/me", "")
			f.expect(code, out, 200, "")
			if out["rewardBindings"] == nil {
				t.Fatal("binding projection missing")
			}
			var valid bool
			if err = f.db.Admin.QueryRow(ctx, `SELECT expires_at BETWEEN created_at+interval '29 days 23 hours' AND created_at+interval '30 days 1 hour' FROM fishing.mail_messages WHERE id=$1`, id).Scan(&valid); err != nil || !valid {
				t.Fatal("default expiry", err)
			}
		})
	}
}

func TestIntegrationMailBatchSnapshotRecoveryAndRevoke(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	svc := mail.New(f.db.App, c)
	_, other := f.register("batch_other", "其他玩家")
	post := func(v any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(v)
		code, out := f.admin("POST", "/api/admin/mail/send?batch=1", string(raw))
		f.expect(code, out, 200, "")
		return out
	}
	draft := map[string]any{"name": "活动奖励", "reason": "名单冻结验收", "mail": map[string]any{"subject": "全服补偿", "expiryDays": 0, "attachments": []any{map[string]any{"itemId": "relic", "quantity": 2, "bindOutputs": false}}}, "audience": map[string]any{"mode": "selected", "ids": []string{strconv.FormatInt(f.playerID, 10), strconv.FormatInt(other, 10)}, "accounts": []string{f.playerKey}}}
	input := map[string]any{"action": "preview", "draft": draft, "requestKey": "batch-preview"}
	out := post(input)
	id := out["result"].(map[string]any)["resourceId"].(string)
	again := post(input)
	if again["result"].(map[string]any)["resourceId"] != id {
		t.Fatal("duplicate preview")
	}
	if _, err = f.db.Admin.Exec(ctx, `DELETE FROM fishing.registration_limits`); err != nil {
		t.Fatal(err)
	}
	f.register("batch_late", "名单生成后注册")
	batches, err := svc.Batches(ctx, id, "", 1)
	if err != nil || len(batches) != 1 || batches[0].Total != 2 {
		t.Fatal(batches, err)
	}
	change := func(action string) {
		t.Helper()
		b, err := svc.Batches(ctx, id, "", 1)
		if err != nil {
			t.Fatal(err)
		}
		post(map[string]any{"action": action, "id": id, "revision": b[0].Revision, "requestKey": "batch-" + action})
	}
	change("send")
	change("pause")
	if n, err := svc.Sweep(ctx); err != nil || n != 0 {
		t.Fatal("paused delivery", n, err)
	}
	change("resume")
	if _, err = f.db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_batch_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_batch BEFORE INSERT ON fishing.mail_attachments FOR EACH ROW EXECUTE FUNCTION fishing.fail_batch_delivery()`); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	failedBatch, err := svc.Batches(ctx, id, "", 1)
	if err != nil || failedBatch[0].Failed != 2 {
		t.Fatal("failure diagnostics", failedBatch, err)
	}
	var count int
	if err = f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_messages WHERE batch_id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial delivery escaped transaction", err)
	}
	if _, err = f.db.Admin.Exec(ctx, `DROP TRIGGER fail_batch ON fishing.mail_attachments`); err != nil {
		t.Fatal(err)
	}
	change("retry")
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := svc.Sweep(ctx); errs <- err }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_messages WHERE batch_id=$1 AND expires_at IS NULL`, id).Scan(&count); err != nil || count != 2 {
		t.Fatal("duplicate/missing mail", count, err)
	}
	var message string
	if err = f.db.Admin.QueryRow(ctx, `SELECT id::text FROM fishing.mail_messages WHERE batch_id=$1 AND recipient_id=$2`, id, f.playerID).Scan(&message); err != nil {
		t.Fatal(err)
	}
	// One lock order, two competing outcomes: either a full claim wins, or revoke
	// wins and no asset is credited. There is no partial or duplicate outcome.
	var claimCode int
	var claimOut map[string]any
	wg.Add(1)
	go func() {
		defer wg.Done()
		claimCode, claimOut = f.player("POST", "/api/mail/claim", fmt.Sprintf(`{"id":%q,"requestKey":"race-claim"}`, message))
	}()
	change("revoke")
	wg.Wait()
	if claimCode != 200 && claimCode != 400 {
		t.Fatal(claimCode, claimOut)
	}
	var claimed bool
	var quantity int64
	if err = f.db.Admin.QueryRow(ctx, `SELECT claimed_at IS NOT NULL FROM fishing.mail_messages WHERE id=$1`, message).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Admin.QueryRow(ctx, `SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='relic'),0)`, f.playerID).Scan(&quantity); err != nil {
		t.Fatal(err)
	}
	if (claimed && quantity != 2) || (!claimed && quantity != 0) {
		t.Fatal("claim/revoke mismatch", claimed, quantity)
	}
}

func TestIntegrationMailAudienceTimeAndExpiredClaim(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	_, other := f.register("strict_login", "登录玩家")
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.player_activity(owner_id,kind,at) VALUES($1,'active','2026-09-11 00:00:00+08'),($2,'login','2026-09-12 00:00:00+08')`, f.playerID, other); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"active", "login"} {
		filter := fmt.Sprintf(`{"mode":"filter","activityKind":%q,"after":"2026-09-11T00:00:00+08:00","before":"2026-09-13T00:00:00+08:00"}`, kind)
		code, out := f.admin("GET", "/api/admin/mail?view=recipients&audience="+url.QueryEscape(filter), "")
		f.expect(code, out, 200, "")
		want := float64(2)
		if kind == "login" {
			want = 1
		}
		if out["total"] != want || out["trackingSince"] == nil {
			t.Fatal(kind, out)
		}
	}
	code, out := f.admin("POST", "/api/admin/mail/send", fmt.Sprintf(`{"target":%q,"subject":"过期奖励","requestKey":"expiry-send","attachments":[{"itemId":"relic","quantity":1}]}`, f.playerKey))
	f.expect(code, out, 200, "")
	id := out["result"].(map[string]any)["resourceId"].(string)
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.mail_messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	code, out = f.player("POST", "/api/mail/claim", fmt.Sprintf(`{"id":%q,"requestKey":"expired-claim"}`, id))
	f.expect(code, out, 400, "mail_unavailable")
	code, out = f.player("GET", "/api/mail?filter=pending", "")
	f.expect(code, out, 200, "")
	if out["total"] != float64(0) || out["pending"] != float64(0) {
		t.Fatal(out)
	}
	code, out = f.player("POST", "/api/mail/claim", `{"id":"all","requestKey":"claim-all-empty"}`)
	f.expect(code, out, 200, "")
	if out["claimed"] != float64(0) {
		t.Fatal(out)
	}
}

func TestIntegrationMailChestBindingAndClaimAll(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"chest-first", "chest-second"} {
		code, out := f.admin("POST", "/api/admin/mail/send", fmt.Sprintf(`{"target":%q,"subject":"chest reward","requestKey":%q,"attachments":[{"itemId":"chest_king","quantity":1}]}`, f.playerKey, key))
		f.expect(code, out, 200, "")
	}
	code, out := f.player("POST", "/api/mail/claim", `{"id":"all","requestKey":"chest-claim-all"}`)
	f.expect(code, out, 200, "")
	if out["claimed"] != float64(2) {
		t.Fatal(out)
	}
	code, out = f.player("POST", "/api/mail/claim", `{"id":"all","requestKey":"chest-claim-all"}`)
	f.expect(code, out, 200, "")
	if out["claimed"] != float64(0) {
		t.Fatal("duplicate claim", out)
	}
	svc := workshop.New(f.db.App, c)
	r, err := svc.Chest(ctx, workshop.ChestCommand{ActorID: f.playerID, RequestKey: "free-only", ChestID: "chest_king", Action: "open", Quantity: 1, BaseID: "gear_line_1", UnboundInputs: true})
	if err != nil || r.Status != "reward_bound" {
		t.Fatal("bound chest used as free input", r, err)
	}
	r, err = svc.Chest(ctx, workshop.ChestCommand{ActorID: f.playerID, RequestKey: "bound-open", ChestID: "chest_king", Action: "open", Quantity: 1, BaseID: "gear_line_1"})
	if err != nil || r.Status != "opened" {
		t.Fatal(r, err)
	}
	var bound, inherit bool
	if err = f.db.Admin.QueryRow(ctx, `SELECT reward_bound,bind_outputs FROM fishing.equipment_instances WHERE id=$1`, r.EquipmentIDs[0]).Scan(&bound, &inherit); err != nil || !bound || !inherit {
		t.Fatal("chest output lost binding", bound, inherit, err)
	}
	code, out = f.player("GET", "/api/me", "")
	f.expect(code, out, 200, "")
	if out["rewardBindings"] == nil {
		t.Fatal("missing player binding view")
	}
}
