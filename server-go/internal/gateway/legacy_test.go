package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyProfileShape(t *testing.T) {
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
	client.Timeout = 5 * time.Second

	request := func(method, path, body, cookie string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
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

	code, value := request("POST", "/api/register", `{"username":"legacy_profile","password":"Synthetic-Pass42","qq":"123456","name":"Legacy"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, value)
	}
	// Registration defaults to Bearer mode; use the returned token directly.
	token := value["token"].(string)
	svc := identity.New(db.App, nil)
	session, err := svc.Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}

	// Seed fish across all three tiers plus one material, and codex entries.
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: session.AccountID, RequestKey: "seed-fish", Reason: "reward", RuleVersion: "test-v1",
		Stacks: []assets.StackDelta{
			{ItemID: "crucian", Tier: "normal", Quantity: 3},
			{ItemID: "crucian", Tier: "large", Quantity: 2},
			{ItemID: "crucian", Tier: "giant", Quantity: 1},
			{ItemID: "bait_pack", Tier: "normal", Quantity: 5},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at,min_size,max_size,best_tier) VALUES($1,'crucian',6,clock_timestamp(),12,48,'large')`, session.AccountID); err != nil {
		t.Fatal(err)
	}

	get := func(path string) (int, map[string]any) {
		r, err := http.NewRequest("GET", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+token)
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

	code, profile := get("/api/me")
	if code != 200 {
		t.Fatalf("legacy me: %d", code)
	}
	if profile["username"] != "legacy_profile" || profile["name"] != "Legacy" || profile["coins"] != float64(500) {
		t.Fatalf("identity fields: %v", profile)
	}
	if profile["catchCount"] != float64(0) {
		t.Fatalf("catchCount: %v", profile["catchCount"])
	}
	if profile["listingCap"] != float64(40) {
		t.Fatalf("listingCap: %v", profile["listingCap"])
	}
	inv := profile["inventory"].(map[string]any)
	if inv["crucian"] != float64(6) || inv["bait_pack"] != float64(5) {
		t.Fatalf("inventory flattening: %v", inv)
	}
	bf := profile["bigfish"].(map[string]any)
	crucian := bf["crucian"].(map[string]any)
	if crucian["L"] != float64(2) || crucian["G"] != float64(1) {
		t.Fatalf("bigfish split: %v", crucian)
	}
	codex := profile["codex"].(map[string]any)
	entry := codex["crucian"].(map[string]any)
	if entry["count"] != float64(6) || entry["tier"] != "L" || entry["max"] != float64(48) || entry["min"] != float64(12) {
		t.Fatalf("codex mapping: %v", entry)
	}
	if profile["rodSlotsCount"] != float64(1) || profile["rodSlotsMax"] != float64(8) || profile["rodActiveSlot"] != float64(-1) {
		t.Fatalf("rod defaults: %v", profile)
	}
	if profile["nextRodSlotPrice"] != float64(10000) || profile["freeRodSlots"] != float64(0) {
		t.Fatalf("rod pricing: %v", profile)
	}

	code, ver := get("/api/version")
	if code != 200 || ver["version"] == nil || ver["version"] == "" {
		t.Fatalf("legacy version: %d %v", code, ver)
	}

	code, grounds := get("/api/grounds")
	if code != 200 {
		t.Fatalf("legacy grounds: %d", code)
	}
	gs := grounds["grounds"].([]any)
	if len(gs) == 0 {
		t.Fatal("legacy grounds empty")
	}
	first := gs[0].(map[string]any)
	if first["id"] != "map" {
		t.Fatalf("legacy grounds shape: %v", first)
	}
	spots := first["spots"].([]any)
	if len(spots) == 0 {
		t.Fatal("legacy grounds spots empty")
	}

	code, codexResp := get("/api/codex")
	if code != 200 {
		t.Fatalf("legacy codex: %d", code)
	}
	codexMap := codexResp["codex"].(map[string]any)
	entry = codexMap["crucian"].(map[string]any)
	if entry["count"] != float64(6) || entry["tier"] != "L" {
		t.Fatalf("legacy codex mapping: %v", entry)
	}

	code, shop := get("/shop")
	if code != 200 {
		t.Fatalf("legacy shop: %d", code)
	}
	if _, ok := shop["crucian"]; !ok {
		t.Fatalf("legacy shop missing crucian: %v", shop)
	}
	row := shop["crucian"].(map[string]any)
	if row["base"] != float64(8) || row["price"] == nil {
		t.Fatalf("legacy shop row: %v", row)
	}

	code, hist := get("/api/shop/history?id=crucian")
	if code != 200 || hist["id"] != "crucian" || hist["base"] != float64(8) {
		t.Fatalf("legacy shop history: %d %v", code, hist)
	}
	if code, _ := get("/api/shop/history?id=no_such_item"); code != 404 {
		t.Fatalf("unknown shop history item: %d", code)
	}

	code, banner := get("/api/banner")
	if code != 200 || len(banner["banners"].([]any)) != 0 || banner["seq"] != float64(1) {
		t.Fatalf("legacy banner: %d %v", code, banner)
	}

	// Insert two players' catches to exercise records/top shapes.
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,'rec-a',decode(repeat('11',32),'hex'))`, session.AccountID); err != nil {
		t.Fatal(err)
	}
	var opA int64
	if err := db.Admin.QueryRow(context.Background(), `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,'rec-a','fishing_settle','test-v1') RETURNING id`, session.AccountID).Scan(&opA); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at) VALUES($1,1,$2,'crucian',30,'map','dock',clock_timestamp())`, opA, session.AccountID); err != nil {
		t.Fatal(err)
	}

	code, records := get("/api/records")
	if code != 200 {
		t.Fatalf("legacy records: %d", code)
	}
	recMap := records["records"].(map[string]any)
	crucianRec := recMap["crucian"].(map[string]any)
	if crucianRec["name"] != "鲫鱼" || crucianRec["size"] != float64(30) || crucianRec["who"] == "" {
		t.Fatalf("legacy records entry: %v", crucianRec)
	}
	if records["globalMax"] == nil {
		t.Fatal("legacy records globalMax missing")
	}

	code, top := get("/api/records/top?id=crucian&range=all")
	if code != 200 {
		t.Fatalf("legacy records top: %d", code)
	}
	topList := top["top"].([]any)
	if len(topList) != 1 {
		t.Fatalf("legacy records top list: %v", topList)
	}
	firstTop := topList[0].(map[string]any)
	if firstTop["who"] == "" || firstTop["size"] != float64(30) || firstTop["self"] != true {
		t.Fatalf("legacy records top entry: %v", firstTop)
	}
	if top["personal"] == nil {
		t.Fatal("legacy records top personal missing")
	}

	code, features := get("/api/features")
	if code != 200 || features["features"] == nil {
		t.Fatalf("legacy features: %d %v", code, features)
	}

	// Legacy sell: sell one crucian from the seeded inventory and verify the
	// gain plus authoritative snapshots in the response.
	sellBody := `{"id":"crucian","qty":1}`
	r, err := http.NewRequest("POST", server.URL+"/api/sell", strings.NewReader(sellBody))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	sellRes, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer sellRes.Body.Close()
	var sold map[string]any
	if err := json.NewDecoder(sellRes.Body).Decode(&sold); err != nil {
		t.Fatal(err)
	}
	if sellRes.StatusCode != 200 || sold["ok"] != true || sold["gain"] == nil {
		t.Fatalf("legacy sell: %d %v", sellRes.StatusCode, sold)
	}
	invAfter := sold["inventory"].(map[string]any)
	if invAfter["crucian"] != float64(5) {
		t.Fatalf("legacy sell inventory: %v", invAfter)
	}
	if sold["shop"] == nil {
		t.Fatal("legacy sell shop snapshot missing")
	}
}
