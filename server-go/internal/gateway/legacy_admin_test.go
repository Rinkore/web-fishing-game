package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

// The console tests use an administrator session created directly in the
// fixture database. That is deliberate: the MFA login path has its own coverage
// in the identity package, and the console only needs a valid admin-realm
// session.
type adminFixture struct {
	t           *testing.T
	db          testdb.DB
	server      *httptest.Server
	adminToken  string
	adminKey    string
	playerToken string
	playerKey   string
	playerID    int64
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	t.Cleanup(server.Close)
	f := &adminFixture{t: t, db: db, server: server, adminKey: "console_admin", playerKey: "console_target"}
	f.playerToken, f.playerID = f.register(f.playerKey, "目标玩家")
	f.register(f.adminKey, "后台管理员")
	f.adminToken = f.adminSession(f.adminKey)
	return f
}

func (f *adminFixture) register(username, name string) (string, int64) {
	f.t.Helper()
	code, body := f.call("POST", "/api/register",
		`{"username":"`+username+`","password":"Synthetic-Pass42","qq":"123456","name":"`+name+`"}`, "")
	if code != 200 {
		f.t.Fatalf("register %s: %d %v", username, code, body)
	}
	token, _ := body["token"].(string)
	session, err := identity.New(f.db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		f.t.Fatal(err)
	}
	return token, session.AccountID
}

// adminSession grants the account the administrator flag and mints an
// administrator session token for it.
func (f *adminFixture) adminSession(username string) string {
	f.t.Helper()
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.identities SET admin=true WHERE username=$1`, username); err != nil {
		f.t.Fatal(err)
	}
	var id int64
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT account_id FROM fishing.identities WHERE username=$1`, username).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		f.t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(token))
	if _, err := f.db.Admin.Exec(context.Background(), `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at)
 VALUES($1,$2,true,clock_timestamp()+interval '1 hour')`, digest[:], id); err != nil {
		f.t.Fatal(err)
	}
	return token
}

func (f *adminFixture) call(method, path, body, token string) (int, map[string]any) {
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

func (f *adminFixture) admin(method, path, body string) (int, map[string]any) {
	f.t.Helper()
	return f.call(method, path, body, f.adminToken)
}

func (f *adminFixture) player(method, path, body string) (int, map[string]any) {
	f.t.Helper()
	return f.call(method, path, body, f.playerToken)
}

func (f *adminFixture) expect(code int, body map[string]any, want int, message string) {
	f.t.Helper()
	if code != want {
		f.t.Fatalf("expected %d, got %d: %v", want, code, body)
	}
	if message != "" && body["error"] != message {
		f.t.Fatalf("expected error %q, got %v", message, body)
	}
}

func (f *adminFixture) coins(id int64) int64 {
	f.t.Helper()
	var coins int64
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, id).Scan(&coins); err != nil {
		f.t.Fatal(err)
	}
	return coins
}

func (f *adminFixture) userEntry(key string) map[string]any {
	f.t.Helper()
	code, body := f.admin("GET", "/api/admin/users", "")
	if code != 200 {
		f.t.Fatalf("users: %d %v", code, body)
	}
	for _, raw := range body["users"].([]any) {
		entry := raw.(map[string]any)
		if entry["key"] == key {
			return entry
		}
	}
	return nil
}

func (f *adminFixture) auditLog() []any {
	f.t.Helper()
	code, body := f.admin("GET", "/api/admin/security", "")
	if code != 200 {
		f.t.Fatalf("security: %d %v", code, body)
	}
	return body["log"].([]any)
}

