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
	"fishing.local/server/internal/testdb"
)

type notifyFixture struct {
	t      *testing.T
	db     testdb.DB
	server *httptest.Server
	token  string
	id     int64
}

func newNotifyFixture(t *testing.T) *notifyFixture {
	t.Helper()
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	t.Cleanup(server.Close)
	f := &notifyFixture{t: t, db: db, server: server}
	code, body := f.do("POST", "/api/register", `{"username":"notify_user","password":"Synthetic-Pass42","qq":"123456","name":"通知测试"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, body)
	}
	token, _ := body["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}
	f.token, f.id = token, session.AccountID
	return f
}

func (f *notifyFixture) do(method, path, body, token string) (int, map[string]any) {
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
	res, err := f.server.Client().Do(request)
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

func (f *notifyFixture) authed(method, path, body string) (int, map[string]any) {
	f.t.Helper()
	return f.do(method, path, body, f.token)
}

func (f *notifyFixture) expect(code int, body map[string]any, want int, message string) {
	f.t.Helper()
	if code != want {
		f.t.Fatalf("expected %d, got %d: %v", want, code, body)
	}
	if message != "" && body["error"] != message {
		f.t.Fatalf("expected error %q, got %v", message, body)
	}
}

// expectAuthed and expectDo keep the call sites readable; Go cannot pass the
// two-value response into expect directly.
func (f *notifyFixture) expectAuthed(method, path, body string, want int, message string) {
	f.t.Helper()
	code, value := f.authed(method, path, body)
	f.expect(code, value, want, message)
}

func (f *notifyFixture) expectDo(method, path, body, token string, want int, message string) {
	f.t.Helper()
	code, value := f.do(method, path, body, token)
	f.expect(code, value, want, message)
}

func (f *notifyFixture) fund(coins int64) {
	f.t.Helper()
	if _, err := assets.New(f.db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: f.id, RequestKey: "notify-fund", Reason: "reward", RuleVersion: "test-v1", Coins: coins,
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *notifyFixture) coins() int64 {
	f.t.Helper()
	var coins int64
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.id).Scan(&coins); err != nil {
		f.t.Fatal(err)
	}
	return coins
}

func TestIntegrationLegacySubscribe(t *testing.T) {
	f := newNotifyFixture(t)
	f.expectDo("GET", "/api/subscribe", "", "", 401, "invalid_credentials")

	code, body := f.authed("GET", "/api/subscribe", "")
	f.expect(code, body, 200, "")
	if body["ok"] != true {
		t.Fatalf("subscribe read: %v", body)
	}
	catalog, _ := body["catalog"].(map[string]any)
	bases, _ := catalog["bases"].([]any)
	if len(bases) == 0 {
		t.Fatalf("subscribe catalog: %v", body)
	}
	first, _ := bases[0].(map[string]any)
	if first["id"] == nil || first["name"] == nil || first["part"] == nil {
		t.Fatalf("subscribe base projection: %v", first)
	}
	if _, ok := catalog["qualities"].(map[string]any)["common"]; !ok {
		t.Fatalf("subscribe qualities: %v", catalog["qualities"])
	}
	if _, ok := catalog["affixes"].(map[string]any)["speed"]; !ok {
		t.Fatalf("subscribe affixes: %v", catalog["affixes"])
	}
	// A fresh account has no stored configuration.
	if cfg, _ := body["cfg"].(map[string]any); len(cfg) != 0 {
		t.Fatalf("fresh subscribe cfg: %v", cfg)
	}

	// Validation keeps the original Chinese rejections.
	f.expectAuthed("POST", "/api/subscribe", `{"on":true,"baseId":"nope"}`, 400, "未知的底材")
	f.expectAuthed("POST", "/api/subscribe", `{"on":true,"quality":"legendary"}`, 400, "未知的品质")
	f.expectAuthed("POST", "/api/subscribe", `{"on":true,"affixType":"luck"}`, 400, "未知的词条类型")
	f.expectAuthed("POST", "/api/subscribe", `{"on":true,"min":"abc"}`, 400, "数值范围需为数字")
	f.expectAuthed("POST", "/api/subscribe", `{"on":true,"min":9,"max":1}`, 400, "最小值不能大于最大值")

	code, saved := f.authed("POST", "/api/subscribe", `{"on":true,"baseId":"rod_bamboo","quality":"rare","affixType":"speed","min":"8.4","max":14,"blink":false}`)
	f.expect(code, saved, 200, "")
	cfg, _ := saved["cfg"].(map[string]any)
	if cfg["on"] != true || cfg["baseId"] != "rod_bamboo" || cfg["quality"] != "rare" || cfg["affixType"] != "speed" {
		t.Fatalf("subscribe cfg: %v", cfg)
	}
	// Strings are rounded like the original optNum, and an omitted flag keeps its
	// default while an explicit false survives.
	if cfg["min"] != float64(8) || cfg["max"] != float64(14) {
		t.Fatalf("subscribe range: %v", cfg)
	}
	if cfg["badge"] != true || cfg["blink"] != false {
		t.Fatalf("subscribe flags: %v", cfg)
	}
	code, reread := f.authed("GET", "/api/subscribe", "")
	f.expect(code, reread, 200, "")
	stored, _ := reread["cfg"].(map[string]any)
	if stored["baseId"] != "rod_bamboo" || stored["min"] != float64(8) {
		t.Fatalf("stored cfg: %v", stored)
	}
}

func TestIntegrationLegacyFeedback(t *testing.T) {
	f := newNotifyFixture(t)
	f.expectDo("GET", "/api/feedback", "", "", 401, "invalid_credentials")

	code, body := f.authed("GET", "/api/feedback", "")
	f.expect(code, body, 200, "")
	status, _ := body["status"].(map[string]any)
	if status["ready"] != true || status["remainingMs"] != float64(0) || status["skipCost"] != float64(10000) {
		t.Fatalf("initial feedback status: %v", body)
	}
	if mine, _ := body["mine"].([]any); len(mine) != 0 {
		t.Fatalf("fresh feedback history: %v", mine)
	}

	f.expectAuthed("POST", "/api/feedback/submit", `{"text":"   "}`, 400, "反馈内容不能为空")

	code, submitted := f.authed("POST", "/api/feedback/submit", `{"text":"合成数据反馈","kind":"bug"}`)
	f.expect(code, submitted, 200, "")
	entry, _ := submitted["entry"].(map[string]any)
	if entry["text"] != "合成数据反馈" || entry["kind"] != "bug" || entry["status"] != "submitted" || entry["key"] != "notify_user" {
		t.Fatalf("submitted entry: %v", entry)
	}
	if entry["id"] == nil || entry["t"] == nil {
		t.Fatalf("submitted identity: %v", entry)
	}
	after, _ := submitted["status"].(map[string]any)
	if after["ready"] != false {
		t.Fatalf("feedback status after submit: %v", after)
	}
	// The cooldown reply carries the original Chinese text and the remaining time.
	code, blocked := f.authed("POST", "/api/feedback/submit", `{"text":"再来一条"}`)
	f.expect(code, blocked, 429, "")
	message, _ := blocked["error"].(string)
	if !strings.Contains(message, "冷却中，") || !strings.Contains(message, "10000 金币") {
		t.Fatalf("cooldown message: %v", blocked)
	}
	code, history := f.authed("GET", "/api/feedback", "")
	f.expect(code, history, 200, "")
	if mine, _ := history["mine"].([]any); len(mine) != 1 {
		t.Fatalf("feedback history: %v", history)
	}

	// Skipping the cooldown costs coins; the balance guard reuses the legacy text.
	f.expectAuthed("POST", "/api/feedback/skip", `{}`, 400, "金币不足（需 10000）")
	// Registration already granted the synthetic account 500 coins.
	granted := f.coins()
	if granted != 500 {
		t.Fatalf("registration grant: %d", granted)
	}
	f.fund(10000)
	code, skipped := f.authed("POST", "/api/feedback/skip", `{}`)
	f.expect(code, skipped, 200, "")
	if skipped["ok"] != true || skipped["coins"] != float64(granted) {
		t.Fatalf("skip reply: %v", skipped)
	}
	if f.coins() != granted {
		t.Fatalf("coins after skip: %d", f.coins())
	}
	status, _ = skipped["status"].(map[string]any)
	if status["ready"] != true {
		t.Fatalf("status after skip: %v", status)
	}
	// The cooldown is gone, so skipping again is rejected with the original text.
	f.expectAuthed("POST", "/api/feedback/skip", `{}`, 400, "当前不在冷却中，无需跳过")
	// A third submit is possible now that the cooldown was cleared.
	code, again := f.authed("POST", "/api/feedback/submit", `{"text":"第二条"}`)
	f.expect(code, again, 200, "")
}
