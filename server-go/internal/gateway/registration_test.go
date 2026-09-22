package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"fishing.local/server/internal/testdb"
)

func TestIntegrationRegistrationLegacyFormAndProof(t *testing.T) {
	db := testdb.New(t, true)
	handler := New(db.App, nil)
	call := func(method, path string, body map[string]any, source string) (int, map[string]any) {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(jsonString(body)))
		r.RemoteAddr = source + ":1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", "192.0.2.99")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return w.Code, out
	}
	body := map[string]any{"username": "legacy_reg", "password": "Synthetic-registration-Pass42", "confirmPassword": "wrong", "qq": "123456"}
	if code, _ := call(http.MethodPost, "/api/register", body, "192.0.2.1"); code != 400 {
		t.Fatal("confirmation mismatch accepted")
	}
	body["confirmPassword"] = body["password"]
	for i := range 3 {
		body["username"] = "legacy_reg" + strconv.Itoa(i)
		code, out := call(http.MethodPost, "/api/register", body, "192.0.2.1")
		if code != 200 || out["profile"].(map[string]any)["username"] != body["username"] {
			t.Fatalf("legacy profile %d: %v", code, out)
		}
	}
	body["username"] = "legacy_proof"
	code, out := call(http.MethodPost, "/api/register", body, "192.0.2.1")
	if code != 403 || out["code"] != "REGISTRATION_CHALLENGE" {
		t.Fatalf("proof round: %d %v", code, out)
	}
	_, challenge := call(http.MethodGet, "/api/register/challenge", nil, "192.0.2.1")
	var nonce string
	for n := 0; ; n++ {
		nonce = strconv.Itoa(n)
		digest := sha256.Sum256([]byte(challenge["prefix"].(string) + ":" + nonce))
		if digest[0] == 0 && digest[1] == 0 {
			break
		}
	}
	body["proof"] = map[string]any{"id": challenge["id"], "nonce": nonce}
	// Rebuilding the HTTP handler cannot reset quotas or invalidate valid proof.
	handler = New(db.App, nil)
	code, out = call(http.MethodPost, "/api/register", body, "192.0.2.1")
	if code != 200 || out["profile"].(map[string]any)["coins"] != float64(500) {
		t.Fatalf("proved registration: %d %v", code, out)
	}
	body["username"] = "proof_replay"
	if code, _ := call(http.MethodPost, "/api/register", body, "192.0.2.1"); code != 403 {
		t.Fatal("proof reused")
	}
	var created int
	if err := db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.identities WHERE username='proof_replay'`).Scan(&created); err != nil || created != 0 {
		t.Fatal("challenge rejection created account")
	}
	code, out = call(http.MethodPost, "/api/login", map[string]any{"username": "legacy_proof", "password": body["password"]}, "192.0.2.1")
	if code != 200 || out["profile"].(map[string]any)["username"] != "legacy_proof" {
		t.Fatalf("legacy login profile: %d %v", code, out)
	}
}
