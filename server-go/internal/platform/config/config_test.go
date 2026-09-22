package config

import (
	"strings"
	"testing"
)

func TestConfigRejectsInvalidSettingsWithoutEchoingValues(t *testing.T) {
	for _, tc := range []struct{ key, value string }{
		{"FISHING_GO_DATABASE_URL", ""}, {"FISHING_GO_ROLE", "worker"},
		{"FISHING_GO_LISTEN", "invalid:SECRET"}, {"FISHING_GO_LISTEN", "127.0.0.1:70000"},
		{"FISHING_GO_DB_MAX_CONNS", "0"}, {"FISHING_GO_DB_MAX_CONNS", "1000000"},
		{"FISHING_GO_NODE_ID", "host\nSECRET"}, {"FISHING_GO_PROBE_TIMEOUT", "0"},
		{"FISHING_GO_STARTUP_TIMEOUT", "999h"}, {"FISHING_GO_SHUTDOWN_TIMEOUT", "-1s"},
		{"FISHING_GO_TIMEZONE", "SECRET-invalid-zone"},
		{"FISHING_GO_TRUSTED_PROXY_IPS", "SECRET-host"}, {"FISHING_GO_TRUSTED_PROXY_IPS", "0.0.0.0/0"},
		{"FISHING_GO_TRUSTED_PROXY_IPS", "0.0.0.0"}, {"FISHING_GO_TRUSTED_PROXY_IPS", "::"},
		{"FISHING_GO_TRUSTED_PROXY_IPS", "127.0.0.1,"}, {"FISHING_GO_TRUSTED_PROXY_IPS", "fe80::1%lo"},
		{"FISHING_GO_TRUSTED_PROXY_IPS", "ff02::1"}, {"FISHING_GO_REQUIRE_HTTPS", "SECRET"},
		{"FISHING_GO_COOKIE_NAMESPACE", "bad;SECRET"}, {"FISHING_GO_COOKIE_NAMESPACE", strings.Repeat("x", 33)},
	} {
		t.Run(tc.key+"/"+tc.value, func(t *testing.T) {
			get := func(key string) string {
				if key == tc.key {
					return tc.value
				}
				if key == "FISHING_GO_DATABASE_URL" {
					return "postgres://placeholder"
				}
				return ""
			}
			_, err := Load(get)
			if err == nil {
				t.Fatal("invalid configuration accepted")
			}
			if strings.Contains(err.Error(), "SECRET") {
				t.Fatal("input leaked")
			}
		})
	}
}

func TestConfigDefaultsBindLoopbackAndOnlyAllRole(t *testing.T) {
	c, err := Load(func(key string) string {
		if key == "FISHING_GO_DATABASE_URL" {
			return "postgres://placeholder"
		}
		return ""
	})
	if err != nil || c.ListenAddress != "127.0.0.1:9000" || c.Role != "all" || c.DatabaseMaxConns != 16 || len(c.TrustedProxyIPs) != 0 || c.RequireHTTPS || c.CookieNamespace != "" {
		t.Fatal("unexpected defaults", err)
	}
}

func TestExplicitProxyConfiguration(t *testing.T) {
	values := map[string]string{"FISHING_GO_DATABASE_URL": "postgres://placeholder", "FISHING_GO_TRUSTED_PROXY_IPS": "127.0.0.1, ::1", "FISHING_GO_REQUIRE_HTTPS": "1", "FISHING_GO_COOKIE_NAMESPACE": "go_test"}
	c, err := Load(func(k string) string { return values[k] })
	if err != nil || len(c.TrustedProxyIPs) != 2 || !c.RequireHTTPS || c.CookieNamespace != "go_test" {
		t.Fatal("valid proxy policy rejected", err)
	}
}
