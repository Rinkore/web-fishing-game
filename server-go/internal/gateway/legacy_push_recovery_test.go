package gateway

import (
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func TestIntegrationMarketPushDrainsAndRetries(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	_, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: f.id["trade_a"], RequestKey: "fill-stock", Reason: "reward", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "rope", Tier: "normal", Quantity: 19}}})
	if err != nil {
		t.Fatal(err)
	}
	c, _ := rules.Default()
	p := &legacyMarketPush{api: &API{pool: f.db.App}, owner: f.id["trade_a"], catalog: c}
	p.init(f.ctx)
	code, body := f.post("/api/market/list", `{"id":"rope","qty":20,"price":10,"hours":6}`, "trade_a")
	if code != 200 {
		t.Fatalf("list %d %v", code, body)
	}
	lid := int64(body["listing"].(map[string]any)["lid"].(float64))
	for i := 0; i < 20; i++ {
		f.expectPost("/api/market/buy", fmt.Sprintf(`{"lid":%d,"qty":1}`, lid), "trade_b", 200, "")
	}
	role := pgx.Identifier{f.db.Role}.Sanitize()
	beforeRev, beforeCursor := p.revision, p.fillCursor
	if _, err := f.db.Admin.Exec(f.ctx, "REVOKE SELECT ON fishing.inventory_stacks FROM "+role); err != nil {
		t.Fatal(err)
	}
	if got := p.poll(f.ctx); len(got) != 0 || p.revision != beforeRev || p.fillCursor != beforeCursor {
		t.Fatalf("failed snapshot acknowledged fills: %v", got)
	}
	if _, err := f.db.Admin.Exec(f.ctx, "GRANT SELECT ON fishing.inventory_stacks TO "+role); err != nil {
		t.Fatal(err)
	}
	for page, want := range []int{16, 4, 0} {
		got := 0
		for _, frame := range decodePersonalFrames(t, p.poll(f.ctx)) {
			if frame["type"] == "mktTrade" {
				got++
			}
		}
		if got != want {
			t.Fatalf("page %d: got %d want %d", page, got, want)
		}
	}
}

func TestIntegrationFriendPushInitWindow(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	p := &legacyFriendPush{api: &API{pool: f.db.App}, owner: f.id["trade_b"]}
	p.init(f.ctx)
	f.expectPost("/api/friends", `{"target":"trade_b","action":"request"}`, "trade_a", 200, "")
	frames := socialFrames(t, p.poll(f.ctx))
	if frames["friends"] == nil || frames["notice"] == nil {
		t.Fatalf("request between init and first tick lost: %v", frames)
	}
}
