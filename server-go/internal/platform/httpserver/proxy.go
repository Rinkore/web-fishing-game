package httpserver

import (
	"context"
	"net"
	"net/http"
	"net/netip"
)

// ProxyPolicy trusts only explicitly configured TCP peers. The proxy must
// overwrite X-Forwarded-Proto and X-Real-IP, never append client input.
type ProxyPolicy struct {
	TrustedIPs      []netip.Addr
	RequireHTTPS    bool
	CookieNamespace string
}

type proxyContextKey struct{}
type proxyContext struct {
	secure    bool
	namespace string
}

// IsHTTPS describes the browser-facing transport, not TLS to the backend.
func IsHTTPS(r *http.Request) bool {
	if c, ok := r.Context().Value(proxyContextKey{}).(proxyContext); ok {
		return c.secure
	}
	return r.TLS != nil
}

func CookieNamespace(r *http.Request) string {
	c, _ := r.Context().Value(proxyContextKey{}).(proxyContext)
	return c.namespace
}

func (p ProxyPolicy) Wrap(next http.Handler) http.Handler {
	// Copy the policy so a caller cannot mutate the trust list during requests.
	trusted := append([]netip.Addr(nil), p.TrustedIPs...)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secure := r.TLS != nil
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		peer, parseErr := netip.ParseAddr(host)
		isTrusted := false
		if err == nil && parseErr == nil {
			for _, ip := range trusted {
				if ip.Unmap() == peer.Unmap() {
					isTrusted = true
					break
				}
			}
		}
		request := r.Clone(r.Context())
		if isTrusted {
			protocols, addresses := r.Header.Values("X-Forwarded-Proto"), r.Header.Values("X-Real-IP")
			if len(protocols) != 0 || len(addresses) != 0 {
				if len(protocols) != 1 || len(addresses) != 1 || (protocols[0] != "https" && protocols[0] != "http") {
					respond(w, http.StatusBadRequest, `{"error":"invalid_proxy_headers"}`)
					return
				}
				client, err := netip.ParseAddr(addresses[0])
				if err != nil || client.Zone() != "" || client.IsUnspecified() || client.IsMulticast() {
					respond(w, http.StatusBadRequest, `{"error":"invalid_proxy_headers"}`)
					return
				}
				secure = secure || protocols[0] == "https"
				request.RemoteAddr = net.JoinHostPort(client.Unmap().String(), "0")
			}
		}
		// Downstream code must not accidentally consume an untrusted forwarding chain.
		for _, header := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP"} {
			request.Header.Del(header)
		}
		if p.RequireHTTPS && !secure {
			respond(w, http.StatusUpgradeRequired, `{"error":"https_required"}`)
			return
		}
		ctx := context.WithValue(request.Context(), proxyContextKey{}, proxyContext{secure: secure, namespace: p.CookieNamespace})
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}