// TestIntegrationLegacyAdminConsoleReads covers the read-only surface: only an
// administrator session may read it, and the projections must match the legacy
// console contract.
func TestIntegrationLegacyAdminConsoleReads(t *testing.T) {
	f := newAdminFixture(t)
	for _, path := range []string{"/api/admin/overview", "/api/admin/stats", "/api/admin/netstats", "/api/admin/security", "/api/admin/users", "/api/admin/feedback", "/api/admin/registration/stats"} {
		if code, _ := f.call("GET", path, "", ""); code != 401 {
			t.Fatalf("%s without a session: %d", path, code)
		}
		if code, _ := f.call("GET", path, "", f.playerToken); code != 401 {
			t.Fatalf("%s with a player session: %d", path, code)
		}
	}

	code, overview := f.admin("GET", "/api/admin/overview", "")
	f.expect(code, overview, 200, "")
	if overview["ok"] != true || overview["userCount"].(float64) < 2 {
		t.Fatalf("overview counts: %v", overview)
	}
	if overview["notifyLevel"] != "all" || overview["biteFormula"] == "" {
		t.Fatalf("overview configuration: %v", overview)
	}
	if overview["groundCount"].(float64) < 1 || overview["spotCount"].(float64) < 1 {
		t.Fatalf("overview catalog: %v", overview)
	}

	code, report := f.admin("GET", "/api/admin/stats?range=1h", "")
	f.expect(code, report, 200, "")
	if report["range"] != "1h" || report["step"].(float64) != 60000 {
		t.Fatalf("stats range: %v", report["range"])
	}
	heat := report["heat"].([]any)
	if len(heat) != 7 || len(heat[0].([]any)) != 24 {
		t.Fatalf("heat grid shape: %v", heat)
	}
	if len(report["points"].([]any)) == 0 {
		t.Fatal("stats must always end at the live point")
	}
	live := report["live"].(map[string]any)
	if live["users"].(float64) < 2 {
		t.Fatalf("live projection: %v", live)
	}
	if len(report["grounds"].([]any)) == 0 {
		t.Fatal("stats must expose the filter catalog")
	}

	code, netstats := f.admin("GET", "/api/admin/netstats", "")
	f.expect(code, netstats, 200, "")
	if netstats["apiReqs"].(float64) < 1 || netstats["apiBytes"].(float64) < 1 {
		t.Fatalf("netstats counters: %v", netstats)
	}

	code, registration := f.admin("GET", "/api/admin/registration/stats", "")
	f.expect(code, registration, 200, "")
	counters := registration["counters"].(map[string]any)
	if counters["attempts"].(float64) < 2 || counters["created"].(float64) < 2 {
		t.Fatalf("registration counters: %v", counters)
	}
	if registration["limits"].(map[string]any)["globalHourly"].(float64) != 200 {
		t.Fatalf("registration limits: %v", registration["limits"])
	}

	code, users := f.admin("GET", "/api/admin/users", "")
	f.expect(code, users, 200, "")
	if users["me"] != f.adminKey {
		t.Fatalf("users me field: %v", users["me"])
	}
	entry := f.userEntry(f.playerKey)
	if entry == nil {
		t.Fatal("users list is missing the registered player")
	}
	if entry["coins"].(float64) != 500 || entry["banned"] != false || entry["capSet"] != false {
		t.Fatalf("user projection: %v", entry)
	}
	if entry["listingCap"].(float64) != float64(legacyListingCapDefault) {
		t.Fatalf("listing capacity default: %v", entry)
	}
	if entry["createdAt"].(float64) <= 0 {
		t.Fatalf("registration timestamp: %v", entry)
	}
}

