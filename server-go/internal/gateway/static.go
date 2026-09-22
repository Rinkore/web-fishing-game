package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// frontendHandler returns a safe static handler for the browser client. API
// routes are mounted before this fallback, so the Go process remains the only
// application server while the existing frontend assets stay deployable.
func frontendHandler(root string) http.Handler {
	if strings.TrimSpace(root) == "" {
		return nil
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil
	}
	return http.FileServer(http.Dir(root))
}
