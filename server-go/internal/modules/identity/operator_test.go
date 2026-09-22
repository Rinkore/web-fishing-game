package identity

import (
	"context"
	"fishing.local/server/internal/testdb"
	"testing"
	"time"
)

func TestIntegrationOperatorEnrollmentReplayRevocationAndAudit(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	key := make([]byte, 32)
	svc := New(db.App, key)
	reg, err := svc.Register(ctx, Registration{Username: "operator_test", Password: testPassword, Name: "Synthetic", QQ: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	var now time.Time
	if err := db.Admin.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	code := totp(secret, now.Unix()/30)
	// The runtime role cannot grant privileges without the operator audit permission.
	if err := ProvisionAdmin(ctx, db.App, key, "operator_test", secret, code); err == nil {
		t.Fatal("runtime role provisioned admin")
	}
	var admin bool
	if err := db.Admin.QueryRow(ctx, `SELECT admin FROM fishing.identities WHERE account_id=$1`, reg.Session.AccountID).Scan(&admin); err != nil || admin {
		t.Fatal("failed audit leaked admin", err)
	}
	if err := ProvisionAdmin(ctx, db.Admin, key, "operator_test", secret, code); err != nil {
		t.Fatal("enrollment", err)
	}
	if err := ProvisionAdmin(ctx, db.Admin, key, "operator_test", secret, code); err != ErrCredentials {
		t.Fatal("enrollment OTP replay", err)
	}
	if _, err := svc.Login(ctx, Login{Username: "operator_test", Password: testPassword, OTP: code, Admin: true}); err == nil {
		t.Fatal("enrollment OTP reused for login")
	}
	login, err := svc.Login(ctx, Login{Username: "operator_test", Password: testPassword, OTP: totp(secret, now.Unix()/30+1), Admin: true})
	if err != nil {
		t.Fatal("admin login", err)
	}
	if err := RevokeAdmin(ctx, db.Admin, "operator_test"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, login.Token, true); err == nil {
		t.Fatal("revoked admin session remained valid")
	}
	if _, err := svc.Authenticate(ctx, reg.Token, false); err != nil {
		t.Fatal("operator action revoked independent player session", err)
	}
	var count int
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.operator_audit`).Scan(&count); err != nil || count != 2 {
		t.Fatal("audit count", count, err)
	}
	if _, err := db.Admin.Exec(ctx, `DELETE FROM fishing.operator_audit`); err == nil {
		t.Fatal("audit mutable")
	}
}