// TestIntegrationLegacyAdminAccountManagement covers edit, ban and unban with
// expiry, the administrator flag and retirement.
func TestIntegrationLegacyAdminAccountManagement(t *testing.T) {
	f := newAdminFixture(t)
	target := f.playerKey

	code, body := f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`"}`)
	f.expect(code, body, 400, "没有需要修改的字段")
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`","password":"short"}`)
	f.expect(code, body, 400, "新密码需为 12～256 位")
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`","password":"123456789012"}`)
	f.expect(code, body, 400, "请勿使用常见弱密码")
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"ghost","coins":10}`)
	f.expect(code, body, 404, "账号不存在")
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`","coins":-5}`)
	f.expect(code, body, 400, "金币数无效")
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`","listingCap":1000000}`)
	f.expect(code, body, 400, "挂单上限无效（0 = 不限，最大 10000）")

	code, body = f.admin("POST", "/api/admin/users/update",
		`{"target":"`+target+`","coins":1234,"listingCap":0,"name":"新名字"}`)
	f.expect(code, body, 200, "")
	if body["coins"].(float64) != 1234 || body["listingCap"].(float64) != 0 || body["name"] != "新名字" {
		t.Fatalf("update projection: %v", body)
	}
	if len(body["changed"].([]any)) != 3 {
		t.Fatalf("changed list: %v", body["changed"])
	}
	if f.coins(f.playerID) != 1234 {
		t.Fatal("wallet did not follow the console edit")
	}
	entry := f.userEntry(target)
	if entry["name"] != "新名字" || entry["coins"].(float64) != 1234 || entry["listingCap"].(float64) != 0 {
		t.Fatalf("user list projection: %v", entry)
	}

	// Changing the password invalidates every existing session of the target.
	code, body = f.admin("POST", "/api/admin/users/update", `{"target":"`+target+`","password":"Synthetic-New-Pass42"}`)
	f.expect(code, body, 200, "")
	if code, _ := f.player("GET", "/api/me", ""); code != 401 {
		t.Fatal("password change must invalidate the player session")
	}
	code, login := f.call("POST", "/api/login", `{"username":"`+target+`","password":"Synthetic-New-Pass42"}`, "")
	if code != 200 {
		t.Fatalf("new password rejected: %d %v", code, login)
	}
	if token, _ := login["token"].(string); token != "" {
		f.playerToken = token
	}

	// Ban: second confirmation, self-protection, size limit and the outcome.
	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+target+`","hours":24}`)
	f.expect(code, body, 400, "需要二次确认")
	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+f.adminKey+`","hours":24,"confirm":true}`)
	f.expect(code, body, 400, "不能封禁自己的账号")
	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+target+`","hours":90000,"confirm":true}`)
	f.expect(code, body, 400, "封禁时长过大（上限 3650 天）")
	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+target+`","hours":24,"reason":"压测","confirm":true}`)
	f.expect(code, body, 200, "")
	if body["banned"] != true || body["permanent"] != false || body["reason"] != "压测" {
		t.Fatalf("ban projection: %v", body)
	}
	if body["remainMs"].(float64) <= 0 {
		t.Fatalf("ban deadline: %v", body)
	}
	if code, _ := f.player("GET", "/api/me", ""); code != 401 {
		t.Fatal("ban must drop the target session")
	}
	if code, denied := f.call("POST", "/api/login", `{"username":"`+target+`","password":"Synthetic-New-Pass42"}`, ""); code != 403 {
		t.Fatalf("banned login: %d %v", code, denied)
	}
	entry = f.userEntry(target)
	if entry["banned"] != true || entry["banReason"] != "压测" || entry["banBy"] != "后台管理员" {
		t.Fatalf("banned user list projection: %v", entry)
	}

	// A timed ban expires by itself.
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.identities SET ban_until=clock_timestamp()-interval '1 minute' WHERE username=$1`, target); err != nil {
		t.Fatal(err)
	}
	expired, err := identity.New(f.db.App, nil).ExpireBans(context.Background())
	if err != nil || expired != 1 {
		t.Fatalf("expire bans: %d %v", expired, err)
	}
	code, login = f.call("POST", "/api/login", `{"username":"`+target+`","password":"Synthetic-New-Pass42"}`, "")
	if code != 200 {
		t.Fatalf("login after expiry: %d %v", code, login)
	}
	if token, _ := login["token"].(string); token != "" {
		f.playerToken = token
	}
	if entry = f.userEntry(target); entry["banned"] != false {
		t.Fatalf("expired ban still reported: %v", entry)
	}

	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+target+`","hours":-1,"confirm":true}`)
	f.expect(code, body, 200, "")
	if body["permanent"] != true || body["banned"] != true {
		t.Fatalf("permanent ban: %v", body)
	}
	code, body = f.admin("POST", "/api/admin/users/ban", `{"target":"`+target+`","hours":0,"confirm":true}`)
	f.expect(code, body, 200, "")
	if body["banned"] != false {
		t.Fatalf("unban: %v", body)
	}

	// Administrator flag.
	code, body = f.admin("POST", "/api/admin/users/setadmin", `{"target":"`+target+`"}`)
	f.expect(code, body, 400, "权限必须为布尔值")
	code, body = f.admin("POST", "/api/admin/users/setadmin", `{"target":"`+f.adminKey+`","admin":false}`)
	f.expect(code, body, 400, "不能撤销自己的管理员权限")
	code, body = f.admin("POST", "/api/admin/users/setadmin", `{"target":"`+target+`","admin":true}`)
	f.expect(code, body, 200, "")
	if body["admin"] != true {
		t.Fatalf("grant admin: %v", body)
	}
	granted := f.adminSession(target)
	if code, _ := f.call("GET", "/api/admin/overview", "", granted); code != 200 {
		t.Fatal("granted administrator cannot open the console")
	}
	code, body = f.admin("POST", "/api/admin/users/setadmin", `{"target":"`+target+`","admin":false}`)
	f.expect(code, body, 200, "")
	if code, _ := f.call("GET", "/api/admin/overview", "", granted); code != 401 {
		t.Fatal("revoked administrator session survived")
	}

	// Retirement frees the username and hides the account.
	code, body = f.admin("POST", "/api/admin/users/delete", `{"target":"`+target+`"}`)
	f.expect(code, body, 400, "需要二次确认")
	code, body = f.admin("POST", "/api/admin/users/delete", `{"target":"`+f.adminKey+`","confirm":true}`)
	f.expect(code, body, 400, "不能删除自己的账号")
	code, body = f.admin("POST", "/api/admin/users/delete", `{"target":"`+target+`","confirm":true}`)
	f.expect(code, body, 200, "")
	if f.userEntry(target) != nil {
		t.Fatal("retired account is still listed")
	}
	if code, denied := f.call("POST", "/api/login", `{"username":"`+target+`","password":"Synthetic-New-Pass42"}`, ""); code != 401 {
		t.Fatalf("retired account can still log in: %d %v", code, denied)
	}
	if _, id := f.register(target, "重新注册"); id == f.playerID {
		t.Fatal("retirement did not free the username")
	}

	actions := map[string]bool{}
	for _, raw := range f.auditLog() {
		entry := raw.(map[string]any)
		actions[entry["action"].(string)] = true
		if entry["name"] != "后台管理员" {
			t.Fatalf("audit actor: %v", entry)
		}
	}
	for _, action := range []string{"users/update", "users/ban", "users/setadmin", "users/delete"} {
		if !actions[action] {
			t.Fatalf("missing audit action %s in %v", action, actions)
		}
	}
	// The console audit is append only, for the application role and for the
	// operator role alike.
	if _, err := f.db.Admin.Exec(context.Background(), `DELETE FROM fishing.admin_audit`); err == nil {
		t.Fatal("console audit is mutable")
	}
	if _, err := f.db.App.Exec(context.Background(), `DELETE FROM fishing.admin_audit`); err == nil {
		t.Fatal("application role can delete the console audit")
	}
}

