package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

var ErrRegistrationChallenge = errors.New("registration proof required")

type RegistrationLimits struct {
	GlobalHourly   int64 `json:"globalHourly"`
	IPHourly       int64 `json:"ipHourly"`
	UsernameHourly int64 `json:"usernameHourly"`
}

func DefaultRegistrationLimits() RegistrationLimits { return RegistrationLimits{200, 10, 5} }

type RegistrationProof struct {
	ID    string `json:"id"`
	Nonce string `json:"nonce"`
}
type RegistrationChallenge struct {
	ID         string `json:"id"`
	Prefix     string `json:"prefix"`
	Difficulty int    `json:"difficulty"`
	ExpiresIn  int    `json:"expiresIn"`
}

func (in Registration) Valid() bool {
	return usernamePattern.MatchString(strings.TrimSpace(in.Username)) && qqPattern.MatchString(strings.TrimSpace(in.QQ)) &&
		PasswordPolicy(in.Password, 8) && (in.PasswordConfirm == nil || *in.PasswordConfirm == in.Password)
}

// takeRegistrationRate runs in a short transaction before password hashing.
// The global key is always acquired before source and username keys, so two
// gateways cannot grant the final quota twice or take these locks in reverse.
func takeRegistrationRate(ctx context.Context, tx pgx.Tx, key string, seconds, limit int64) (int64, bool, error) {
	digest := sha256.Sum256([]byte(key))
	var n int64
	err := tx.QueryRow(ctx, `INSERT INTO fishing.registration_limits(key_hash,expires_at,attempts)
 VALUES($1,clock_timestamp()+$2::bigint*interval '1 second',1)
 ON CONFLICT(key_hash) DO UPDATE SET
 attempts=CASE WHEN fishing.registration_limits.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(fishing.registration_limits.attempts+1,9007199254740992) END,
 window_start=CASE WHEN fishing.registration_limits.expires_at<=clock_timestamp() THEN clock_timestamp() ELSE fishing.registration_limits.window_start END,
 expires_at=CASE WHEN fishing.registration_limits.expires_at<=clock_timestamp() THEN clock_timestamp()+$2::bigint*interval '1 second' ELSE fishing.registration_limits.expires_at END
 RETURNING attempts`, digest[:], seconds).Scan(&n)
	return n, n <= limit, err
}

func registrationCommit(ctx context.Context, tx pgx.Tx, result error) error {
	if err := tx.Commit(ctx); err != nil {
		return ErrStorage
	}
	return result
}

// BeginRegistration counts valid attempts, including proof retries and duplicate
// names, just like the legacy policy. Rejections commit their rate usage; SQL
// failures roll back the usage and any proof deletion.
func (s *Service) BeginRegistration(ctx context.Context, source, username string, proof *RegistrationProof, limits RegistrationLimits) error {
	if source == "" || limits.GlobalHourly < 1 || limits.IPHourly < 1 || limits.UsernameHourly < 1 ||
		limits.GlobalHourly > 9007199254740991 || limits.IPHourly > 9007199254740991 || limits.UsernameHourly > 9007199254740991 {
		return ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ErrStorage
	}
	defer rollback(tx)
	var sourceAttempts int64
	for _, v := range []struct {
		key   string
		limit int64
	}{
		{"registration:global", limits.GlobalHourly}, {"registration:source:" + source, limits.IPHourly},
		{"registration:username:" + strings.ToLower(strings.TrimSpace(username)), limits.UsernameHourly},
	} {
		n, allowed, err := takeRegistrationRate(ctx, tx, v.key, 3600, v.limit)
		if err != nil {
			return ErrStorage
		}
		if !allowed {
			return registrationCommit(ctx, tx, ErrBusy)
		}
		if v.key == "registration:global" && n == 1 {
			if err := pruneRegistrationRates(ctx, tx); err != nil {
				return ErrStorage
			}
		}
		if v.key == "registration:source:"+source {
			sourceAttempts = n
		}
	}
	if sourceAttempts > 3 {
		ok, err := consumeRegistrationProof(ctx, tx, source, proof)
		if err != nil {
			return ErrStorage
		}
		if !ok {
			return registrationCommit(ctx, tx, ErrRegistrationChallenge)
		}
	}
	return registrationCommit(ctx, tx, nil)
}

