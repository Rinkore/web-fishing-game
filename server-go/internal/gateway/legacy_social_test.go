package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// TestIntegrationLegacySocial covers the original friends contract plus the
// paginated player list and the read-only rod view: username-keyed identities,
// presence projected from the stream leases and the fishing sessions, and the
// legacy Chinese rejection text.
func TestIntegrationLegacySocial(t *testing.T) {
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
	tokens := map[string]string{}
	ids := map[string]int64{}
	for _, name := range []string{"social_a", "social_b", "social_c"} {
		code, body := do("POST", "/api/register", `{"username":"`+name+`","password":"Synthetic-Pass42","qq":"123456","name":"`+name+`"}`, "")
		if code != 200 {
			t.Fatalf("register %s: %d %v", name, code, body)
		}
		token := body["token"].(string)
		session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
		if err != nil {
			t.Fatal(err)
		}
		tokens[name], ids[name] = token, session.AccountID
	}
	ctx := context.Background()
	// Presence: a and b hold live stream leases; b is also out fishing. c stays
	// offline so the friend list can show the offline row.
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at)
 VALUES($1,repeat('a',32),clock_timestamp()+interval '1 hour'),($2,repeat('b',32),clock_timestamp()+interval '1 hour')`,
		ids["social_a"], ids["social_b"]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.native_fishing_sessions(owner_id,generation,connection_generation,state,ground_id,spot_id,rule_version,private_seed,loadout_rev,due_at)
 VALUES($1,1,1,'active','map','dock','test-v1',decode(repeat('ab',32),'hex'),1,clock_timestamp()+interval '1 hour')`, ids["social_b"]); err != nil {
		t.Fatal(err)
	}
	// A shared voyage zone owned by a: the durable model numbers the owner while
	// the legacy contract exposes the username.
	seed, err := assets.New(db.App).ApplyChange(ctx, assets.Change{
		ActorID: ids["social_a"], RequestKey: "sea-seed", Reason: "reward", RuleVersion: "test-v1", Coins: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.sea_zones(owner_id,id,data,expires_at,created_operation)
 VALUES($1,'zone1','{"name":"迷雾海域"}',clock_timestamp()+interval '1 hour',$2)`, ids["social_a"], seed.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.native_fishing_sessions(owner_id,generation,connection_generation,state,ground_id,spot_id,rule_version,private_seed,loadout_rev,due_at)
	VALUES($1,1,1,'active','sea:'||$2::bigint||':zone1','x','test-v1',decode(repeat('cd',32),'hex'),1,clock_timestamp()+interval '1 hour')`, ids["social_c"], ids["social_a"]); err != nil {
		t.Fatal(err)
	}

	post := func(path, body, actor string, want int, message string) map[string]any {
		t.Helper()
		code, payload := do("POST", path, body, tokens[actor])
		if code != want {
			t.Fatalf("%s: expected %d got %d: %v", path, want, code, payload)
		}
		if message != "" && payload["error"] != message {
			t.Fatalf("%s: expected error %q got %v", path, message, payload)
		}
		return payload
	}

	// Authentication is required everywhere in this domain.
	for _, path := range []string{"/api/friends/relations", "/api/friends", "/api/players/page"} {
		if code, body := do("GET", path, "", ""); code != 401 || body["error"] != "未登录" {
			t.Fatalf("anonymous %s: %d %v", path, code, body)
		}
	}
	if code, body := do("POST", "/api/friends", `{"target":"social_b","action":"request"}`, ""); code != 401 || body["error"] != "未登录" {
		t.Fatalf("anonymous friend change: %d %v", code, body)
	}
	if code, body := do("POST", "/api/players/rod", `{"target":"social_b"}`, ""); code != 401 || body["error"] != "未登录" {
		t.Fatalf("anonymous rod view: %d %v", code, body)
	}

	// Request / accept / remove with the original texts.
	post("/api/friends", `{"target":"social_b","action":"request"}`, "social_a", 200, "")
	post("/api/friends", `{"target":"social_b","action":"add"}`, "social_a", 200, "") // legacy alias
	post("/api/friends", `{"target":"social_a","action":"request"}`, "social_b", 400, "对方已向你发送好友请求，请在「好友请求」里同意")
	post("/api/friends", `{"target":"social_a","action":"request"}`, "social_a", 400, "不能添加自己为好友")
	post("/api/friends", `{"target":"nobody","action":"request"}`, "social_a", 404, "玩家不存在")
	post("/api/friends", `{"target":"social_b","action":"poke"}`, "social_a", 400, "未知好友操作")
	post("/api/friends", `{"target":"social_c","action":"request"}`, "social_a", 200, "")
	post("/api/friends", `{"target":"social_b","action":"reject"}`, "social_a", 400, "没有来自该玩家的好友请求")

	code, relations := do("GET", "/api/friends/relations", "", tokens["social_b"])
	if code != 200 {
		t.Fatalf("relations: %d %v", code, relations)
	}
	if in := relations["in"].([]any); len(in) != 1 || in[0] != "social_a" {
		t.Fatalf("incoming relations: %v", relations)
	}
	code, relations = do("GET", "/api/friends/relations", "", tokens["social_a"])
	if code != 200 {
		t.Fatalf("relations: %d %v", code, relations)
	}
	// Both invitations are still pending, so they are both outgoing requests.
	if out := relations["out"].([]any); len(out) != 2 || out[0] != "social_b" || out[1] != "social_c" {
		t.Fatalf("outgoing relations: %v", relations)
	}

	post("/api/friends", `{"target":"social_a","action":"accept"}`, "social_b", 200, "")
	post("/api/friends", `{"target":"social_a","action":"accept"}`, "social_c", 200, "")
	post("/api/friends", `{"target":"social_c","action":"cancel"}`, "social_a", 400, "没有待撤回的好友申请（可能已被对方处理）")

	// The friend list mixes online presence with the offline placeholder row.
	code, view := do("GET", "/api/friends?q=&page=1", "", tokens["social_a"])
	if code != 200 {
		t.Fatalf("friends view: %d %v", code, view)
	}
	friends := view["friends"].([]any)
	if len(friends) != 2 {
		t.Fatalf("friends list: %v", friends)
	}
	online := friends[0].(map[string]any)
	if online["online"] != true || online["id"] != "social_b" || online["status"] != "fishing" || online["locationName"] != "湖畔老码头" {
		t.Fatalf("online friend row: %v", online)
	}
	offline := friends[1].(map[string]any)
	if offline["online"] != false || offline["id"] != "social_c" || offline["status"] != "offline" || offline["locationName"] != "离线" {
		t.Fatalf("offline friend row: %v", offline)
	}
	// Only the stream-lease holders count as online, and the viewer never
	// appears in its own candidate list.
	if players := view["players"].([]any); len(players) != 1 {
		t.Fatalf("online candidates: %v", players)
	}
	for _, entry := range view["players"].([]any) {
		row := entry.(map[string]any)
		if row["id"] == "social_a" {
			t.Fatalf("self listed as candidate: %v", row)
		}
		if row["id"] == "social_b" && (row["friend"] != true || row["reqIn"] != false || row["reqOut"] != false) {
			t.Fatalf("friend flags: %v", row)
		}
	}
	if total := view["total"]; total != float64(1) {
		t.Fatalf("candidate total: %v", total)
	}

	// Player list pagination, search and location filters.
	code, page := do("GET", "/api/players/page?page=1&size=1", "", tokens["social_a"])
	if code != 200 {
		t.Fatalf("players page: %d %v", code, page)
	}
	if page["size"] != float64(5) || page["totalOnline"] != float64(2) {
		t.Fatalf("players page clamps: %v", page)
	}
	listed := page["players"].([]any)
	// The public player list includes the viewer, fishing status first.
	if len(listed) != 2 || listed[0].(map[string]any)["id"] != "social_b" {
		t.Fatalf("players page rows: %v", listed)
	}
	if code, body := do("GET", "/api/players/page?q=social_b", "", tokens["social_a"]); code != 200 || body["total"] != float64(1) {
		t.Fatalf("players search: %d %v", code, body)
	}
	if code, body := do("GET", "/api/players/page?ground=map&spot=dock", "", tokens["social_a"]); code != 200 || body["total"] != float64(1) {
		t.Fatalf("ground filter: %d %v", code, body)
	}
	if code, body := do("GET", "/api/players/page?ground=nowhere", "", tokens["social_a"]); code != 200 || body["total"] != float64(0) {
		t.Fatalf("unknown ground: %d %v", code, body)
	}
	// c is fishing inside a's shared voyage zone: the ground id keeps the legacy
	// username form and the zone name is projected.
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at)
 VALUES($1,repeat('c',32),clock_timestamp()+interval '1 hour')`, ids["social_c"]); err != nil {
		t.Fatal(err)
	}
	code, page = do("GET", "/api/players/page?q=social_c", "", tokens["social_a"])
	if code != 200 || page["total"] != float64(1) {
		t.Fatalf("shared zone row: %d %v", code, page)
	}
	zone := page["players"].([]any)[0].(map[string]any)
	if zone["groundId"] != "sea:social_a:zone1" || zone["locationName"] != "迷雾海域" {
		t.Fatalf("shared zone projection: %v", zone)
	}
	if code, body := do("GET", "/api/players/page?ground=sea:social_a:zone1", "", tokens["social_a"]); code != 200 || body["total"] != float64(1) {
		t.Fatalf("legacy sea ground filter: %d %v", code, body)
	}
	// Drop c's lease again: the rod view must reject offline targets.
	if _, err := db.Admin.Exec(ctx, `DELETE FROM fishing.gateway_streams WHERE owner_id=$1`, ids["social_c"]); err != nil {
		t.Fatal(err)
	}

	// The viewport registration is acknowledged without pretending to push.
	code, viewport := do("POST", "/api/players/view", `{"page":1,"size":30,"q":"","ground":null,"spot":null,"clear":false}`, tokens["social_a"])
	if code != 200 || viewport["ok"] != true || viewport["pushed"] != float64(0) {
		t.Fatalf("players view: %d %v", code, viewport)
	}

	// Read-only rod view of another online player.
	code, rod := do("POST", "/api/players/rod", `{"target":"social_b"}`, tokens["social_a"])
	if code != 200 || rod["ok"] != true || rod["name"] != "social_b" {
		t.Fatalf("players rod: %d %v", code, rod)
	}
	if _, ok := rod["bd"].(map[string]any); !ok {
		t.Fatalf("players rod bd: %v", rod)
	}
	if code, body := do("POST", "/api/players/rod", `{"target":"social_c"}`, tokens["social_a"]); code != 400 || body["error"] != "对方不在线" {
		t.Fatalf("offline rod view: %d %v", code, body)
	}
	if code, body := do("POST", "/api/players/rod", `{"target":"nobody"}`, tokens["social_a"]); code != 404 || body["error"] != "玩家不存在" {
		t.Fatalf("missing rod view: %d %v", code, body)
	}

	// Removing a friend clears both sides.
	post("/api/friends", `{"target":"social_b","action":"remove"}`, "social_a", 200, "")
	code, relations = do("GET", "/api/friends/relations", "", tokens["social_b"])
	if code != 200 || len(relations["friends"].([]any)) != 0 {
		t.Fatalf("relations after remove: %d %v", code, relations)
	}
}
