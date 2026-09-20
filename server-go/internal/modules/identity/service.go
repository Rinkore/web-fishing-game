// Package identity owns credentials, revocable sessions, bans and administrator MFA.
package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	mfaKey []byte
}

func New(pool *pgxpool.Pool, mfaKey []byte) *Service {
	return &Service{pool, append([]byte(nil), mfaKey...)}
}

type Registration struct {
	Username        string  `json:"username"`
	Password        string  `json:"password"`
	PasswordConfirm *string `json:"passwordConfirm"`
	Name            string  `json:"name"`
	QQ              string  `json:"qq"`
}
type Login struct {
	Username string `json:"username"`
	Password string `json:"password"`
	OTP      string `json:"otp"`
	Admin    bool   `json:"-"`
}
type Session struct {
	AccountID      int64
	Username, Name string
	Admin          bool
	Hash           [32]byte
}
type LoginResult struct {
	Session Session
	Token   string
}

var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]{3,20}$`)
var qqPattern = regexp.MustCompile(`^[0-9]{5,12}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func randomToken() (string, [32]byte, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", [32]byte{}, ErrBusy
	}
	token := base64.RawURLEncoding.EncodeToString(b[:])
	return token, sha256.Sum256([]byte(token)), nil
}
func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
func (s *Service) Register(ctx context.Context, in Registration) (LoginResult, error) {
	username := strings.TrimSpace(in.Username)
	qq := strings.TrimSpace(in.QQ)
	if !usernamePattern.MatchString(username) || !qqPattern.MatchString(qq) || !PasswordPolicy(in.Password, 8) || (in.PasswordConfirm != nil && *in.PasswordConfirm != in.Password) {
		return LoginResult{}, ErrInvalid
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = username
	}
	units := utf16.Encode([]rune(name))
	if len(units) > 20 {
		units = units[:20]
		if units[19] >= 0xd800 && units[19] <= 0xdbff {
			units = units[:19]
		}
	}
	name = string(utf16.Decode(units))
	username = strings.ToLower(username)
	hash, err := HashPassword(in.Password)
	if err != nil {
		return LoginResult{}, err
	}
	token, digest, err := randomToken()
	if err != nil {
		return LoginResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LoginResult{}, ErrStorage
	}
	defer rollback(tx)
	var id int64
	if err = tx.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&id); err != nil {
		return LoginResult{}, ErrStorage
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,$2,$3,$4,$5)`, id, username, name, qq, hash); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return LoginResult{}, ErrExists
		}
		return LoginResult{}, ErrStorage
	}
	if err = assets.InitializePlayer(ctx, tx, id); err != nil {
		return LoginResult{}, ErrStorage
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '24 hours')`, digest[:], id); err != nil {
		return LoginResult{}, ErrStorage
	}
	if err = tx.Commit(ctx); err != nil {
		return LoginResult{}, ErrCommitUnknown
	}
	return LoginResult{Session{id, username, name, false, digest}, token}, nil
}

