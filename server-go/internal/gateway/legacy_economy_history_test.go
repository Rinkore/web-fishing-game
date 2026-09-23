package gateway

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/rules"
)

func TestIntegrationImportedEconomyHistoryReadableWithoutReplayingAssets(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	before := f.coins(f.playerID)
	now := time.Now().Add(-time.Hour).UnixMilli()
	fixtures := []struct {
		kind, id string
		value    map[string]any
	}{
		{"price", "crucian", map[string]any{"t": now, "p": 77}},
		{"shop", "crucian", map[string]any{"t": now, "who": "Synthetic", "qty": 12, "unit": 77}},
		{"price", "tide_sand", map[string]any{"t": now, "p": 123}},
		{"shop", "tide_sand", map[string]any{"t": now, "who": "Synthetic", "qty": 7, "unit": 123}},
		{"market", "", map[string]any{"t": now, "buyer": f.playerKey, "seller": "other", "qty": 1, "price": 44, "id": "crucian"}},
		{"audit", "", map[string]any{"t": now, "who": "Synthetic admin", "text": "Imported economy setting"}},
	}
	for _, v := range fixtures {
		raw, _ := json.Marshal(v.value)
		if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.legacy_economy_history(kind,item_id,ordinal,payload,occurred_at) VALUES($1,$2,0,$3,$4)`, v.kind, v.id, raw, time.UnixMilli(now)); err != nil {
			t.Fatal(err)
		}
	}
	code, body := f.call("GET", "/api/shop/history?id=crucian", "", "")
	f.expect(code, body, 200, "")
	if len(body["points"].([]any)) != 1 || len(body["trades"].([]any)) != 1 {
		t.Fatal("imported shop history missing")
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('tide_sand','material') ON CONFLICT(id) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.economy_prices(item_id,state) VALUES('tide_sand',$1) ON CONFLICT(item_id) DO UPDATE SET state=excluded.state`, []byte(`{"soldTotal":7,"soldToday":3,"day":"2000-01-01"}`)); err != nil {
		t.Fatal(err)
	}
	code, body = f.call("GET", "/api/shop/history?id=tide_sand", "", "")
	f.expect(code, body, 200, "")
	if len(body["points"].([]any)) != 1 || len(body["trades"].([]any)) != 1 || body["soldTotal"] != float64(7) || body["soldToday"] != float64(0) {
		t.Fatal("unsellable material lost imported history or counters")
	}
	code, body = f.call("GET", "/shop", "", "")
	f.expect(code, body, 200, "")
	if _, exists := body["tide_sand"]; exists {
		t.Fatal("historical material was made sellable")
	}
	for _, id := range []string{"unknown_item", "rod_fiberglass"} {
		code, body = f.call("GET", "/api/shop/history?id="+id, "", "")
		f.expect(code, body, 404, "unknown_item")
	}
	code, body = f.player("GET", "/api/market/history", "")
	f.expect(code, body, 200, "")
	if len(body["trades"].([]any)) != 1 {
		t.Fatal("personal imported market history missing")
	}
	otherToken, _ := f.register("history_other", "Other")
	code, body = f.call("GET", "/api/market/history", "", otherToken)
	f.expect(code, body, 200, "")
	if len(body["trades"].([]any)) != 0 {
		t.Fatal("another user's market history leaked")
	}
	code, body = f.admin("GET", "/api/admin/world", "")
	f.expect(code, body, 200, "")
	if len(body["economyLog"].([]any)) != 1 {
		t.Fatal("economic audit history missing")
	}
	if f.coins(f.playerID) != before {
		t.Fatal("historical trade replayed a payment")
	}
}

func TestIntegrationImportedPriceOverrideCanBeReadChangedAndCleared(t *testing.T) {
	f := newAdminFixture(t)
	code, body := f.admin("POST", "/api/admin/settings", `{"priceOv":{"id":"crucian","base":70,"m":2,"untilMin":30}}`)
	f.expect(code, body, 200, "")
	c, _, err := catalog.Current(context.Background(), f.db.App)
	if err != nil {
		t.Fatal(err)
	}
	o := c.PriceOverrideFor("crucian", time.Now().UnixMilli())
	if o.Base != 70 || o.Multiplier != 2 || o.UntilMS <= time.Now().UnixMilli() {
		t.Fatal("override did not publish")
	}
	code, body = f.call("GET", "/shop", "", "")
	f.expect(code, body, 200, "")
	quote := body["crucian"].(map[string]any)
	if quote["base"] != float64(70) || quote["price"] != float64(140) {
		t.Fatal("settlement quote ignored override")
	}
	if o := c.PriceOverrideFor("crucian", time.Now().Add(time.Hour).UnixMilli()); o.Base != 0 || o.Multiplier != 0 {
		t.Fatal("override did not expire")
	}
	code, body = f.admin("POST", "/api/admin/settings", `{"priceOv":{"id":"crucian","clear":true}}`)
	f.expect(code, body, 200, "")
	c, _, err = catalog.Current(context.Background(), f.db.App)
	if err != nil {
		t.Fatal(err)
	}
	if c.PriceOverrideFor("crucian", time.Now().UnixMilli()) != (rules.PriceOverride{}) {
		t.Fatal("override not cleared")
	}
}
