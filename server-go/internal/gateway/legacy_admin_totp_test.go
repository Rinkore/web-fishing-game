package gateway

import (
	"bytes"
	"context"
	"encoding/base32"
	"strings"
	"testing"
)

// TestIntegrationAdminUserTOTPEnrollment covers console enrollment: only an
// authorized administrator can be enrolled, the write needs a second
// confirmation, the minted secret is returned exactly once and it never reaches
// the audit trail or the account list. Revocation follows the console contract:
// stale console sessions of the target are dropped while the target's gameplay
// stream survives, and rotating your own key keeps the session you call with.
func TestIntegrationAdminUserTOTPEnrollment(t *testing.T) {
	f := newAdminFixture(t)
	target := f.playerKey
	ctx := context.Background()
	var targetID int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1`, target).Scan(&targetID); err != nil {
		t.Fatal(err)
	}

	// The console enrolls administrators; it never promotes an account.
	code, body := f.admin("POST", "/api/admin/users/totp", `{"target":"`+target+`","confirm":true}`)
	f.expect(code, body, 400, "该账号不是管理员，请先打开「管理员」开关")
	code, body = f.admin("POST", "/api/admin/users/totp", `{"target":"`+f.adminKey+`"}`)
	f.expect(code, body, 400, "需要二次确认")
	if code, _ := f.call("POST", "/api/admin/users/totp", `{"target":"`+target+`","confirm":true}`, ""); code != 401 {
		t.Fatal("console enrollment accepted an anonymous request")
	}
	if code, _ := f.player("POST", "/api/admin/users/totp", `{"target":"`+target+`","confirm":true}`); code != 401 {
		t.Fatal("console enrollment accepted a game session")
	}

	code, body = f.admin("POST", "/api/admin/users/setadmin", `{"target":"`+target+`","admin":true}`)
	f.expect(code, body, 200, "")
	stale := f.adminSession(target) // a second console session that must not survive
	if _, err := f.db.App.Exec(ctx, `INSERT INTO fishing.gateway_streams(owner_id,stream_id,expires_at) VALUES($1,'stale',clock_timestamp()+interval '1 minute')`, targetID); err != nil {
		t.Fatal(err)
	}

	code, body = f.admin("POST", "/api/admin/users/totp", `{"target":"`+target+`","confirm":true}`)
	f.expect(code, body, 200, "")
	if body["target"] != target {
		t.Fatalf("enrollment target: %v", body["target"])
	}
	secret, _ := body["secret"].(string)
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(raw) != 20 {
		t.Fatalf("secret is not 20 bytes of Base32: %q %v", secret, err)
	}
	link, _ := body["otpauthUrl"].(string)
	for _, want := range []string{"otpauth://totp/", "secret=" + secret, "issuer=", "algorithm=SHA1", "digits=6", "period=30"} {
		if !strings.Contains(link, want) {
			t.Fatalf("otpauth link %q misses %q", link, want)
		}
	}

	var sealed []byte
	var last int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT mfa_secret,mfa_last_step FROM fishing.identities WHERE account_id=$1`, targetID).Scan(&sealed, &last); err != nil {
		t.Fatal(err)
	}
	if len(sealed) == 0 || last != -1 {
		t.Fatalf("enrollment storage: %d bytes, replay step %d", len(sealed), last)
	}
	if bytes.Contains(sealed, []byte(secret)) {
		t.Fatal("authenticator secret stored in clear")
	}
	if code, _ := f.call("GET", "/api/admin/overview", "", stale); code != 401 {
		t.Fatal("stale console session survived enrollment")
	}
	var streams int
	if err := f.db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.gateway_streams WHERE owner_id=$1`, targetID).Scan(&streams); err != nil {
		t.Fatal(err)
	}
	if streams != 1 {
		t.Fatal("console enrollment dropped the target's gameplay stream")
	}
	if entry := f.userEntry(target); entry == nil {
		t.Fatal("enrolled administrator left the account list")
	} else if _, leaked := entry["secret"]; leaked {
		t.Fatalf("account list leaked the secret: %v", entry)
	}

	// Rotating your own key keeps the calling session and drops every other one.
	mine := f.adminSession(f.adminKey)
	code, body = f.admin("POST", "/api/admin/users/totp", `{"target":"`+f.adminKey+`","confirm":true}`)
	f.expect(code, body, 200, "")
	if code, _ := f.call("GET", "/api/admin/overview", "", f.adminToken); code != 200 {
		t.Fatal("self rotation dropped the calling session")
	}
	if code, _ := f.call("GET", "/api/admin/overview", "", mine); code != 401 {
		t.Fatal("self rotation kept another console session")
	}

	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.identities SET banned=true WHERE account_id=$1`, targetID); err != nil {
		t.Fatal(err)
	}
	code, body = f.admin("POST", "/api/admin/users/totp", `{"target":"`+target+`","confirm":true}`)
	f.expect(code, body, 400, "该账号已被封禁，请先解封")

	found := false
	for _, item := range f.auditLog() {
		entry := item.(map[string]any)
		if entry["action"] != "users/totp" {
			continue
		}
		found = true
		if entry["name"] != "后台管理员" || entry["detail"] == "" {
			t.Fatalf("enrollment audit entry: %v", entry)
		}
		if strings.Contains(entry["detail"].(string), secret) {
			t.Fatal("audit trail leaked the secret")
		}
	}
	if !found {
		t.Fatal("missing users/totp audit action")
	}
}
