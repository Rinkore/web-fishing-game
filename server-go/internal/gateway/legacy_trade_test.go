package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

// legacyTradeFixture registers players, gives them inventory and opens the
// presence leases the durable trade module requires.
type legacyTradeFixture struct {
	t      *testing.T
	db     testdb.DB
	ctx    context.Context
	server *httptest.Server
	client *http.Client
	token  map[string]string
	id     map[string]int64
}

func newLegacyTradeFixture(t *testing.T) *legacyTradeFixture {
	t.Helper()
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	t.Cleanup(server.Close)
	f := &legacyTradeFixture{t: t, db: db, ctx: context.Background(), server: server, client: server.Client(), token: map[string]string{}, id: map[string]int64{}}
	for _, name := range []string{"trade_a", "trade_b", "trade_c"} {
		code, body := f.do("POST", "/api/register", `{"username":"`+name+`","password":"Synthetic-Pass42","qq":"123456","name":"`+name+`"}`, "")
		if code != 200 {
			t.Fatalf("register %s: %d %v", name, code, body)
		}
		token, _ := body["token"].(string)
		session, err := identity.New(db.App, nil).Authenticate(f.ctx, token, false)
		if err != nil {
			t.Fatal(err)
		}
		f.token[name], f.id[name] = token, session.AccountID
	}
	return f
}

func (f *legacyTradeFixture) do(method, path, body, token string) (int, map[string]any) {
	f.t.Helper()
	request, err := http.NewRequest(method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	if method == "POST" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := f.client.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	var value map[string]any
	if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
		f.t.Fatal(err)
	}
	return res.StatusCode, value
}

func (f *legacyTradeFixture) post(path, body, actor string) (int, map[string]any) {
	f.t.Helper()
	return f.do("POST", path, body, f.token[actor])
}

func (f *legacyTradeFixture) expect(code int, body map[string]any, want int, message string) bool {
	f.t.Helper()
	if code != want {
		f.t.Fatalf("expected %d, got %d: %v", want, code, body)
	}
	if message != "" && body["error"] != message {
		f.t.Fatalf("expected error %q, got %v", message, body)
	}
	return true
}

func (f *legacyTradeFixture) expectPost(path, body, actor string, want int, message string) {
	f.t.Helper()
	code, payload := f.post(path, body, actor)
	f.expect(code, payload, want, message)
}

func (f *legacyTradeFixture) seed() {
	f.t.Helper()
	// Legacy presence is a live stream lease in both tables: the bridge checks
	// gateway_streams while the durable module checks fishing_connections.
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at) VALUES($1,repeat('a',32),clock_timestamp()+interval '1 hour'),($2,repeat('b',32),clock_timestamp()+interval '1 hour') ON CONFLICT(owner_id,stream_id) DO UPDATE SET expires_at=excluded.expires_at`, f.id["trade_a"], f.id["trade_b"]); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.fishing_connections(owner_id,generation,expires_at) VALUES($1,1,clock_timestamp()+interval '1 hour'),($2,1,clock_timestamp()+interval '1 hour')`, f.id["trade_a"], f.id["trade_b"]); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES('crucian','fish',NULL),('rope','material',NULL),('rod_bamboo','equipment','rod') ON CONFLICT DO NOTHING`); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'crucian','fish','normal',10),($1,'rope','material','normal',1),($2,'crucian','fish','normal',3),($2,'rope','material','normal',4)`, f.id["trade_a"], f.id["trade_b"]); err != nil {
		f.t.Fatal(err)
	}
	// Equipment rows need a real command: asset_operations carries a composite
	// foreign key to command_results, so a bare INSERT cannot seed one.
	attrs, _ := json.Marshal(map[string]any{"signature": "rod_bamboo#common#"})
	if _, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{
		ActorID: f.id["trade_b"], RequestKey: "trade-seed", Reason: "reward", RuleVersion: "test-v1",
		Create: []assets.EquipmentSpec{{DefinitionID: "rod_bamboo", Part: "rod", Attributes: attrs}},
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *legacyTradeFixture) quantity(owner int64, item string, tier string) int64 {
	f.t.Helper()
	var quantity int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT COALESCE(SUM(quantity),0) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier=$3`, owner, item, tier).Scan(&quantity); err != nil {
		f.t.Fatal(err)
	}
	return quantity
}

func (f *legacyTradeFixture) state(id string) string {
	f.t.Helper()
	var state string
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT state FROM fishing.trades WHERE id=$1`, strings.TrimPrefix(id, "T")).Scan(&state); err != nil {
		f.t.Fatal(err)
	}
	return state
}

