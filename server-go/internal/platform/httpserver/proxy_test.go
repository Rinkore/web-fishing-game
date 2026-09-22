package httpserver

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestProxyPolicyTrustBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, peer              string
		protocols, addresses    []string
		nativeTLS, requireHTTPS bool
		status                  int
		secure                  bool
		remote                  string
	}{
		{name: "default_plain", peer: "192.0.2.4:99", status: 200, remote: "192.0.2.4:99"},
		{name: "spoof_untrusted", peer: "192.0.2.4:99", protocols: []string{"https"}, addresses: []string{"198.51.100.9"}, status: 200, remote: "192.0.2.4:99"},
		{name: "spoof_rejected_by_https", peer: "192.0.2.4:99", protocols: []string{"https"}, addresses: []string{"198.51.100.9"}, requireHTTPS: true, status: 426},
		{name: "trusted_https", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"198.51.100.9"}, requireHTTPS: true, status: 200, secure: true, remote: "198.51.100.9:0"},
		{name: "trusted_http", peer: "127.0.0.1:99", protocols: []string{"http"}, addresses: []string{"198.51.100.9"}, status: 200, remote: "198.51.100.9:0"},
		{name: "trusted_http_requires_https", peer: "127.0.0.1:99", protocols: []string{"http"}, addresses: []string{"198.51.100.9"}, requireHTTPS: true, status: 426},
		{name: "trusted_ipv6", peer: "[::1]:99", protocols: []string{"https"}, addresses: []string{"2001:db8::9"}, status: 200, secure: true, remote: "[2001:db8::9]:0"},
		{name: "mapped_peer", peer: "[::ffff:127.0.0.1]:99", protocols: []string{"https"}, addresses: []string{"::ffff:198.51.100.9"}, status: 200, secure: true, remote: "198.51.100.9:0"},
		{name: "bad_peer", peer: "not-an-address", protocols: []string{"https"}, addresses: []string{"198.51.100.9"}, requireHTTPS: true, status: 426},
		{name: "missing_ip", peer: "127.0.0.1:99", protocols: []string{"https"}, status: 400},
		{name: "missing_proto", peer: "127.0.0.1:99", addresses: []string{"198.51.100.9"}, status: 400},
		{name: "duplicate_proto", peer: "127.0.0.1:99", protocols: []string{"https", "https"}, addresses: []string{"198.51.100.9"}, status: 400},
		{name: "duplicate_ip", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"198.51.100.9", "192.0.2.5"}, status: 400},
		{name: "proto_list", peer: "127.0.0.1:99", protocols: []string{"https,http"}, addresses: []string{"198.51.100.9"}, status: 400},
		{name: "ip_list", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"198.51.100.9,192.0.2.5"}, status: 400},
		{name: "zone_ip", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"fe80::1%eth0"}, status: 400},
		{name: "unspecified_ip", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"0.0.0.0"}, status: 400},
		{name: "multicast_ip", peer: "127.0.0.1:99", protocols: []string{"https"}, addresses: []string{"ff02::1"}, status: 400},
		{name: "native_tls", peer: "192.0.2.4:99", nativeTLS: true, requireHTTPS: true, status: 200, secure: true, remote: "192.0.2.4:99"},
		{name: "no_tls_downgrade", peer: "127.0.0.1:99", protocols: []string{"http"}, addresses: []string{"198.51.100.9"}, nativeTLS: true, requireHTTPS: true, status: 200, secure: true, remote: "198.51.100.9:0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := ProxyPolicy{TrustedIPs: []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("::1")}, RequireHTTPS: tc.requireHTTPS, CookieNamespace: "go_test"}
			req := httptest.NewRequest("GET", "http://test.example:19000/api/me", nil)
			req.RemoteAddr = tc.peer
			if tc.nativeTLS {
				req.TLS = &tls.ConnectionState{}
			}
			if tc.protocols != nil {
				req.Header["X-Forwarded-Proto"] = tc.protocols
			}
			if tc.addresses != nil {
				req.Header["X-Real-Ip"] = tc.addresses
			}
			req.Header.Set("X-Forwarded-For", "203.0.113.5")
			req.Header.Set("X-Forwarded-Host", "evil.example")
			req.Header.Set("Forwarded", "proto=https")
			called := false
			handler := p.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if IsHTTPS(r) != tc.secure || r.RemoteAddr != tc.remote || CookieNamespace(r) != "go_test" {
					t.Fatalf("wrong projection: secure=%v remote=%q namespace=%q", IsHTTPS(r), r.RemoteAddr, CookieNamespace(r))
				}
				if r.Host != "test.example:19000" || r.TLS != req.TLS {
					t.Fatal("host or native TLS modified")
				}
				for _, h := range []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-For", "X-Forwarded-Proto", "X-Real-IP"} {
					if r.Header.Get(h) != "" {
						t.Fatal("forwarding header leaked", h)
					}
				}
				w.WriteHeader(200)
			}))
			out := httptest.NewRecorder()
			handler.ServeHTTP(out, req)
			if out.Code != tc.status || called != (tc.status == 200) {
				t.Fatalf("status=%d called=%v", out.Code, called)
			}
			if req.RemoteAddr != tc.peer || req.Header.Get("X-Forwarded-For") == "" {
				t.Fatal("original request mutated")
			}
		})
	}
}

func TestProxyPolicyDisabledAndImmutable(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		ips := []netip.Addr{}
		if enabled {
			ips = append(ips, netip.MustParseAddr("127.0.0.1"))
		}
		policy := ProxyPolicy{TrustedIPs: ips}
		handler := policy.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if IsHTTPS(r) != enabled {
				t.Fatal("trust policy changed")
			}
		}))
		if enabled {
			ips[0] = netip.MustParseAddr("192.0.2.5")
		}
		r := httptest.NewRequest("GET", "http://test/", nil)
		r.RemoteAddr = "127.0.0.1:99"
		r.Header.Set("X-Forwarded-Proto", "https")
		r.Header.Set("X-Real-IP", "198.51.100.9")
		handler.ServeHTTP(httptest.NewRecorder(), r)
	}
}
