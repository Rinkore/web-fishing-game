package gateway

import (
	"fishing.local/server/internal/platform/httpserver"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestHTTPSProxyCookiesOriginAndCSRF(t *testing.T) {
	policy := httpserver.ProxyPolicy{TrustedIPs: []netip.Addr{netip.MustParseAddr("127.0.0.1")}, RequireHTTPS: true, CookieNamespace: "go_test"}
	for _, tc := range []struct {
		name, origin, cookie, xrw string
		status                    int
	}{
		{"same_origin", "https://test.example:19000", "", "FishGame", 200},
		{"cross_origin", "https://evil.example", "", "FishGame", 403},
		{"wrong_scheme", "http://test.example:19000", "", "FishGame", 403},
		{"wrong_port", "https://test.example:9000", "", "FishGame", 403},
		{"csrf_missing", "https://test.example:19000", "__Host-fish_go_test_game=synthetic-token", "", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := &API{}
			h := policy.Wrap(api.security(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				setCookie(w, r, false, "synthetic-token", false)
				setCookie(w, r, true, "synthetic-admin", false)
				w.WriteHeader(200)
			})))
			r := httptest.NewRequest("POST", "http://test.example:19000/api/test", strings.NewReader("{}"))
			r.RemoteAddr = "127.0.0.1:55"
			r.Header.Set("X-Forwarded-Proto", "https")
			r.Header.Set("X-Real-IP", "198.51.100.8")
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Session-Mode", "cookie")
			r.Header.Set("Origin", tc.origin)
			r.Header.Set("X-Requested-With", tc.xrw)
			if tc.cookie != "" {
				r.Header.Set("Cookie", tc.cookie)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d", w.Code)
			}
			if tc.status == 200 {
				cs := w.Result().Cookies()
				if len(cs) != 2 {
					t.Fatal("cookies missing")
				}
				for i, c := range cs {
					expected := "__Host-fish_go_test_game"
					if i == 1 {
						expected = "__Host-fish_go_test_admin"
					}
					if c.Name != expected || !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Domain != "" || c.Path != "/" {
						t.Fatalf("unsafe cookie: %+v", c)
					}
				}
				if w.Header().Get("Strict-Transport-Security") == "" {
					t.Fatal("HSTS missing")
				}
			}
		})
	}
}

func TestProxyCookieNamespaceIsolation(t *testing.T) {
	p := httpserver.ProxyPolicy{TrustedIPs: []netip.Addr{netip.MustParseAddr("127.0.0.1")}, CookieNamespace: "go_test"}
	for _, tc := range []struct{ cookie, want string }{
		{"__Host-fish_game=production-token", ""},
		{"__Host-fish_admin=production-admin", ""},
		{"fish_go_test_game=plain-token", ""},
		{"__Host-fish_go_test_game=test-token", "test-token"},
		{"__Host-fish_go_test_game=a; __Host-fish_go_test_game=b", ""},
	} {
		r := httptest.NewRequest("GET", "http://test/api/me", nil)
		r.RemoteAddr = "127.0.0.1:1"
		r.Header.Set("X-Forwarded-Proto", "https")
		r.Header.Set("X-Real-IP", "192.0.2.1")
		r.Header.Set("Cookie", tc.cookie)
		p.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := token(r, false); got != tc.want {
				t.Fatalf("cookie namespace mixed: got %q", got)
			}
			setCookie(w, r, false, "", true)
		})).ServeHTTP(httptest.NewRecorder(), r)
	}
	r := httptest.NewRequest("GET", "http://test/", nil)
	if cookieName(r, false) != "fish_game" {
		t.Fatal("default name changed")
	}
}