// Attempt limits persist across process restarts and concurrent login workers.
func (s *Service) attempt(ctx context.Context, key string) ([32]byte, error) {
	digest := sha256.Sum256([]byte(key))
	var allowed bool
	err := s.pool.QueryRow(ctx, `INSERT INTO fishing.auth_attempts(key_hash,failures) VALUES($1,1)
 ON CONFLICT(key_hash) DO UPDATE SET failures=CASE WHEN fishing.auth_attempts.window_start<clock_timestamp()-interval '1 minute' THEN 1 ELSE fishing.auth_attempts.failures+1 END,
 window_start=CASE WHEN fishing.auth_attempts.window_start<clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE fishing.auth_attempts.window_start END
 RETURNING failures<=30 AND locked_until<=clock_timestamp()`, digest[:]).Scan(&allowed)
	if err != nil {
		return digest, ErrStorage
	}
	if !allowed {
		return digest, ErrBusy
	}
	return digest, nil
}
func (s *Service) fail(ctx context.Context, key [32]byte) error {
	_, err := s.pool.Exec(ctx, `UPDATE fishing.auth_attempts SET locked_until=CASE WHEN failures>=5 THEN clock_timestamp()+interval '5 minutes' ELSE locked_until END WHERE key_hash=$1`, key[:])
	if err != nil {
		return ErrStorage
	}
	return ErrCredentials
}
func (s *Service) Login(ctx context.Context, in Login) (LoginResult, error) {
	username := strings.ToLower(strings.TrimSpace(in.Username))
	if !usernamePattern.MatchString(username) || len(in.Password) > 1024 {
		return LoginResult{}, ErrCredentials
	}
	realm := "game:"
	if in.Admin {
		realm = "admin:"
	}
	attempt, err := s.attempt(ctx, realm+username)
	if err != nil {
		return LoginResult{}, err
	}
	var id int64
	var password, salt string
	err = s.pool.QueryRow(ctx, `SELECT account_id,password_hash,legacy_salt FROM fishing.identities WHERE username=$1`, username).Scan(&id, &password, &salt)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := derive(in.Password, "00000000000000000000000000000000"); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, s.fail(ctx, attempt)
	}
	if err != nil {
		return LoginResult{}, ErrStorage
	}
	valid, err := VerifyPassword(password, salt, in.Password)
	if err != nil {
		return LoginResult{}, err
	}
	if !valid {
		return LoginResult{}, s.fail(ctx, attempt)
	}
	upgrade := ""
	if !strings.HasPrefix(password, "scrypt$") {
		upgrade, err = HashPassword(in.Password)
		if err != nil {
			return LoginResult{}, err
		}
	}
	token, digest, err := randomToken()
	if err != nil {
		return LoginResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LoginResult{}, ErrStorage
	}
	defer rollback(tx)
	// All identity changes and asset writes serialize on the same player guard.
	if _, err = tx.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, id); err != nil {
		return LoginResult{}, ErrStorage
	}
	var current, name string
	var banned, admin bool
	var secret []byte
	var last int64
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT password_hash,display_name,banned,admin,mfa_secret,mfa_last_step,clock_timestamp() FROM fishing.identities WHERE account_id=$1`, id).Scan(&current, &name, &banned, &admin, &secret, &last, &now); err != nil {
		return LoginResult{}, ErrStorage
	}
	if current != password {
		return LoginResult{}, ErrCredentials
	}
	if banned {
		return LoginResult{}, ErrBanned
	}
	if in.Admin {
		if !admin {
			return LoginResult{}, ErrForbidden
		}
		plain, err := decryptMFA(s.mfaKey, id, secret)
		if err != nil {
			return LoginResult{}, ErrMFASetup
		}
		step, valid := verifyOTP(plain, in.OTP, now.Unix()/30, last)
		if !valid {
			rollback(tx)
			return LoginResult{}, s.fail(ctx, attempt)
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.identities SET mfa_last_step=$2 WHERE account_id=$1`, id, step); err != nil {
			return LoginResult{}, ErrStorage
		}
	}
	if upgrade != "" {
		if _, err = tx.Exec(ctx, `UPDATE fishing.identities SET password_hash=$2,legacy_salt='' WHERE account_id=$1`, id, upgrade); err != nil {
			return LoginResult{}, ErrStorage
		}
	}
	// Game login replaces game sessions; administrator cookies remain a distinct realm.
	if _, err = tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin=$2`, id, in.Admin); err != nil {
		return LoginResult{}, ErrStorage
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '24 hours')`, digest[:], id, in.Admin); err != nil {
		return LoginResult{}, ErrStorage
	}
	if !in.Admin {
		if _, err = tx.Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp() WHERE owner_id=$1`, id); err != nil {
			return LoginResult{}, ErrStorage
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM fishing.auth_attempts WHERE key_hash=$1`, attempt[:]); err != nil {
		return LoginResult{}, ErrStorage
	}
	if err = tx.Commit(ctx); err != nil {
		return LoginResult{}, ErrCommitUnknown
	}
	return LoginResult{Session{id, username, name, in.Admin, digest}, token}, nil
}
func (s *Service) Authenticate(ctx context.Context, token string, admin bool) (Session, error) {
	if !tokenPattern.MatchString(token) {
		return Session{}, ErrCredentials
	}
	h := sha256.Sum256([]byte(token))
	out := Session{Hash: h, Admin: admin}
	err := s.pool.QueryRow(ctx, `SELECT i.account_id,i.username,i.display_name FROM fishing.auth_sessions s JOIN fishing.identities i ON i.account_id=s.account_id WHERE s.token_hash=$1 AND s.admin=$2 AND s.expires_at>clock_timestamp() AND NOT i.banned AND (NOT s.admin OR i.admin)`, h[:], admin).Scan(&out.AccountID, &out.Username, &out.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrCredentials
	}
	if err != nil {
		return Session{}, ErrStorage
	}
	return out, nil
}
func (s *Service) Logout(ctx context.Context, session Session) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ErrStorage
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, session.AccountID); err != nil {
		return ErrStorage
	}
	tag, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE token_hash=$1 AND account_id=$2 AND admin=$3`, session.Hash[:], session.AccountID, session.Admin)
	if err != nil {
		return ErrStorage
	}
	if !session.Admin && tag.RowsAffected() > 0 {
		if _, err = tx.Exec(ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp() WHERE owner_id=$1`, session.AccountID); err != nil {
			return ErrStorage
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, session.AccountID); err != nil {
			return ErrStorage
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrCommitUnknown
	}
	return nil
}
