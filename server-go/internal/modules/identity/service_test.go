package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/testdb"
)

const testPassword = "synthetic-test-Pass42"

func TestPasswordCompatibility(t *testing.T) {
	// Test-only legacy server crypto.scrypt vector (salt is ASCII hex, not decoded bytes).
	const salt = "000102030405060708090a0b0c0d0e0f"
	vector, err := VerifyPassword("scrypt$v1$"+salt+"$a4456d296d0b62297fabd952a5fa151d2080c8c05eff33f57fa79d9d43ffa514", "", testPassword)
	if err != nil || !vector {
		t.Fatal("legacy server scrypt vector mismatch")
	}
	hash, err := HashPassword(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := VerifyPassword(hash, "", testPassword)
	if err != nil || !ok {
		t.Fatal("scrypt verification")
	}
	ok, err = VerifyPassword(hash, "", "wrong")
	if err != nil || ok {
		t.Fatal("accepted wrong password")
	}
	old := sha256.Sum256([]byte(salt + ":" + testPassword))
	ok, err = VerifyPassword(hex.EncodeToString(old[:]), salt, testPassword)
	if err != nil || !ok {
		t.Fatal("legacy hash compatibility")
	}
	for _, p := range []string{"password1234", "aaaaaaaa", "short"} {
		if PasswordPolicy(p, 8) {
			t.Fatal("weak password accepted")
		}
	}
}
func TestMFAReplayAndEncryption(t *testing.T) {
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	if totp(secret, 1) != "287082" {
		t.Fatal("RFC4226 vector")
	}
	if _, ok := verifyOTP(secret, "287082", 1, 1); ok {
		t.Fatal("OTP replay")
	}
	key := make([]byte, 32)
	sealed, err := EncryptMFA(key, 5, secret)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptMFA(key, 6, sealed); err == nil {
		t.Fatal("MFA ciphertext not bound to account")
	}
	plain, err := decryptMFA(key, 5, sealed)
	if err != nil || plain != secret {
		t.Fatal("MFA round trip")
	}
}
func TestIntegrationIdentityAndAssetFence(t *testing.T) {
	db := testdb.New(t, true)
	svc := New(db.App, make([]byte, 32))
	ctx := context.Background()
	reg, err := svc.Register(ctx, Registration{Username: "Test_User", Password: testPassword, Name: "Test", QQ: "123456"})
	if err != nil {
		t.Fatal(err)
	}
	var coins, sum, count int64
	if err := db.Admin.QueryRow(ctx, `SELECT w.coins,(SELECT sum(delta) FROM fishing.asset_entries WHERE account_id=w.account_id),(SELECT count(*) FROM fishing.outbox_events) FROM fishing.wallets w WHERE account_id=$1`, reg.Session.AccountID).Scan(&coins, &sum, &count); err != nil || coins != 500 || sum != 500 || count != 1 {
		t.Fatal("registration grant not atomic")
	}
	if _, err := svc.Register(ctx, Registration{Username: "TEST_USER", Password: testPassword, QQ: "123456"}); !errors.Is(err, ErrExists) {
		t.Fatal("case-insensitive duplicate accepted")
	}
	if _, err := svc.Authenticate(ctx, reg.Token, true); !errors.Is(err, ErrCredentials) {
		t.Fatal("game session elevated to admin")
	}
	login, err := svc.Login(ctx, Login{Username: "TEST_USER", Password: testPassword})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, reg.Token, false); !errors.Is(err, ErrCredentials) {
		t.Fatal("old login still valid")
	}
	proof := assets.WithSession(ctx, login.Session.AccountID, login.Session.Hash, false)
	if err := svc.Logout(ctx, login.Session); err != nil {
		t.Fatal(err)
	}
	result, err := assets.New(db.App).ApplyChange(proof, assets.Change{ActorID: login.Session.AccountID, RequestKey: "stale-auth", Reason: "reward", RuleVersion: "test-v1", Coins: 1})
	if !errors.Is(err, assets.ErrUnauthenticated) {
		t.Fatalf("revoked request wrote assets: %s %v", result.Status, err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.command_results WHERE request_key='stale-auth'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("revoked command cached")
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.identities SET banned=true WHERE account_id=$1`, login.Session.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Login(ctx, Login{Username: "test_user", Password: testPassword}); !errors.Is(err, ErrBanned) {
		t.Fatal("banned account logged in")
	}
}
func TestIntegrationConcurrentRegistrationAndMFA(t *testing.T) {
	db := testdb.New(t, true)
	key := make([]byte, 32)
	svc := New(db.App, key)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.Register(ctx, Registration{Username: "same_account", Password: testPassword, QQ: "123456"})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, exists := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrExists) {
			exists++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || exists != 1 {
		t.Fatal("registration race")
	}
	var id int64
	if err := db.Admin.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username='same_account'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	sealed, _ := EncryptMFA(key, id, secret)
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.identities SET admin=true,mfa_secret=$2 WHERE account_id=$1`, id, sealed); err != nil {
		t.Fatal(err)
	}
	var now time.Time
	if err := db.Admin.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	otp := totp(secret, now.Unix()/30)
	login, err := svc.Login(ctx, Login{Username: "same_account", Password: testPassword, Admin: true, OTP: otp})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, login.Token, false); !errors.Is(err, ErrCredentials) {
		t.Fatal("admin session accepted as game")
	}
	if _, err := svc.Login(ctx, Login{Username: "same_account", Password: testPassword, Admin: true, OTP: otp}); !errors.Is(err, ErrCredentials) {
		t.Fatal("OTP replay accepted")
	}
}
