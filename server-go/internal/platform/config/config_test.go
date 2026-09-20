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
	if err != nil || c.ListenAddress != "127.0.0.1:19001" || c.Role != "all" || c.DatabaseMaxConns != 16 {
		t.Fatal("unexpected defaults", err)
	}
}
