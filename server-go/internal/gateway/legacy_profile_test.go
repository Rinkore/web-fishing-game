package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyProfileSaveAndBannerPlaying(t *testing.T) {
	db := testdb.New(t, true)
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()

	do := func(method, path, body, token string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, value
	}

	code, reg := do("POST", "/api/register", `{"username":"legacy_profile2","password":"Synthetic-Pass42","qq":"123456","name":"Before"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)

	// Rename the display name and confirm it is visible in the legacy profile.
	if code, _ := do("POST", "/api/profile", `{"name":"改名后"}`, token); code != 200 {
		t.Fatalf("profile save failed: %d", code)
	}
	code, profile := do("GET", "/api/me", "", token)
	if code != 200 || profile["name"] != "改名后" {
		t.Fatalf("profile view: %d %v", code, profile)
	}

	// Banner watch reports are accepted as ignored while the queue is empty.
	code, playing := do("POST", "/api/banner/playing", `{"id":"banner-x"}`, token)
	if code != 200 || playing["ok"] != true || playing["ignored"] != true {
		t.Fatalf("banner playing: %d %v", code, playing)
	}
	if code, _ := do("POST", "/api/banner/playing", `{"id":"banner-x"}`, ""); code != 401 {
		t.Fatalf("banner playing without login: %d", code)
	}
}
