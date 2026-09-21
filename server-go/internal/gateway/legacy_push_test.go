package gateway

import (
	"strings"
	"testing"
	"time"
)

// TestIntegrationLegacyPush covers the /events projections that do not belong
// to a single HTTP domain: market fills and listing revisions, friend relation
// notices, and the registered player-list viewport.
func TestIntegrationLegacyPush(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	feedA := openLegacyTradeStream(t, f, "trade_a")
	defer feedA.cancel()
	feedB := openLegacyTradeStream(t, f, "trade_b")
	defer feedB.cancel()
	init := feedA.wait(t, "init", 10*time.Second)
	if init["marketRevision"] == nil || init["marketTotal"] == nil {
		t.Fatalf("init market snapshot: %v", init)
	}
	// Drain B's init as well so every later frame is a real projection.
	feedB.wait(t, "init", 10*time.Second)

	// Market: A lists the single rope it owns, B buys it. The seller is not on
	// the market page, so the stream has to carry both the trade event and the
	// authoritative assets snapshot.
	code, listed := f.post("/api/market/list", `{"id":"rope","qty":1,"price":100,"hours":6}`, "trade_a")
	if code != 200 {
		t.Fatalf("list: %d %v", code, listed)
	}
	lid, _ := listed["listing"].(map[string]any)["lid"].(float64)
	code, bought := f.post("/api/market/buy", `{"lid":`+itoa(int64(lid))+`}`, "trade_b")
	if code != 200 {
		t.Fatalf("buy: %d %v", code, bought)
	}
	sale := feedA.wait(t, "mktTrade", 15*time.Second)
	if sale["role"] != "sell" || sale["id"] != "rope" || sale["qty"] != float64(1) ||
		sale["price"] != float64(100) || sale["total"] != float64(100) || sale["tax"] != float64(10) ||
		sale["sellerGain"] != float64(90) || sale["other"] != "trade_b" {
		t.Fatalf("seller mktTrade: %v", sale)
	}
	purchase := feedB.wait(t, "mktTrade", 15*time.Second)
	if purchase["role"] != "buy" || purchase["other"] != "trade_a" || purchase["total"] != float64(100) {
		t.Fatalf("buyer mktTrade: %v", purchase)
	}
	assets := feedA.wait(t, "assets", 15*time.Second)
	// Registration grants 500 coins; the listing fee is 1 and the sale nets 90.
	if assets["coins"] != float64(589) {
		t.Fatalf("seller assets after sale: %v", assets)
	}
	if inventory, ok := assets["inventory"].(map[string]any); !ok || inventory["rope"] != nil {
		t.Fatalf("seller inventory after sale: %v", assets["inventory"])
	}
	delta := feedA.wait(t, "marketDelta", 15*time.Second)
	if delta["revision"] == nil || delta["total"] == nil {
		t.Fatalf("marketDelta: %v", delta)
	}

	// Friends: the invitee gets the request notice, the inviter the accepted one.
	f.expectPost("/api/friends", `{"target":"trade_b","action":"request"}`, "trade_a", 200, "")
	feedB.wait(t, "friends", 15*time.Second)
	notice := feedB.wait(t, "notice", 15*time.Second)
	if message, _ := notice["msg"].(string); !strings.Contains(message, "请求加你为好友") || !strings.Contains(message, "@trade_a") {
		t.Fatalf("friend request notice: %v", notice)
	}
	f.expectPost("/api/friends", `{"target":"trade_a","action":"accept"}`, "trade_b", 200, "")
	feedA.wait(t, "friends", 15*time.Second)
	accepted := feedA.wait(t, "notice", 15*time.Second)
	if message, _ := accepted["msg"].(string); !strings.Contains(message, "已同意你的好友请求") || !strings.Contains(message, "@trade_b") {
		t.Fatalf("friend accepted notice: %v", accepted)
	}

	// Player list: only a registered viewport receives playersPage, and clearing
	// the registration stops it.
	code, viewport := f.post("/api/players/view", `{"page":1,"size":30,"q":"","ground":null,"spot":null,"clear":false}`, "trade_a")
	if code != 200 || viewport["ok"] != true || viewport["pushed"] == float64(0) {
		t.Fatalf("players view registration: %d %v", code, viewport)
	}
	page := feedA.wait(t, "playersPage", 15*time.Second)
	players, _ := page["players"].([]any)
	if len(players) == 0 || page["total"] == float64(0) {
		t.Fatalf("playersPage payload: %v", page)
	}
	found := false
	for _, entry := range players {
		if entry.(map[string]any)["id"] == "trade_a" {
			found = true
		}
	}
	if !found {
		t.Fatalf("playersPage rows: %v", players)
	}
	if code, body := f.post("/api/players/view", `{"clear":true}`, "trade_a"); code != 200 || body["ok"] != true {
		t.Fatalf("players view clear: %d %v", code, body)
	}
}
