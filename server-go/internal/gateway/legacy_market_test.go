package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// TestIntegrationLegacyMarket covers the original market page contract: the
// paginated public snapshot, list/buy/cancel writes, history and the item
// identities (stack id, component signature and the "rodset:" whole rod).
func TestIntegrationLegacyMarket(t *testing.T) {
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(context.Background(), db.Admin, c); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()

	do := func(method, path, body, token string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, value
	}
	register := func(username string) (string, identity.Session) {
		code, body := do("POST", "/api/register", `{"username":"`+username+`","password":"Synthetic-Pass42","qq":"123456","name":"`+username+`"}`, "")
		if code != 200 {
			t.Fatalf("register %s: %d %v", username, code, body)
		}
		token := body["token"].(string)
		session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
		if err != nil {
			t.Fatal(err)
		}
		return token, session
	}
	sellerToken, seller := register("legacy_market_sell")
	buyerToken, buyer := register("legacy_market_buy")

	change := func(owner int64, key string, change assets.Change) assets.Result {
		t.Helper()
		change.ActorID, change.RequestKey, change.Reason, change.RuleVersion = owner, key, "reward", "test-v1"
		result, err := assets.New(db.App).ApplyChange(context.Background(), change)
		if err != nil {
			t.Fatalf("apply change %s: %v", key, err)
		}
		return result
	}
	change(seller.AccountID, "fund", assets.Change{Coins: 1000000})
	change(seller.AccountID, "stock", assets.Change{Stacks: []assets.StackDelta{
		{ItemID: "relic", Tier: "normal", Quantity: 10},
		{ItemID: "chest_wreck", Tier: "normal", Quantity: 3},
	}})
	// The buyer starts with an empty wallet plus a rod slot budget for the
	// whole-rod purchase below.
	change(buyer.AccountID, "fund", assets.Change{Coins: 100000})

	inventory := func(token string) map[string]any {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["inventory"].(map[string]any)
	}
	coins := func(token string) float64 {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["coins"].(float64)
	}
	sellerStart, buyerStart := coins(sellerToken), coins(buyerToken)

	// Anonymous page reads are allowed; scope=mine is not.
	code, empty := do("GET", "/api/market?page=1&size=30", "", "")
	if code != 200 || empty["marketTotal"] != float64(0) || empty["pages"] != float64(1) {
		t.Fatalf("empty market page: %d %v", code, empty)
	}
	if code, body := do("GET", "/api/market?scope=mine", "", ""); code != 400 || body["error"] != "查看我的挂单需登录" {
		t.Fatalf("anonymous scope=mine: %d %v", code, body)
	}
	if code, body := do("GET", "/api/market?bogus=1", "", ""); code != 400 || body["error"] != "未知市集查询参数" {
		t.Fatalf("unknown query: %d %v", code, body)
	}
	if code, body := do("GET", "/api/market?page=0", "", ""); code != 400 || body["error"] != "市集分页参数无效" {
		t.Fatalf("bad page: %d %v", code, body)
	}

	// Stack listing: 4 relics at 100 for 6 hours (1% fee).
	code, listed := do("POST", "/api/market/list", `{"id":"relic","qty":4,"price":100,"hours":6}`, sellerToken)
	if code != 200 || listed["ok"] != true || listed["fee"] != float64(4) {
		t.Fatalf("stack listing: %d %v", code, listed)
	}
	listing := listed["listing"].(map[string]any)
	relicLid := listing["lid"].(float64)
	if listing["id"] != "relic" || listing["qty"] != float64(4) || listing["price"] != float64(100) || listing["hours"] != float64(6) {
		t.Fatalf("stack listing identity: %v", listing)
	}
	if got := inventory(sellerToken)["relic"]; got != float64(6) {
		t.Fatalf("seller relics after listing: %v", got)
	}
	if got := coins(sellerToken); got != sellerStart-4 {
		t.Fatalf("seller coins after fee: %v", got)
	}
	// Fish are still blocked from the market without charging a listing fee.
	if code, body := do("POST", "/api/market/list", `{"id":"crucian","qty":1,"price":100,"hours":6}`, sellerToken); code != 400 || !strings.Contains(body["error"].(string), "鱼类暂时不能在市集上架") {
		t.Fatalf("fish listing: %d %v", code, body)
	}
	if code, body := do("POST", "/api/market/list", `{"item":"x","id":"relic","qty":1,"price":1,"hours":6}`, sellerToken); code != 400 {
		t.Fatalf("unknown field accepted: %d %v", code, body)
	}
	if code, body := do("POST", "/api/market/list", `{"id":"relic","qty":1,"price":1,"hours":7}`, sellerToken); code != 400 || body["error"] != "时长必须为 6、12 或 24" {
		t.Fatalf("bad hours: %d %v", code, body)
	}
	// Chest listing: 2 chests at 5000 for 12 hours (3% fee).
	code, chest := do("POST", "/api/market/list", `{"id":"chest_wreck","qty":2,"price":5000,"hours":12}`, sellerToken)
	if code != 200 || chest["fee"] != float64(300) {
		t.Fatalf("chest listing: %d %v", code, chest)
	}
	chestLid := chest["listing"].(map[string]any)["lid"].(float64)

	// Page projection: counts, scope filters, sorting and mineCount.
	code, page := do("GET", "/api/market?size=30", "", sellerToken)
	if code != 200 {
		t.Fatalf("market page: %d %v", code, page)
	}
	if page["marketTotal"] != float64(2) || page["total"] != float64(2) || page["mineCount"] != float64(2) {
		t.Fatalf("market totals: %v", page)
	}
	counts := page["counts"].(map[string]any)
	if counts["material"] != float64(1) || counts["chest"] != float64(1) {
		t.Fatalf("market counts: %v", counts)
	}
	ordered := page["listings"].([]any)
	if len(ordered) != 2 || ordered[0].(map[string]any)["id"] != "chest_wreck" {
		t.Fatalf("default time sort: %v", ordered)
	}
	if listings := page["listings"].([]any); listings[0].(map[string]any)["seller"] != "legacy_market_sell" {
		t.Fatalf("listing seller: %v", listings[0])
	}
	if code, body := do("GET", "/api/market?scope=others", "", sellerToken); code != 200 || body["total"] != float64(0) {
		t.Fatalf("others scope for seller: %d %v", code, body)
	}
	if code, body := do("GET", "/api/market?kind=material&sort=price&dir=asc", "", ""); code != 200 || body["total"] != float64(1) {
		t.Fatalf("kind filter: %d %v", code, body)
	}
	if code, body := do("GET", "/api/market?kind=chest&sort=price&dir=desc", "", ""); code != 200 {
		t.Fatalf("price sort: %d %v", code, body)
	} else if items := body["listings"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != "chest_wreck" {
		t.Fatalf("price sort listings: %v", items)
	}
	if code, body := do("GET", "/api/market?kind=chest&affix=speed&min=1", "", ""); code != 200 || body["total"] != float64(0) {
		t.Fatalf("affix filter on stacks: %d %v", code, body)
	}
	if code, body := do("GET", "/api/market?q=legacy_market_sell", "", ""); code != 200 || body["total"] != float64(2) {
		t.Fatalf("seller search: %d %v", code, body)
	}

	// Partial purchase: 1 of 2 chests at 5000, 10% tax on the seller.
	code, bought := do("POST", "/api/market/buy", `{"lid":`+itoa(int64(chestLid))+`,"qty":1}`, buyerToken)
	if code != 200 || bought["qty"] != float64(1) || bought["total"] != float64(5000) || bought["tax"] != float64(500) {
		t.Fatalf("partial buy: %d %v", code, bought)
	}
	if got := inventory(buyerToken)["chest_wreck"]; got != float64(1) {
		t.Fatalf("buyer chests: %v", got)
	}
	if got := coins(buyerToken); got != buyerStart-5000 {
		t.Fatalf("buyer coins after chest: %v", got)
	}
	// Listing fees (4 + 300) are spent up front; the 5000 chest sale nets 4500
	// after the 10% tax.
	if got := coins(sellerToken); got != sellerStart-4-300+4500 {
		t.Fatalf("seller coins after sale: %v", got)
	}
	if code, body := do("POST", "/api/market/buy", `{"lid":`+itoa(int64(chestLid))+`,"qty":2}`, buyerToken); code != 400 || body["error"] != "购买数量超过挂单数量" {
		t.Fatalf("overbuy: %d %v", code, body)
	}
	if code, body := do("POST", "/api/market/buy", `{"lid":`+itoa(int64(chestLid))+`}`, sellerToken); code != 400 || body["error"] != "不能购买自己的挂单" {
		t.Fatalf("self buy: %d %v", code, body)
	}
	if code, body := do("POST", "/api/market/buy", `{"lid":999999}`, buyerToken); code != 404 || body["error"] != "该挂单已不存在" {
		t.Fatalf("missing listing buy: %d %v", code, body)
	}

	// History shows the same trade for both sides with the data.js identity.
	for _, entry := range []struct{ token, label string }{{buyerToken, "buyer"}, {sellerToken, "seller"}} {
		code, history := do("GET", "/api/market/history", "", entry.token)
		if code != 200 {
			t.Fatalf("%s history: %d %v", entry.label, code, history)
		}
		trades := history["trades"].([]any)
		if len(trades) != 1 {
			t.Fatalf("%s history length: %v", entry.label, trades)
		}
		trade := trades[0].(map[string]any)
		if trade["id"] != "chest_wreck" || trade["qty"] != float64(1) || trade["price"] != float64(5000) ||
			trade["total"] != float64(5000) || trade["tax"] != float64(500) ||
			trade["buyer"] != "legacy_market_buy" || trade["seller"] != "legacy_market_sell" {
			t.Fatalf("%s history trade: %v", entry.label, trade)
		}
	}

	// Only the owner may cancel; the listing fee is never refunded.
	if code, body := do("POST", "/api/market/cancel", `{"lid":`+itoa(int64(relicLid))+`}`, buyerToken); code != 403 || body["error"] != "只能下架自己的挂单" {
		t.Fatalf("foreign cancel: %d %v", code, body)
	}
	code, cancelled := do("POST", "/api/market/cancel", `{"lid":`+itoa(int64(relicLid))+`}`, sellerToken)
	if code != 200 || cancelled["ok"] != true {
		t.Fatalf("cancel: %d %v", code, cancelled)
	}
	if got := inventory(sellerToken)["relic"]; got != float64(10) {
		t.Fatalf("seller relics after cancel: %v", got)
	}
	if got := coins(sellerToken); got != sellerStart-4-300+4500 {
		t.Fatalf("seller coins after cancel: %v", got)
	}
	if code, body := do("POST", "/api/market/cancel", `{"lid":`+itoa(int64(relicLid))+`}`, sellerToken); code != 404 {
		t.Fatalf("cancel twice: %d %v", code, body)
	}

	// Component listing: the legacy id is the instance signature, and a held
	// instance leaves the loose inventory while it is escrowed.
	signature := "rod_bamboo#common#"
	base, _, _, ok := c.Instance(signature)
	if !ok {
		t.Fatal("bad fixture signature")
	}
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	for i := 0; i < 2; i++ {
		if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
			ActorID: seller.AccountID, RequestKey: "component-" + itoa(int64(i)), Reason: "reward", RuleVersion: "test-v1",
			Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := inventory(sellerToken)[signature]; got != float64(2) {
		t.Fatalf("component inventory projection: %v", got)
	}
	code, component := do("POST", "/api/market/list", `{"id":"`+signature+`","qty":1,"price":5000,"hours":6}`, sellerToken)
	if code != 200 {
		t.Fatalf("component listing: %d %v", code, component)
	}
	componentListing := component["listing"].(map[string]any)
	if componentListing["id"] != signature || componentListing["qty"] != float64(1) || componentListing["hours"] != float64(6) {
		t.Fatalf("component listing identity: %v", componentListing)
	}
	if got := inventory(sellerToken)[signature]; got != float64(1) {
		t.Fatalf("component inventory while escrowed: %v", got)
	}
	code, page = do("GET", "/api/market?kind=component", "", "")
	if code != 200 || page["total"] != float64(1) || page["counts"].(map[string]any)["component"] != float64(1) {
		t.Fatalf("component page: %d %v", code, page)
	}
	if parts := page["parts"].(map[string]any); parts["rod"] != float64(1) {
		t.Fatalf("component parts: %v", parts)
	}
	code, bought = do("POST", "/api/market/buy", `{"lid":`+itoa(int64(componentListing["lid"].(float64)))+`}`, buyerToken)
	if code != 200 || bought["qty"] != float64(1) || bought["total"] != float64(5000) {
		t.Fatalf("component buy: %d %v", code, bought)
	}
	if got := inventory(buyerToken)[signature]; got != float64(1) {
		t.Fatalf("buyer component: %v", got)
	}
	if got := coins(buyerToken); got != buyerStart-10000 {
		t.Fatalf("buyer coins after component: %v", got)
	}

	// Whole rod: the legacy identity is rebuilt from the escrowed components.
	if code, body := do("POST", "/api/bd/set", `{"part":"rod","compId":"`+signature+`"}`, sellerToken); code != 200 {
		t.Fatalf("equip: %d %v", code, body)
	}
	if code, body := do("POST", "/api/rod/save", `{"slot":0}`, sellerToken); code != 200 {
		t.Fatalf("save rod: %d %v", code, body)
	}
	code, rod := do("POST", "/api/market/list", `{"rodSlot":0,"price":8000,"hours":6}`, sellerToken)
	if code != 200 {
		t.Fatalf("rod listing: %d %v", code, rod)
	}
	rodListing := rod["listing"].(map[string]any)
	wantRodID := "rodset:rod=" + signature
	if rodListing["id"] != wantRodID || rodListing["name"] != "整根钓竿（1 件）" || rodListing["qty"] != float64(1) {
		t.Fatalf("rod listing identity: %v", rodListing)
	}
	if slots := rod["rodSlots"].([]any); slots[0] != nil {
		t.Fatalf("rod slot after listing: %v", slots[0])
	}
	code, page = do("GET", "/api/market?kind=rod", "", "")
	if code != 200 || page["total"] != float64(1) || page["counts"].(map[string]any)["rod"] != float64(1) {
		t.Fatalf("rod page: %d %v", code, page)
	}
	if items := page["listings"].([]any); items[0].(map[string]any)["id"] != wantRodID {
		t.Fatalf("rod page identity: %v", items[0])
	}
	// The whole rod must be bought as a single order.
	if code, body := do("POST", "/api/market/buy", `{"lid":`+itoa(int64(rodListing["lid"].(float64)))+`,"qty":1}`, buyerToken); code != 200 {
		t.Fatalf("rod buy: %d %v", code, body)
	}
	code, profile := do("GET", "/api/me", "", buyerToken)
	if code != 200 {
		t.Fatalf("buyer me: %d %v", code, profile)
	}
	slots := profile["rodSlots"].([]any)
	if slots[0] == nil || slots[0].(map[string]any)["rodId"] != wantRodID {
		t.Fatalf("buyer rod slot: %v", slots[0])
	}
	if parts := slots[0].(map[string]any)["parts"].(map[string]any); parts["rod"] != signature {
		t.Fatalf("buyer rod parts: %v", parts)
	}
	if got := coins(buyerToken); got != buyerStart-18000 {
		t.Fatalf("buyer coins after rod: %v", got)
	}
	code, history := do("GET", "/api/market/history", "", buyerToken)
	if code != 200 {
		t.Fatalf("buyer history after rod: %d %v", code, history)
	}
	trades := history["trades"].([]any)
	if len(trades) != 3 {
		t.Fatalf("buyer history length: %v", trades)
	}
	last := trades[0].(map[string]any)
	if last["id"] != wantRodID || last["name"] != "整根钓竿（1 件）" || last["total"] != float64(8000) || last["tax"] != float64(800) {
		t.Fatalf("rod history trade: %v", last)
	}
}

func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}
