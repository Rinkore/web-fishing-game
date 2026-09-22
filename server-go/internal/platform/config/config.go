// Package config loads infrastructure settings. Gameplay rules belong to a
// separately versioned catalog, not environment variables.
package config

import (
	"encoding/base64"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress    string
	FrontendDir      string
	NodeID           string
	Role             string
	DatabaseURL      string
	DatabaseMaxConns int32
	StartupTimeout   time.Duration
	ProbeTimeout     time.Duration
	ShutdownTimeout  time.Duration
	MFAEncryptionKey []byte
	Location         *time.Location
	TrustedProxyIPs  []netip.Addr
	RequireHTTPS     bool
	CookieNamespace  string
}

func Load(getenv func(string) string) (Config, error) {
	c := Config{ListenAddress: "127.0.0.1:9000", NodeID: "local", Role: "all", DatabaseMaxConns: 16,
		StartupTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: 10 * time.Second}
	c.Location = time.Local
	if raw := getenv("FISHING_GO_TRUSTED_PROXY_IPS"); raw != "" {
		for _, value := range strings.Split(raw, ",") {
			ip, err := netip.ParseAddr(strings.TrimSpace(value))
			if err != nil || ip.Zone() != "" || ip.IsUnspecified() || ip.IsMulticast() {
				return Config{}, errors.New("invalid FISHING_GO_TRUSTED_PROXY_IPS")
			}
			c.TrustedProxyIPs = append(c.TrustedProxyIPs, ip.Unmap())
		}
	}
	switch getenv("FISHING_GO_REQUIRE_HTTPS") {
	case "", "0":
	case "1":
		c.RequireHTTPS = true
	default:
		return Config{}, errors.New("invalid FISHING_GO_REQUIRE_HTTPS")
	}
	c.CookieNamespace = getenv("FISHING_GO_COOKIE_NAMESPACE")
	if len(c.CookieNamespace) > 32 {
		return Config{}, errors.New("invalid FISHING_GO_COOKIE_NAMESPACE")
	}
	for _, ch := range c.CookieNamespace {
		if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '_') {
			return Config{}, errors.New("invalid FISHING_GO_COOKIE_NAMESPACE")
		}
	}
	if name := getenv("FISHING_GO_TIMEZONE"); name != "" {
		location, err := time.LoadLocation(name)
		if err != nil {
			return Config{}, errors.New("invalid FISHING_GO_TIMEZONE")
		}
		c.Location = location
	}
	if v := getenv("FISHING_GO_LISTEN"); v != "" {
		c.ListenAddress = v
	}
	c.FrontendDir = getenv("FISHING_GO_FRONTEND_DIR")
	_, port, err := net.SplitHostPort(c.ListenAddress)
	p, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || p < 1 || p > 65535 {
		return Config{}, errors.New("invalid FISHING_GO_LISTEN")
	}
	if v := getenv("FISHING_GO_NODE_ID"); v != "" {
		c.NodeID = v
	}
	if len(c.NodeID) > 64 {
		return Config{}, errors.New("invalid FISHING_GO_NODE_ID")
	}
	for _, ch := range c.NodeID {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-' || ch == '.') {
			return Config{}, errors.New("invalid FISHING_GO_NODE_ID")
		}
	}
	if v := getenv("FISHING_GO_ROLE"); v != "" {
		c.Role = v
	}
	if c.Role != "all" {
		return Config{}, errors.New("only FISHING_GO_ROLE=all is implemented")
	}
	c.DatabaseURL = getenv("FISHING_GO_DATABASE_URL")
	if raw := getenv("FISHING_GO_MFA_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 {
			return Config{}, errors.New("FISHING_GO_MFA_KEY must be base64 of 32 bytes")
		}
		c.MFAEncryptionKey = key
	}
	if c.DatabaseURL == "" {
		return Config{}, errors.New("FISHING_GO_DATABASE_URL is required")
	}
	if v := getenv("FISHING_GO_DB_MAX_CONNS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 64 {
			return Config{}, errors.New("FISHING_GO_DB_MAX_CONNS must be 1..64")
		}
		c.DatabaseMaxConns = int32(n)
	}
	for _, item := range []struct {
		name   string
		target *time.Duration
		max    time.Duration
	}{
		{"FISHING_GO_STARTUP_TIMEOUT", &c.StartupTimeout, time.Minute},
		{"FISHING_GO_PROBE_TIMEOUT", &c.ProbeTimeout, 5 * time.Second},
		{"FISHING_GO_SHUTDOWN_TIMEOUT", &c.ShutdownTimeout, time.Minute},
	} {
		if v := getenv(item.name); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil || d < 100*time.Millisecond || d > item.max {
				return Config{}, errors.New("invalid " + item.name)
			}
			*item.target = d
		}
	}
	return c, nil
}
