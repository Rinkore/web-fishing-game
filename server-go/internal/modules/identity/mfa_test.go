package identity

import (
	"context"
	"encoding/base32"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
)

// TestIntegrationNewMFASecretEnrollsAdministrator covers the console enrollment
// primitives: the minted secret is 20 random bytes in unpadded Base32, the
// otpauth link advertises exactly the parameters verifyOTP enforces, the sealed
// value round trips, and a secret issued this way logs the administrator in.
func TestIntegrationNewMFASecretEnrollsAdministrator(t *testing.T) {
	first, err := NewMFASecret()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(first)
	if err != nil || len(raw) != 20 || strings.Contains(first, "=") {
		t.Fatalf("secret encoding: %q %v", first, err)
	}
	if second, err := NewMFASecret(); err != nil || second == first {
		t.Fatalf("secret is not random: %q %v", second, err)
	}
	link := MFAAuthURL("DeepFish", "console_enroll", first)
	for _, want := range []string{"otpauth://totp/", "secret=" + first, "issuer=", "algorithm=SHA1", "digits=6", "period=30"} {
		if !strings.Contains(link, want) {
			t.Fatalf("otpauth link %q misses %q", link, want)
		}
	}

	db := testdb.New(t, true)
	key := make([]byte, 32)
	svc := New(db.App, key)
	ctx := context.Background()
	reg, err := svc.Register(ctx, Registration{Username: "console_enroll", Password: testPassword, Name: "Console", QQ: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := svc.SealMFA(reg.Session.AccountID, first)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := decryptMFA(key, reg.Session.AccountID, sealed)
	if err != nil || plain != first {
		t.Fatalf("sealed secret round trip: %q %v", plain, err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.identities SET admin=true,mfa_secret=$2,mfa_last_step=-1 WHERE account_id=$1`, reg.Session.AccountID, sealed); err != nil {
		t.Fatal(err)
	}
	var now time.Time
	if err := db.Admin.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	login, err := svc.Login(ctx, Login{Username: "console_enroll", Password: testPassword, Admin: true, OTP: totp(first, now.Unix()/30)})
	if err != nil {
		t.Fatal("console-issued secret cannot log in:", err)
	}
	if !login.Session.Admin {
		t.Fatal("console enrollment did not produce an administrator session")
	}
}