func TestIntegrationLegacyTrade(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()

	// Invitation preconditions keep the original Chinese text.
	f.expectPost("/api/trade/invite", `{"target":"nobody"}`, "trade_a", 404, "对方不存在")
	f.expectPost("/api/trade/invite", `{"target":"trade_a"}`, "trade_a", 400, "不能与自己交易")
	f.expectPost("/api/trade/invite", `{"target":"trade_c"}`, "trade_a", 400, "对方不在线")

	code, invited := f.post("/api/trade/invite", `{"target":"TRADE_B"}`, "trade_a")
	if code != 200 || invited["ok"] != true {
		t.Fatalf("invite: %d %v", code, invited)
	}
	tradeID, _ := invited["tradeId"].(string)
	if !strings.HasPrefix(tradeID, "T") {
		t.Fatalf("trade handle: %v", invited)
	}
	f.expectPost("/api/trade/invite", `{"target":"trade_b"}`, "trade_a", 409, "已有进行中的交易")
	if state := f.state(tradeID); state != "invited" {
		t.Fatalf("state after invite: %s", state)
	}
	// A third player is neither participant nor owner.
	f.expectPost("/api/trade/cancel", `{"tradeId":"`+tradeID+`"}`, "trade_c", 403, "无权操作")
	f.expectPost("/api/trade/confirm", `{"tradeId":"T99999"}`, "trade_a", 404, "交易不存在")

	// Offers are rejected before the invitation is accepted, and an empty
	// offer list is a valid way to take an item back.
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"crucian","qty":1}]}`, "trade_a", 400, "对方尚未接受邀请")
	f.expectPost("/api/trade/respond", `{"tradeId":"`+tradeID+`","accept":true}`, "trade_b", 200, "")
	if state := f.state(tradeID); state != "accepted" {
		t.Fatalf("state after accept: %s", state)
	}

	// Rejected offers reuse the legacy validation text.
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"crucian","qty":99}]}`, "trade_a", 400, "你没有足够的 鲫鱼")
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"rodset:rod=rod_bamboo#common#","qty":1}]}`, "trade_a", 400, "交易物品非法或重复")
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"crucian","qty":1},{"id":"crucian","qty":1}]}`, "trade_a", 400, "交易物品非法或重复")
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"rope","qty":0}]}`, "trade_a", 400, "交易物品非法或重复")

	code, offered := f.post("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"crucian","qty":2}]}`, "trade_a")
	if code != 200 || offered["ok"] != true {
		t.Fatalf("set a: %d %v", code, offered)
	}
	// Components move as free instances keyed by signature, like the original
	// inventory map.
	code, offered = f.post("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"rope","qty":3},{"id":"rod_bamboo#common#","qty":1}]}`, "trade_b")
	if code != 200 || offered["ok"] != true {
		t.Fatalf("set b: %d %v", code, offered)
	}

	code, confirmed := f.post("/api/trade/confirm", `{"tradeId":"`+tradeID+`"}`, "trade_a")
	if code != 200 || confirmed["ok"] != true || confirmed["done"] != nil {
		t.Fatalf("confirm a: %d %v", code, confirmed)
	}
	code, settled := f.post("/api/trade/confirm", `{"tradeId":"`+tradeID+`"}`, "trade_b")
	if code != 200 || settled["ok"] != true || settled["done"] != true {
		t.Fatalf("confirm b: %d %v", code, settled)
	}
	if state := f.state(tradeID); state != "done" {
		t.Fatalf("state after settlement: %s", state)
	}
	if got := f.quantity(f.id["trade_a"], "crucian", "normal"); got != 8 {
		t.Fatalf("a crucian: %d", got)
	}
	if got := f.quantity(f.id["trade_a"], "rope", "normal"); got != 4 {
		t.Fatalf("a rope: %d", got)
	}
	if got := f.quantity(f.id["trade_b"], "crucian", "normal"); got != 5 {
		t.Fatalf("b crucian: %d", got)
	}
	if got := f.quantity(f.id["trade_b"], "rope", "normal"); got != 1 {
		t.Fatalf("b rope: %d", got)
	}
	var owner int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT owner_id FROM fishing.equipment_instances WHERE attributes->>'signature'='rod_bamboo#common#'`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != f.id["trade_a"] {
		t.Fatalf("component owner: %d", owner)
	}
	// A settled trade disappears for the legacy contract, so the pair may start
	// a new one immediately.
	f.expectPost("/api/trade/confirm", `{"tradeId":"`+tradeID+`"}`, "trade_a", 404, "交易不存在")

	code, invited = f.post("/api/trade/invite", `{"target":"trade_b"}`, "trade_a")
	if code != 200 {
		t.Fatalf("re-invite: %d %v", code, invited)
	}
	second, _ := invited["tradeId"].(string)
	// Declining closes the session without moving any asset.
	code, declined := f.post("/api/trade/respond", `{"tradeId":"`+second+`","accept":false}`, "trade_b")
	if code != 200 || declined["closed"] != true {
		t.Fatalf("decline: %d %v", code, declined)
	}
	if state := f.state(second); state != "cancelled" {
		t.Fatalf("state after decline: %s", state)
	}

	// A second trade can be cancelled by either participant.
	code, invited = f.post("/api/trade/invite", `{"target":"trade_b"}`, "trade_a")
	if code != 200 {
		t.Fatalf("third invite: %d %v", code, invited)
	}
	third, _ := invited["tradeId"].(string)
	f.expectPost("/api/trade/respond", `{"tradeId":"`+third+`","accept":true}`, "trade_b", 200, "")
	code, cancelled := f.post("/api/trade/cancel", `{"tradeId":"`+third+`"}`, "trade_b")
	if code != 200 || cancelled["ok"] != true {
		t.Fatalf("cancel: %d %v", code, cancelled)
	}
	if state := f.state(third); state != "cancelled" {
		t.Fatalf("state after cancel: %s", state)
	}
}

// legacyTradeFeed reads one legacy SSE connection and exposes the decoded
// events by type.
type legacyTradeFeed struct {
	events chan map[string]any
	cancel context.CancelFunc
}

func openLegacyTradeStream(t *testing.T, f *legacyTradeFixture, actor string) *legacyTradeFeed {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, "GET", f.server.URL+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+f.token[actor])
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("stream status: %d", response.StatusCode)
	}
	stream := &legacyTradeFeed{events: make(chan map[string]any, 128), cancel: cancel}
	go func() {
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var payload map[string]any
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &payload) != nil {
				continue
			}
			select {
			case stream.events <- payload:
			default:
			}
		}
	}()
	return stream
}

// wait returns the next event of the given type, ignoring the others.
func (s *legacyTradeFeed) wait(t *testing.T, kind string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case event := <-s.events:
			if event["type"] == kind {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", kind)
			return nil
		}
	}
}

// waitView returns the first trade projection that satisfies check. A burst of
// changes (offer plus counter-offer) can deliver several views in a row.
func (s *legacyTradeFeed) waitView(t *testing.T, check func(map[string]any) bool, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case event := <-s.events:
			if event["type"] != "trade" {
				continue
			}
			if view := tradeView(t, event); check(view) {
				return view
			}
		case <-deadline:
			t.Fatal("timed out waiting for trade projection")
			return nil
		}
	}
}

func tradeView(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	view, ok := event["trade"].(map[string]any)
	if !ok {
		t.Fatalf("trade payload: %v", event)
	}
	return view
}

func TestIntegrationLegacyTradeStream(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	// The stream itself opens and renews the presence lease.
	// One statement per Exec: pgx prepares the statement server-side, so a
	// multi-statement string with parameters is rejected.
	if _, err := f.db.Admin.Exec(f.ctx, `DELETE FROM fishing.fishing_connections WHERE owner_id IN ($1,$2)`, f.id["trade_a"], f.id["trade_b"]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DELETE FROM fishing.gateway_streams WHERE owner_id IN ($1,$2)`, f.id["trade_a"], f.id["trade_b"]); err != nil {
		t.Fatal(err)
	}
	streamA := openLegacyTradeStream(t, f, "trade_a")
	defer streamA.cancel()
	streamB := openLegacyTradeStream(t, f, "trade_b")
	defer streamB.cancel()

	// init carries no trade until one exists.
	if init := streamA.wait(t, "init", 10*time.Second); init["trade"] != nil {
		t.Fatalf("init trade: %v", init["trade"])
	}
	// Both streams must be fully initialised before the invitation. A stream
	// whose init is still in flight receives the trade inside init.trade and
	// correctly emits no separate trade frame, which would race this wait.
	if init := streamB.wait(t, "init", 10*time.Second); init["trade"] != nil {
		t.Fatalf("init trade: %v", init["trade"])
	}
	// Wait until both leases exist, otherwise the invite is rejected as offline.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var leases int
		if err := f.db.Admin.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM fishing.fishing_connections WHERE owner_id IN ($1,$2) AND expires_at>clock_timestamp()) + (SELECT count(*) FROM fishing.gateway_streams WHERE owner_id IN ($1,$2) AND expires_at>clock_timestamp())`, f.id["trade_a"], f.id["trade_b"]).Scan(&leases); err != nil {
			t.Fatal(err)
		}
		if leases == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream leases were not created")
		}
		time.Sleep(50 * time.Millisecond)
	}

	code, invited := f.post("/api/trade/invite", `{"target":"trade_b"}`, "trade_a")
	if code != 200 {
		t.Fatalf("invite: %d %v", code, invited)
	}
	tradeID, _ := invited["tradeId"].(string)
	for name, stream := range map[string]*legacyTradeFeed{"trade_a": streamA, "trade_b": streamB} {
		view := stream.waitView(t, func(view map[string]any) bool { return view["id"] == tradeID }, 10*time.Second)
		if view["id"] != tradeID || view["accepted"] != false || view["cancelled"] != false {
			t.Fatalf("%s invite view: %v", name, view)
		}
		a, _ := view["a"].(map[string]any)
		b, _ := view["b"].(map[string]any)
		if a["key"] != "trade_a" || a["name"] != "trade_a" || b["key"] != "trade_b" {
			t.Fatalf("%s party projection: %v", name, view)
		}
	}

	f.expectPost("/api/trade/respond", `{"tradeId":"`+tradeID+`","accept":true}`, "trade_b", 200, "")
	view := streamB.waitView(t, func(view map[string]any) bool { return view["accepted"] == true }, 10*time.Second)
	if view["accepted"] != true {
		t.Fatalf("accepted view: %v", view)
	}
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"crucian","qty":2}]}`, "trade_a", 200, "")
	f.expectPost("/api/trade/set", `{"tradeId":"`+tradeID+`","items":[{"id":"rope","qty":3},{"id":"rod_bamboo#common#","qty":1}]}`, "trade_b", 200, "")
	view = streamB.waitView(t, func(view map[string]any) bool {
		aItems, _ := view["aItems"].([]any)
		bItems, _ := view["bItems"].([]any)
		return len(aItems) == 1 && len(bItems) == 2
	}, 10*time.Second)
	aItems, _ := view["aItems"].([]any)
	bItems, _ := view["bItems"].([]any)
	if len(aItems) != 1 || len(bItems) != 2 {
		t.Fatalf("offer projection: %v", view)
	}
	first, _ := aItems[0].(map[string]any)
	if first["id"] != "crucian" || first["qty"] != float64(2) {
		t.Fatalf("offer item: %v", first)
	}

	f.expectPost("/api/trade/confirm", `{"tradeId":"`+tradeID+`"}`, "trade_a", 200, "")
	confirmed := streamA.waitView(t, func(view map[string]any) bool { return view["aOk"] == true }, 10*time.Second)
	if confirmed["aOk"] != true || confirmed["bOk"] != false {
		t.Fatalf("confirmation projection: %v", confirmed)
	}
	f.expectPost("/api/trade/confirm", `{"tradeId":"`+tradeID+`"}`, "trade_b", 200, "")
	done := streamA.waitView(t, func(view map[string]any) bool { return view["done"] == true }, 10*time.Second)
	if done["done"] != true {
		t.Fatalf("settled view: %v", done)
	}
	settlement := streamA.wait(t, "tradeDone", 10*time.Second)
	if settlement["tradeId"] != tradeID || settlement["aName"] != "trade_a" || settlement["bName"] != "trade_b" {
		t.Fatalf("settlement identity: %v", settlement)
	}
	aSide, _ := settlement["a"].(map[string]any)
	bSide, _ := settlement["b"].(map[string]any)
	if aSide["key"] != "trade_a" || bSide["key"] != "trade_b" || aSide["invRev"] == nil || bSide["coins"] == nil {
		t.Fatalf("settlement sides: %v", settlement)
	}
	inventory, _ := aSide["inventory"].(map[string]any)
	if inventory["crucian"] != float64(8) || inventory["rod_bamboo#common#"] != float64(1) {
		t.Fatalf("settlement inventory: %v", inventory)
	}
	if _, ok := bSide["inventory"].(map[string]any)["rope"]; !ok {
		t.Fatalf("settlement inventory b: %v", bSide)
	}
	// The durable stream lease is renewed while the connection stays open: the
	// original frontend never heartbeats the game API itself.
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()+interval '1 second' WHERE owner_id=$1`, f.id["trade_a"]); err != nil {
		t.Fatal(err)
	}
	// The stream renews its lease on a 10s tick, so allow two ticks.
	deadline = time.Now().Add(25 * time.Second)
	for {
		var fresh bool
		if err := f.db.Admin.QueryRow(f.ctx, `SELECT expires_at>clock_timestamp()+interval '10 seconds' FROM fishing.fishing_connections WHERE owner_id=$1`, f.id["trade_a"]).Scan(&fresh); err != nil {
			t.Fatal(err)
		}
		if fresh {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream lease was not renewed")
		}
		time.Sleep(200 * time.Millisecond)
	}
}
