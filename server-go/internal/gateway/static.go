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
	fileServer := http.FileServer(http.Dir(root))
	// 发版后用户必须尽快拿到新前端：带 ?v= 的资源 URL 随版本变化，可长期缓存；
	// 其余（HTML、图片等无版本资源）每次回源校验，防止浏览器启发式缓存停在旧版。
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("v") != "" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	})
}