// TestIntegrationLegacyAdminFeedbackModeration covers the review surface: the
// list, status changes, rewards through an asset transaction, deletion and the
// operator-editable cooldown settings.
func TestIntegrationLegacyAdminFeedbackModeration(t *testing.T) {
	f := newAdminFixture(t)
	target := f.playerKey

	code, body := f.player("POST", "/api/feedback/submit", `{"text":"第一次反馈","kind":"bug"}`)
	f.expect(code, body, 200, "")
	entry := body["entry"].(map[string]any)
	id := entry["id"].(string)

	code, list := f.admin("GET", "/api/admin/feedback", "")
	f.expect(code, list, 200, "")
	if list["total"].(float64) != 1 {
		t.Fatalf("feedback total: %v", list["total"])
	}
	first := list["feedback"].([]any)[0].(map[string]any)
	if first["id"] != id || first["text"] != "第一次反馈" || first["key"] != target || first["status"] != "submitted" {
		t.Fatalf("feedback projection: %v", first)
	}
	if list["statuses"].(map[string]any)["rejected"] != "已拒绝" {
		t.Fatalf("feedback statuses: %v", list["statuses"])
	}
	cfg := list["cfg"].(map[string]any)
	if cfg["cdHours"].(float64) != 24 || cfg["skipCost"].(float64) != 10000 {
		t.Fatalf("feedback defaults: %v", cfg)
	}

	code, body = f.admin("POST", "/api/admin/feedback/status", `{"id":"`+id+`","status":"unknown"}`)
	f.expect(code, body, 400, "未知的反馈状态")
	code, body = f.admin("POST", "/api/admin/feedback/status", `{"id":"fb_missing","status":"accepted"}`)
	f.expect(code, body, 404, "反馈不存在")
	code, body = f.admin("POST", "/api/admin/feedback/status", `{"id":"`+id+`","status":"accepted"}`)
	f.expect(code, body, 200, "")

	code, body = f.admin("POST", "/api/admin/feedback/reward", `{"id":"`+id+`","coins":0}`)
	f.expect(code, body, 400, "奖励金币需在 1 - 10 亿之间")
	code, body = f.admin("POST", "/api/admin/feedback/reward", `{"id":"fb_missing","coins":100}`)
	f.expect(code, body, 404, "反馈不存在")
	before := f.coins(f.playerID)
	code, body = f.admin("POST", "/api/admin/feedback/reward", `{"id":"`+id+`","coins":1000,"note":"谢谢反馈"}`)
	f.expect(code, body, 200, "")
	reward := body["reward"].(map[string]any)
	if reward["coins"].(float64) != 1000 || reward["total"].(float64) != 1000 || reward["note"] != "谢谢反馈" || reward["by"] != "后台管理员" {
		t.Fatalf("reward projection: %v", reward)
	}
	if body["playerCoins"].(float64) != float64(before+1000) || f.coins(f.playerID) != before+1000 {
		t.Fatalf("reward did not reach the wallet: %v", body)
	}
	code, body = f.admin("POST", "/api/admin/feedback/reward", `{"id":"`+id+`","coins":500}`)
	f.expect(code, body, 200, "")
	if total := body["reward"].(map[string]any)["total"].(float64); total != 1500 {
		t.Fatalf("reward total must accumulate: %v", total)
	}
	if f.coins(f.playerID) != before+1500 {
		t.Fatal("second reward did not reach the wallet")
	}

	// Saved cooldown settings apply to the player surface immediately.
	code, body = f.admin("POST", "/api/admin/feedback/cfg", `{"cdHours":99999}`)
	f.expect(code, body, 400, "CD 时长需在 0 - 8760 小时之间")
	code, body = f.admin("POST", "/api/admin/feedback/cfg", `{"cdHours":1,"skipCost":250}`)
	f.expect(code, body, 200, "")
	saved := body["cfg"].(map[string]any)
	if saved["cdHours"].(float64) != 1 || saved["skipCost"].(float64) != 250 {
		t.Fatalf("saved feedback config: %v", saved)
	}
	code, status := f.player("GET", "/api/feedback", "")
	f.expect(code, status, 200, "")
	playerStatus := status["status"].(map[string]any)
	if playerStatus["skipCost"].(float64) != 250 || playerStatus["cdHours"].(float64) != 1 {
		t.Fatalf("player feedback status did not follow the console: %v", playerStatus)
	}
	code, body = f.player("POST", "/api/feedback/submit", `{"text":"第二次反馈","kind":"idea"}`)
	f.expect(code, body, 429, "")
	if message, _ := body["error"].(string); !strings.Contains(message, "250") {
		t.Fatalf("cooldown text must use the configured cost: %v", message)
	}

	code, body = f.admin("POST", "/api/admin/feedback/del", `{"id":"fb_missing"}`)
	f.expect(code, body, 404, "反馈不存在")
	code, body = f.admin("POST", "/api/admin/feedback/del", `{"id":"`+id+`"}`)
	f.expect(code, body, 200, "")
	if total := body["total"].(float64); total != 0 {
		t.Fatalf("feedback total after delete: %v", total)
	}
	code, status = f.player("GET", "/api/feedback", "")
	f.expect(code, status, 200, "")
	if len(status["mine"].([]any)) != 0 {
		t.Fatalf("deleted feedback still visible to its author: %v", status["mine"])
	}

	actions := map[string]bool{}
	for _, raw := range f.auditLog() {
		actions[raw.(map[string]any)["action"].(string)] = true
	}
	for _, action := range []string{"feedback/status", "feedback/reward", "feedback/cfg", "feedback/del"} {
		if !actions[action] {
			t.Fatalf("missing audit action %s in %v", action, actions)
		}
	}
}
