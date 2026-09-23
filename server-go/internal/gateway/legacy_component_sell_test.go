package gateway

import (
	"encoding/json"
	"strconv"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

func TestIntegrationLegacyComponentSell(t *testing.T) {
	f := newLegacyTradeFixture(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	owner := f.id["trade_a"]
	const signature = "rod_bamboo#rare#spd+5"
	create := func(actor int64, key string, n int) []string {
		t.Helper()
		specs := make([]assets.EquipmentSpec, n)
		for i := range specs {
			specs[i] = assets.EquipmentSpec{DefinitionID: "rod_bamboo", Part: "rod", Attributes: json.RawMessage(`{"signature":"` + signature + `"}`)}
		}
		r, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: actor, RequestKey: key, Reason: "reward", RuleVersion: "test-v1", Create: specs})
		if err != nil || len(r.EquipmentIDs) != n {
			t.Fatalf("create components: %v %v", r, err)
		}
		return r.EquipmentIDs
	}
	ids := create(owner, "sale-stock", 5)
	otherIDs := create(f.id["trade_b"], "other-owner", 1)
	boundID, err := strconv.ParseInt(ids[0], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	equippedID, err := strconv.ParseInt(ids[1], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	// Older protected instances must not prevent selling free copies of the
	// same signature, nor become substitutes when the free copies run out.
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.equipment_instances SET reward_bound=true WHERE id=$1`, boundID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot) VALUES($1,-1) ON CONFLICT DO NOTHING`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,-1,'rod',$2)`, owner, equippedID); err != nil {
		t.Fatal(err)
	}
	code, before := f.do("GET", "/api/me", "", f.token["trade_a"])
	f.expect(code, before, 200, "")
	base, _, _, _ := c.Instance(signature)
	var quality map[string]struct {
		Mult float64 `json:"mult"`
	}
	if err := c.Constant("QUALITY", &quality); err != nil {
		t.Fatal(err)
	}
	unit := rules.Round(base.Price * quality["rare"].Mult)
	readRevision := func(body map[string]any) int64 {
		t.Helper()
		raw, ok := body["invRev"].(string)
		revision, err := strconv.ParseInt(raw, 10, 64)
		if !ok || err != nil {
			t.Fatalf("invalid inventory revision: %v", body["invRev"])
		}
		return revision
	}
	coins, revision := before["coins"].(float64), readRevision(before)
	f.expectPost("/api/sell", `{"id":"`+signature+`","qty":4}`, "trade_a", 400, "奖励绑定物品不可出售；仅普通库存可出售")
	// Single-click and bulk UI both call this original endpoint; bulk sends
	// one request per signature with the selected quantity.
	for _, qty := range []int{1, 2} {
		code, sold := f.post("/api/sell", `{"id":"`+signature+`","qty":`+strconv.Itoa(qty)+`}`, "trade_a")
		f.expect(code, sold, 200, "")
		coins += unit * float64(qty)
		remaining := float64(1)
		if qty == 1 {
			remaining = 3
		}
		nextRevision := readRevision(sold)
		if sold["ok"] != true || sold["gain"] != unit*float64(qty) || sold["coins"] != coins || sold["inventory"].(map[string]any)[signature] != remaining || nextRevision <= revision {
			t.Fatalf("component sale response: %v", sold)
		}
		revision = nextRevision
	}
	code, denied := f.post("/api/sell", `{"id":"`+signature+`","qty":1}`, "trade_a")
	f.expect(code, denied, 400, "奖励绑定物品不可出售；仅普通库存可出售")
	f.expectPost("/api/sell", `{"id":"not_an_item","qty":1}`, "trade_a", 400, "invalid_input")
	var consumed, protected, otherOwner, quantity int64
	var gain int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE lifecycle='consumed'),count(*) FILTER(WHERE lifecycle='available') FROM fishing.equipment_instances WHERE owner_id=$1`, owner).Scan(&consumed, &protected); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'`, f.id["trade_b"]).Scan(&otherOwner); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT sum(quantity),sum(gain) FROM fishing.shop_sales WHERE owner_id=$1`, owner).Scan(&quantity, &gain); err != nil {
		t.Fatal(err)
	}
	if consumed != 3 || protected != 2 || otherOwner != 1 || quantity != 3 || gain != int64(3*unit) {
		t.Fatalf("sale reconciliation: consumed=%d protected=%d other=%d quantity=%d gain=%d", consumed, protected, otherOwner, quantity, gain)
	}
	// The explicit instance endpoint continues to share the same pricing and
	// consumption behavior after the legacy signature route is added.
	f.expectPost("/api/v1/sell/equipment", `{"requestKey":"instance-sale","equipmentId":"`+otherIDs[0]+`"}`, "trade_b", 200, "")
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT sum(gain) FROM fishing.shop_sales WHERE owner_id=$1`, f.id["trade_b"]).Scan(&gain); err != nil || gain != int64(unit) {
		t.Fatalf("explicit instance sale: gain=%d error=%v", gain, err)
	}
}

func TestIntegrationComponentSellAtomicity(t *testing.T) {
	f := newLegacyTradeFixture(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	owner := f.id["trade_a"]
	var initialCoins int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&initialCoins); err != nil {
		t.Fatal(err)
	}
	const signature = "rod_bamboo#common#"
	spec := assets.EquipmentSpec{DefinitionID: "rod_bamboo", Part: "rod", Attributes: json.RawMessage(`{"signature":"` + signature + `"}`)}
	if _, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: owner, RequestKey: "atomic-stock", Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{spec, spec, spec}}); err != nil {
		t.Fatal(err)
	}
	s := economy.New(f.db.App, c)
	command := economy.Sell{ActorID: owner, RequestKey: "too-many", ItemID: signature, Quantity: 4}
	if r, err := s.Sell(f.ctx, command); err != nil || r.Status != "equipment_unavailable" {
		t.Fatalf("oversell: %v %v", r, err)
	}
	// A storage failure after component consumption rolls back the entire
	// bundle, wallet, sale history and command result, allowing a safe retry.
	if _, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.fail_component_sale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_component_sale BEFORE INSERT ON fishing.shop_sales FOR EACH ROW EXECUTE FUNCTION fishing.fail_component_sale()`); err != nil {
		t.Fatal(err)
	}
	command.RequestKey, command.Quantity = "retry-bundle", 2
	if _, err := s.Sell(f.ctx, command); err == nil {
		t.Fatal("expected injected sale failure")
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DROP TRIGGER fail_component_sale ON fishing.shop_sales`); err != nil {
		t.Fatal(err)
	}
	sold, err := s.Sell(f.ctx, command)
	if err != nil || sold.Status != "sold" {
		t.Fatalf("bundle retry: %v %v", sold, err)
	}
	replayed, err := s.Sell(f.ctx, command)
	if err != nil || replayed.Status != sold.Status || replayed.OperationID != sold.OperationID {
		t.Fatalf("bundle replay: %v %v", replayed, err)
	}
	var original, replay struct {
		Gain int64 `json:"gain"`
	}
	if json.Unmarshal(sold.Details, &original) != nil || json.Unmarshal(replayed.Details, &replay) != nil || original != replay {
		t.Fatalf("bundle replay details: %s %s", sold.Details, replayed.Details)
	}
	var wg sync.WaitGroup
	results := make([]assets.Result, 2)
	errs := make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Sell(f.ctx, economy.Sell{ActorID: owner, RequestKey: "race-" + strconv.Itoa(i), ItemID: signature, Quantity: 1})
		}(i)
	}
	wg.Wait()
	winners := 0
	for i, r := range results {
		if errs[i] != nil || (r.Status != "sold" && r.Status != "equipment_unavailable") {
			t.Fatalf("concurrent component sale: %v %v", r, errs[i])
		}
		if r.Status == "sold" {
			winners++
		}
	}
	var consumed, quantity, coinDifference int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='consumed'`, owner).Scan(&consumed); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT sum(quantity) FROM fishing.shop_sales WHERE owner_id=$1`, owner).Scan(&quantity); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT w.coins-(SELECT sum(gain) FROM fishing.shop_sales WHERE owner_id=$1) FROM fishing.wallets w WHERE w.account_id=$1`, owner).Scan(&coinDifference); err != nil {
		t.Fatal(err)
	}
	if winners != 1 || consumed != 3 || quantity != 3 || coinDifference != initialCoins {
		t.Fatalf("atomic sale reconciliation: winners=%d consumed=%d quantity=%d difference=%d", winners, consumed, quantity, coinDifference)
	}
}
