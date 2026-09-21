package identity

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"fishing.local/server/internal/testdb"
	"github.com/jackc/pgx/v5"
)

func solveRegistration(c RegistrationChallenge) *RegistrationProof {
	for n := 0; ; n++ {
		nonce := strconv.Itoa(n)
		digest := sha256.Sum256([]byte(c.Prefix + ":" + nonce))
		if digest[0] == 0 && digest[1] == 0 {
			return &RegistrationProof{c.ID, nonce}
		}
	}
}

func TestIntegrationRegistrationProofPersistenceAndAtomicity(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	s := New(db.App, nil)
	limits := RegistrationLimits{1000, 100, 100}
	for i := range 3 {
		if err := s.BeginRegistration(ctx, "192.0.2.1", fmt.Sprint("new", i), nil, limits); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.BeginRegistration(ctx, "192.0.2.1", "new3", nil, limits); !errors.Is(err, ErrRegistrationChallenge) {
		t.Fatalf("fourth: %v", err)
	}
	c, err := s.IssueRegistrationChallenge(ctx, "192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	proof := solveRegistration(c)
	results := make(chan error, 2)
	for i := range 2 {
		go func() {
			results <- New(db.App, nil).BeginRegistration(ctx, "192.0.2.1", fmt.Sprint("race", i), proof, limits)
		}()
	}
	accepted, challenged := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			accepted++
		} else if errors.Is(err, ErrRegistrationChallenge) {
			challenged++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 1 || challenged != 1 {
		t.Fatalf("proof reused: %d %d", accepted, challenged)
	}
	if err := New(db.App, nil).BeginRegistration(ctx, "192.0.2.1", "restarted", proof, limits); !errors.Is(err, ErrRegistrationChallenge) {
		t.Fatalf("new service replay: %v", err)
	}

	for _, kind := range []string{"wrong_source", "expired", "bad_nonce"} {
		c, err := s.IssueRegistrationChallenge(ctx, "192.0.2.1")
		if err != nil {
			t.Fatal(err)
		}
		proof := solveRegistration(c)
		source := "192.0.2.1"
		switch kind {
		case "wrong_source":
			source = "192.0.2.2"
			for i := range 3 {
				if err := s.BeginRegistration(ctx, source, fmt.Sprint("other", i), nil, limits); err != nil {
					t.Fatal(err)
				}
			}
		case "expired":
			if _, err := db.Admin.Exec(ctx, `UPDATE fishing.registration_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, c.ID); err != nil {
				t.Fatal(err)
			}
		case "bad_nonce":
			for n := 0; ; n++ {
				proof.Nonce = strconv.Itoa(n)
				d := sha256.Sum256([]byte(c.Prefix + ":" + proof.Nonce))
				if d[0] != 0 || d[1] != 0 {
					break
				}
			}
		}
		if err := s.BeginRegistration(ctx, source, kind, proof, limits); !errors.Is(err, ErrRegistrationChallenge) {
			t.Fatalf("%s accepted: %v", kind, err)
		}
		var count int
		if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.registration_challenges WHERE id=$1`, c.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected proof remained reusable: %d %v", count, err)
		}
	}

	c, err = s.IssueRegistrationChallenge(ctx, "192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	proof = solveRegistration(c)
	role := pgx.Identifier{db.Role}.Sanitize()
	if _, err := db.Admin.Exec(ctx, "REVOKE DELETE ON fishing.registration_challenges FROM "+role); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginRegistration(ctx, "192.0.2.1", "retry", proof, limits); !errors.Is(err, ErrStorage) {
		t.Fatalf("expected injected error: %v", err)
	}
	if _, err := db.Admin.Exec(ctx, "GRANT DELETE ON fishing.registration_challenges TO "+role); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginRegistration(ctx, "192.0.2.1", "retry", proof, limits); err != nil {
		t.Fatalf("proof lost on storage rollback: %v", err)
	}
}

func TestIntegrationRegistrationQuotaWindows(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	s := New(db.App, nil)
	limits := DefaultRegistrationLimits()
	for i := range 11 {
		err := s.BeginRegistration(ctx, "192.0.2.1", fmt.Sprint("name", i), nil, limits)
		if i < 3 && err != nil || i >= 3 && i < 10 && !errors.Is(err, ErrRegistrationChallenge) || i == 10 && !errors.Is(err, ErrBusy) {
			t.Fatalf("source limit attempt %d: %v", i+1, err)
		}
	}
	for i := range 6 {
		err := s.BeginRegistration(ctx, fmt.Sprint("name-source", i), "same_name", nil, limits)
		if i < 5 && err != nil || i == 5 && !errors.Is(err, ErrBusy) {
			t.Fatalf("username limit %d: %v", i, err)
		}
	}
	// A new hour resets quotas. Competing gateways cannot both take the last
	// globally available slot, even for different sources and names.
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.registration_limits SET expires_at=clock_timestamp()-interval '2 hours'`); err != nil {
		t.Fatal(err)
	}
	limits.GlobalHourly = 1
	results := make(chan error, 2)
	for i := range 2 {
		go func() {
			results <- New(db.App, nil).BeginRegistration(ctx, fmt.Sprint("global-source", i), fmt.Sprint("global-name", i), nil, limits)
		}()
	}
	accepted, limited := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			accepted++
		} else if errors.Is(err, ErrBusy) {
			limited++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 1 || limited != 1 {
		t.Fatalf("global oversubscribed: %d %d", accepted, limited)
	}
	for i := range 21 {
		_, err := s.IssueRegistrationChallenge(ctx, "192.0.2.20")
		if i < 20 && err != nil || i == 20 && !errors.Is(err, ErrBusy) {
			t.Fatalf("challenge quota %d: %v", i, err)
		}
	}
}
