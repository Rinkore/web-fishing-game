package gateway

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The browser is optional in the portable Go suite; opt in explicitly with
// FISHING_GO_BROWSER_NODE and a Node environment providing playwright-core.
// API responses are from the real gateway and isolated PostgreSQL fixture.
func TestIntegrationLegacyBrowserConfigBannerParty(t *testing.T) {
	node := os.Getenv("FISHING_GO_BROWSER_NODE")
	if node == "" {
		t.Skip("set FISHING_GO_BROWSER_NODE for real legacy browser validation")
	}
	f := newAdminFixture(t)
	setupAdminParty(t, f)
	frontend, err := filepath.Abs(filepath.Join("..", "..", "..", "frontend"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(f.db.App, nil)
	static := http.FileServer(http.Dir(frontend))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/events" || r.URL.Path == "/shop" {
			api.ServeHTTP(w, r)
			return
		}
		static.ServeHTTP(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "tests", "go-rewrite-browser.test.js"))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, script)
	command.Stdin = strings.NewReader(jsonString(map[string]any{"url": server.URL, "adminToken": f.adminToken, "playerToken": f.playerToken}))
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Run(); err != nil {
		t.Fatalf("browser validation: %v\n%s", err, output.String())
	}
	t.Log(strings.TrimSpace(output.String()))
}
