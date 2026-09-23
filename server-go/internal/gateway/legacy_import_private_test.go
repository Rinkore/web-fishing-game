package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// This opt-in acceptance test only opens the named local restore clone. It
// creates temporary sessions, never changes a password or requests a gameplay
// action, and removes every session before closing its in-process HTTP server.
// Source values, tokens, credentials and account identifiers are never logged.
func TestPrivateImportedRestoreHTTPReadViews(t *testing.T) {
	dsn := os.Getenv("FISHING_PRIVATE_HTTP_DATABASE_URL")
	if dsn == "" {
		t.Skip("private restore HTTP verification is opt-in")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil || cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 65369 || cfg.ConnConfig.Database != "fishing_import_restore" {
		t.Fatal("private HTTP verification requires the explicit local restore clone")
	}
	root, keyFile := os.Getenv("FISHING_PRIVATE_HTTP_SOURCE"), os.Getenv("FISHING_PRIVATE_HTTP_MFA_FILE")
	if root == "" || keyFile == "" {
		t.Fatal("private verification inputs missing")
	}
	encoded, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal("private key unavailable")
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil || len(key) != 32 {
		t.Fatal("private key invalid")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("clone connection unavailable")
	}
	defer pool.Close()
	if pool.Ping(ctx) != nil {
		t.Fatal("clone unavailable")
	}
	var hashes [][]byte
	defer func() {
		for _, h := range hashes {
			if _, e := pool.Exec(context.Background(), `DELETE FROM fishing.auth_sessions WHERE token_hash=$1`, h); e != nil {
				t.Error("temporary session cleanup failed")
			}
		}
	}()
	loc, _ := time.LoadLocation("Asia/Shanghai")
	server := httptest.NewServer(New(pool, key, loc))
	defer server.Close()
	client := server.Client()
	client.Timeout = 45 * time.Second
	mint := func(id int64, admin bool) string {
		t.Helper()
		raw := make([]byte, 32)
		if _, e := rand.Read(raw); e != nil {
			t.Fatal("session entropy unavailable")
		}
		token := base64.RawURLEncoding.EncodeToString(raw)
		h := sha256.Sum256([]byte(token))
		if _, e := pool.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')`, h[:], id, admin); e != nil {
			t.Fatal("temporary clone session unavailable")
		}
		hashes = append(hashes, h[:])
		return token
	}
	get := func(path, token string) map[string]any {
		t.Helper()
		r, e := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path, nil)
		if e != nil {
			t.Fatal("request construction failed")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response, e := client.Do(r)
		if e != nil {
			t.Fatal("private HTTP request failed")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("read route %s status %d", strings.Split(path, "?")[0], response.StatusCode)
		}
		var body map[string]any
		if json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(&body) != nil {
			t.Fatal("private HTTP response invalid")
		}
		return body
	}
	fingerprint := func() string {
		t.Helper()
		var raw []byte
		e := pool.QueryRow(ctx, `SELECT jsonb_build_array((SELECT count(*) FROM fishing.asset_operations),(SELECT sum(coins) FROM fishing.wallets),(SELECT sum(quantity) FROM fishing.inventory_stacks),(SELECT count(*) FROM fishing.equipment_instances),(SELECT sum(catch_count) FROM fishing.player_state),(SELECT count(*) FROM fishing.catch_records),(SELECT count(*) FROM fishing.sea_progress_entries))`).Scan(&raw)
		if e != nil {
			t.Fatal("asset fingerprint unavailable")
		}
		return string(raw)
	}
	before := fingerprint()
	var largest, ordinary, administrator int64
	if pool.QueryRow(ctx, `SELECT owner_id FROM fishing.equipment_instances GROUP BY owner_id ORDER BY count(*) DESC LIMIT 1`).Scan(&largest) != nil {
		t.Fatal("large-inventory representative unavailable")
	}
	if pool.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE NOT admin AND NOT banned AND account_id<>$1 ORDER BY account_id LIMIT 1`, largest).Scan(&ordinary) != nil {
		t.Fatal("ordinary representative unavailable")
	}
	if pool.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE admin AND NOT banned ORDER BY account_id LIMIT 1`).Scan(&administrator) != nil {
		t.Fatal("administrator representative unavailable")
	}
	for index, id := range []int64{ordinary, largest, administrator} {
		var sourceKey string
		if pool.QueryRow(ctx, `SELECT legacy_id FROM fishing.legacy_id_map WHERE domain='account' AND new_id=$1`, privateID(id)).Scan(&sourceKey) != nil {
			t.Fatal("source account mapping unavailable")
		}
		if filepath.Base(sourceKey) != sourceKey {
			t.Fatal("unsafe source mapping")
		}
		raw, e := os.ReadFile(filepath.Join(root, "accounts", sourceKey+".json"))
		if e != nil {
			t.Fatal("private source unavailable")
		}
		var source map[string]any
		if json.Unmarshal(raw, &source) != nil {
			t.Fatal("private source invalid")
		}
		token := mint(id, false)
		profile := get("/api/me", token)
		for _, field := range []string{"name", "qq", "coins", "catchCount"} {
			if !reflect.DeepEqual(profile[field], source[field]) {
				t.Fatalf("representative %d profile field %s differs", index, field)
			}
		}
		// The browser derives QQ avatars from this field; preserve the exact
		// value without sending it to an external avatar service during QA.
		if profile["username"] != strings.ToLower(privateString(source["username"])) || profile["admin"] != privateBool(source["admin"]) {
			t.Fatal("identity projection differs")
		}
		if !reflect.DeepEqual(privatePositiveMap(source["inventory"]), privatePositiveMap(profile["inventory"])) {
			t.Fatalf("representative %d inventory projection differs", index)
		}
		if !reflect.DeepEqual(privateBigfish(source["bigfish"]), privateBigfish(profile["bigfish"])) {
			t.Fatal("bigfish projection differs")
		}
		if !reflect.DeepEqual(privateParts(source["bd"]), privateParts(profile["bd"])) {
			t.Fatal("active equipment projection differs")
		}
		wantActive := float64(-1)
		if v, ok := source["rodActiveSlot"].(float64); ok {
			wantActive = v
		}
		if profile["rodActiveSlot"] != wantActive {
			t.Fatal("active rod pointer differs")
		}
		wantCapacity := float64(1)
		if v, ok := source["rodSlotsCount"].(float64); ok {
			wantCapacity = v
		}
		if profile["rodSlotsCount"] != wantCapacity {
			t.Fatal("rod capacity differs")
		}
		sourceSlots, _ := source["rodSlots"].([]any)
		viewSlots, _ := profile["rodSlots"].([]any)
		for slot, v := range sourceSlots {
			parts := privateParts(privateMap(v)["bd"])
			if len(parts) == 0 {
				continue
			}
			if slot >= len(viewSlots) {
				t.Fatal("saved rod missing")
			}
			view := privateMap(viewSlots[slot])
			if view["name"] != privateMap(v)["name"] || !reflect.DeepEqual(privateMap(view["parts"]), parts) {
				t.Fatal("saved rod projection differs")
			}
		}
		codex := privateMap(profile["codex"])
		if len(codex) != len(privateMap(source["codex"])) {
			t.Fatal("codex count differs")
		}
		for item, v := range privateMap(source["codex"]) {
			s := privateMap(v)
			got := privateMap(codex[item])
			for _, field := range []string{"count", "first", "min", "max", "tier"} {
				if !reflect.DeepEqual(s[field], got[field]) {
					t.Fatalf("representative %d codex field %s differs", index, field)
				}
			}
		}
		separate := get("/api/codex", token)
		if !reflect.DeepEqual(separate["codex"], profile["codex"]) {
			t.Fatal("codex endpoint differs")
		}
		get("/api/market/history", token)
		t.Logf("representative %d identity/avatar key, assets, equipment, rods and codex verified", index)
	}
	adminToken := mint(administrator, true)
	for _, path := range []string{"/api/admin/session", "/api/admin/overview", "/api/admin/users", "/api/admin/world", "/api/admin/stats", "/api/admin/feedback"} {
		get(path, adminToken)
	}
	wiki := get("/api/wiki/content", "")
	if guides, ok := wiki["guides"].([]any); !ok || len(guides) == 0 {
		t.Fatal("imported Wiki empty")
	}
	listing := get("/api/wiki/guides?pageSize=1", "")
	guides, _ := listing["guides"].([]any)
	if len(guides) == 0 {
		t.Fatal("Wiki listing empty")
	}
	guideID := privateString(privateMap(guides[0])["id"])
	get("/api/wiki/guides/"+url.PathEscape(guideID), "")
	records := get("/api/records", "")
	if len(records) == 0 {
		t.Fatal("record projection empty")
	}
	get("/api/records/top?id=crucian", "")
	get("/api/market", mint(ordinary, false))
	var item string
	if pool.QueryRow(ctx, `SELECT item_id FROM fishing.legacy_economy_history WHERE kind='shop' AND item_id<>'' GROUP BY item_id ORDER BY count(*) DESC LIMIT 1`).Scan(&item) != nil {
		t.Fatal("shop-history representative unavailable")
	}
	history := get("/api/shop/history?id="+url.QueryEscape(item), "")
	if rows, ok := history["trades"].([]any); !ok || len(rows) == 0 {
		t.Fatal("imported shop history missing")
	}
	var historyOwner int64
	if pool.QueryRow(ctx, `SELECT i.account_id FROM fishing.identities i WHERE EXISTS(SELECT 1 FROM fishing.legacy_economy_history h WHERE h.kind='market' AND (h.payload->>'buyer'=i.username OR h.payload->>'seller'=i.username)) ORDER BY i.account_id LIMIT 1`).Scan(&historyOwner) != nil {
		t.Fatal("market-history representative unavailable")
	}
	marketHistory := get("/api/market/history", mint(historyOwner, false))
	if trades, ok := marketHistory["trades"].([]any); !ok || len(trades) == 0 {
		t.Fatal("imported personal market history missing")
	}
	if fingerprint() != before {
		t.Fatal("HTTP read verification changed player assets")
	}
	t.Log("restored private database HTTP projections verified; no player asset changes")
}

func privateMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}
func privateString(v any) string { s, _ := v.(string); return s }
func privateBool(v any) bool     { b, _ := v.(bool); return b }
func privateID(v int64) string   { b, _ := json.Marshal(v); return string(b) }
func privatePositiveMap(v any) map[string]any {
	m := map[string]any{}
	for k, x := range privateMap(v) {
		if n, ok := x.(float64); ok && n > 0 {
			m[k] = n
		}
	}
	return m
}
func privateParts(v any) map[string]any {
	m := map[string]any{}
	for k, x := range privateMap(v) {
		if sig := privateString(privateMap(x)["compId"]); sig != "" {
			m[k] = sig
		}
	}
	return m
}
func privateBigfish(v any) map[string]any {
	m := map[string]any{}
	for k, x := range privateMap(v) {
		parts := privatePositiveMap(x)
		if len(parts) > 0 {
			m[k] = parts
		}
	}
	return m
}
