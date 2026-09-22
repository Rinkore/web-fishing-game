package gateway

import (
	"net/http"

	"fishing.local/server/internal/modules/identity"
	"strings"
	"unicode/utf16"
)

// legacyProfileSave persists the display-name edit. Assets and configuration
// stay server-authoritative; only the display name is client-provided.
func (a *API) legacyProfileSave(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Name != "" {
		name := strings.TrimSpace(in.Name)
		units := utf16.Encode([]rune(name))
		if len(units) > 20 {
			units = units[:20]
			if units[19] >= 0xd800 && units[19] <= 0xdbff {
				units = units[:19]
			}
		}
		name = string(utf16.Decode(units))
		if name == "" {
			write(w, 400, map[string]any{"error": "invalid_name", "code": "invalid_name"})
			return
		}
		if _, err := a.pool.Exec(r.Context(), `UPDATE fishing.identities SET display_name=$2 WHERE account_id=$1`, session.AccountID, name); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
	}
	write(w, 200, map[string]any{"ok": true})
}
