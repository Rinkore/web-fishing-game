package gateway

import (
	"testing"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func TestIntegrationLegacyShopStream(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	stream := openLegacyTradeStream(t, f, "trade_a")
	defer stream.cancel()
	init := stream.wait(t, "init", 5*time.Second)
	shop := init["shop"].(map[string]any)
	if shop["crucian"] == nil || shop["rope"] == nil {
		t.Fatalf("initial shop: %v", shop)
	}
	f.expectPost("/api/sell", `{"id":"crucian","qty":2}`, "trade_b", 200, "")
	frame := stream.wait(t, "shop", 5*time.Second)
	row := frame["shop"].(map[string]any)["crucian"].(map[string]any)
	if row["soldTotal"] != float64(2) || row["soldToday"] != float64(2) {
		t.Fatalf("sale not broadcast: %v", row)
	}
	code, current := f.do("GET", "/shop", "", "")
	if code != 200 || jsonString(current) != jsonString(frame["shop"]) {
		t.Fatalf("HTTP/SSE quote divergence: %v %v", current, frame)
	}
	// Read failures never replace a valid board with {} or acknowledge it.
	c, _ := rules.Default()
	api := &API{pool: f.db.App}
	p := &legacyShopPush{api: api, catalog: c}
	if p.init(f.ctx) == nil {
		t.Fatal("initial snapshot")
	}
	if len(p.poll(f.ctx)) != 0 {
		t.Fatal("unchanged board repeated")
	}
	f.expectPost("/api/sell", `{"id":"crucian","qty":1}`, "trade_b", 200, "")
	api.shopCache.at = time.Time{} // Expire this isolated test cache.
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(f.ctx, "REVOKE SELECT ON fishing.economy_prices FROM "+role); err != nil {
		t.Fatal(err)
	}
	before := p.last
	if got := p.poll(f.ctx); len(got) != 0 || p.last != before {
		t.Fatal("failed board acknowledged")
	}
	if _, err := f.db.Admin.Exec(f.ctx, "GRANT SELECT ON fishing.economy_prices TO "+role); err != nil {
		t.Fatal(err)
	}
	got := socialFrames(t, p.poll(f.ctx))
	if got["shop"]["shop"].(map[string]any)["crucian"].(map[string]any)["soldTotal"] != float64(3) {
		t.Fatalf("retry: %v", got)
	}
	// A new immutable catalog invalidates the shared price cache immediately.
	c2, _ := rules.Default()
	c2.SourceSHA256 = "synthetic-price-change"
	for i := range c2.Items {
		if c2.Items[i].ID == "crucian" {
			c2.Items[i].Price *= 2
		}
	}
	p.catalog = c2
	if len(p.poll(f.ctx)) != 1 {
		t.Fatal("catalog price change did not invalidate cache")
	}
}