func (s *Service) IssueRegistrationChallenge(ctx context.Context, source string) (RegistrationChallenge, error) {
	var out RegistrationChallenge
	if source == "" {
		return out, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, ErrStorage
	}
	defer rollback(tx)
	for _, v := range []struct {
		key   string
		limit int64
	}{
		{"registration:challenge:global", 600}, {"registration:challenge:source:" + source, 20},
	} {
		_, allowed, err := takeRegistrationRate(ctx, tx, v.key, 60, v.limit)
		if err != nil {
			return out, ErrStorage
		}
		if !allowed {
			return out, registrationCommit(ctx, tx, ErrBusy)
		}
	}
	if _, err := tx.Exec(ctx, `WITH expired AS (SELECT id FROM fishing.registration_challenges WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 5000 FOR UPDATE SKIP LOCKED)
 DELETE FROM fishing.registration_challenges c USING expired e WHERE c.id=e.id`); err != nil {
		return out, ErrStorage
	}
	if err := pruneRegistrationRates(ctx, tx); err != nil {
		return out, ErrStorage
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM fishing.registration_challenges`).Scan(&count); err != nil {
		return out, ErrStorage
	}
	if count >= 5000 {
		return out, registrationCommit(ctx, tx, ErrBusy)
	}
	var id [20]byte
	var prefix [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return out, ErrStorage
	}
	if _, err := rand.Read(prefix[:]); err != nil {
		return out, ErrStorage
	}
	out = RegistrationChallenge{hex.EncodeToString(id[:]), hex.EncodeToString(prefix[:]), 4, 120}
	sourceHash := sha256.Sum256([]byte(source))
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.registration_challenges(id,prefix,source_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '120 seconds')`, out.ID, out.Prefix, sourceHash[:]); err != nil {
		return RegistrationChallenge{}, ErrStorage
	}
	if err := tx.Commit(ctx); err != nil {
		return RegistrationChallenge{}, ErrStorage
	}
	return out, nil
}

var registrationID = regexp.MustCompile(`^[0-9a-f]{40}$`)
var registrationNonce = regexp.MustCompile(`^[0-9]{1,12}$`)

func pruneRegistrationRates(ctx context.Context, tx pgx.Tx) error {
	// Never wait for an admission's partially acquired rate locks. This also
	// avoids taking them in a different order while pruning old source keys.
	_, err := tx.Exec(ctx, `WITH expired AS (SELECT key_hash FROM fishing.registration_limits WHERE expires_at<clock_timestamp()-interval '1 hour' ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
 DELETE FROM fishing.registration_limits r USING expired e WHERE r.key_hash=e.key_hash`)
	return err
}

func consumeRegistrationProof(ctx context.Context, tx pgx.Tx, source string, proof *RegistrationProof) (bool, error) {
	if proof == nil || !registrationID.MatchString(proof.ID) || !registrationNonce.MatchString(proof.Nonce) {
		return false, nil
	}
	var expected []byte
	var prefix string
	var valid bool
	err := tx.QueryRow(ctx, `DELETE FROM fishing.registration_challenges WHERE id=$1 RETURNING source_hash,prefix,expires_at>clock_timestamp()`, proof.ID).Scan(&expected, &prefix, &valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	sourceHash := sha256.Sum256([]byte(source))
	if !valid || string(expected) != string(sourceHash[:]) {
		return false, nil
	}
	digest := sha256.Sum256([]byte(prefix + ":" + proof.Nonce))
	return digest[0] == 0 && digest[1] == 0, nil
}
