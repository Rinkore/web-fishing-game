package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationHTTPAuthenticationAndPagination(t *testing.T) {
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	request := func(method, path, body, token string, headers map[string]string) (int, map[string]any, *http.Response) {
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
		for k, v := range headers {
			r.Header.Set(k, v)
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
		return res.StatusCode, value, res
	}
	registration := `{"username":"http_account","password":"Synthetic-http-Pass42","qq":"123456","name":"HTTP test"}`
	if code, _, _ := request("POST", "/api/register", registration, "", map[string]string{"Origin": "https://untrusted.example"}); code != 403 {
		t.Fatal("cross-origin registration accepted")
	}
	code, value, response := request("POST", "/api/register", registration, "", map[string]string{"X-Session-Mode": "cookie", "X-Requested-With": "FishGame"})
	if code != 200 || value["token"] != "cookie" {
		t.Fatalf("register: %d %v", code, value)
	}
	cookies := response.Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("cookie protection missing")
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value
	if code, _, _ := request("POST", "/api/logout", "{}", "", map[string]string{"Cookie": cookie}); code != 403 {
		t.Fatal("cookie write missing CSRF proof")
	}
	code, value, _ = request("GET", "/api/v1/me", "", "", map[string]string{"Cookie": cookie})
	if code != 200 || value["coins"] != float64(500) {
		t.Fatal("authenticated profile")
	}
	if code, _, _ := request("GET", "/api/admin/session", "", cookies[0].Value, nil); code != 401 {
		t.Fatal("game token grants admin")
	}
	if code, _, _ := request("GET", "/api/v1/me", "", "invalid", map[string]string{"Cookie": cookie}); code != 401 {
		t.Fatal("invalid bearer fell back to cookie")
	}
	svc := identity.New(db.App, nil)
	session, err := svc.Authenticate(context.Background(), cookies[0].Value, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(context.Background(), `INSERT INTO fishing.item_definitions(id,kind) VALUES('test_a','material'),('test_b','material')`); err != nil {
		t.Fatal(err)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "seed-http", Reason: "reward", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "test_a", Tier: "normal", Quantity: 1}, {ItemID: "test_b", Tier: "normal", Quantity: 2}}}); err != nil {
		t.Fatal(err)
	}
	code, page, _ := request("GET", "/api/v1/assets?limit=1", "", cookies[0].Value, nil)
	if code != 200 || len(page["items"].([]any)) != 1 || page["nextCursor"] == "" {
		t.Fatal("pagination first page")
	}
	cursor := page["nextCursor"].(string)
	code, second, _ := request("GET", "/api/v1/assets?limit=1&cursor="+cursor, "", cookies[0].Value, nil)
	if code != 200 || second["nextCursor"] != "" {
		t.Fatal("pagination continuation")
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: session.AccountID, RequestKey: "change-http", Reason: "reward", RuleVersion: "test-v1", Coins: 1}); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := request("GET", "/api/v1/assets?cursor="+cursor, "", cookies[0].Value, nil); code != 409 {
		t.Fatal("stale page cursor not rejected")
	}
	if code, _, _ := request("POST", "/api/logout", "{}", "", map[string]string{"Cookie": cookie, "X-Requested-With": "FishGame"}); code != 200 {
		t.Fatal("logout failed")
	}
	if code, _, _ := request("GET", "/api/v1/me", "", cookies[0].Value, nil); code != 401 {
		t.Fatal("logged-out token accepted")
	}
}
func TestIntegrationSSERevisionReplayAndRevocation(t *testing.T) {
	db := testdb.New(t, true)
	svc := identity.New(db.App, nil)
	reg, err := svc.Register(context.Background(), identity.Registration{Username: "sse_account", Password: "Synthetic-sse-Pass42", QQ: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	open := func(last string) (*http.Response, *bufio.Reader) {
		t.Helper()
		req, _ := http.NewRequest("GET", server.URL+"/api/v1/events", nil)
		req.Header.Set("Authorization", "Bearer "+reg.Token)
		if last != "" {
			req.Header.Set("Last-Event-ID", last)
		}
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != 200 {
			t.Fatal("SSE authorization")
		}
		return res, bufio.NewReader(res.Body)
	}
	nextData := func(reader *bufio.Reader) string {
		t.Helper()
		out := make(chan string, 1)
		go func() {
			for {
				line, err := reader.ReadString('\n')
				if err != nil {
					out <- "closed"
					return
				}
				if strings.HasPrefix(line, "data: ") {
					out <- line
					return
				}
			}
		}()
		select {
		case s := <-out:
			return s
		case <-time.After(5 * time.Second):
			t.Fatal("SSE timeout")
			return ""
		}
	}
	res, reader := open("")
	defer res.Body.Close()
	if s := nextData(reader); !strings.Contains(s, `"snapshot_required"`) || !strings.Contains(s, `"assetsRev":"1"`) {
		t.Fatalf("initial snapshot: %s", s)
	}
	for _, key := range []string{"sse-1", "sse-2"} {
		if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{ActorID: reg.Session.AccountID, RequestKey: key, Reason: "reward", RuleVersion: "test-v1", Coins: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if s := nextData(reader); !strings.Contains(s, `"assetsRev":"2"`) {
		t.Fatalf("first revision: %s", s)
	}
	_ = res.Body.Close()
	replay, replayReader := open("2")
	defer replay.Body.Close()
	if s := nextData(replayReader); !strings.Contains(s, `"assetsRev":"3"`) {
		t.Fatalf("replayed revision: %s", s)
	}
	if err := svc.Logout(context.Background(), reg.Session); err != nil {
		t.Fatal(err)
	}
	if s := nextData(replayReader); !strings.Contains(s, `"kicked"`) {
		t.Fatalf("revocation: %s", s)
	}
	_, _ = io.Copy(io.Discard, replay.Body)
}
