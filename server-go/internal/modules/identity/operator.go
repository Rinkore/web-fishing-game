package identity

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
	"time"
)

// ProvisionAdmin is deliberately absent from HTTP. It requires the operator
// database role, an enrolled authenticator secret and proof of possession.
// Audit data contains only the action and account ID, never credentials.
func ProvisionAdmin(ctx context.Context, pool *pgxpool.Pool, key []byte, username, secret, otp string) error {
	username = strings.ToLower(strings.TrimSpace(username))
	secret = strings.ToUpper(strings.TrimRight(strings.TrimSpace(secret), "="))
	if username == "" || len(username) > 20 || len(secret) > 128 {
		return ErrInvalid
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ErrStorage
	}
	defer rollback(tx)
	var id int64
	if err := tx.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1`, username).Scan(&id); err != nil {
		return ErrInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, id); err != nil {
		return ErrStorage
	}
	var banned bool
	var now time.Time
	var existing []byte
	var last int64
	if err := tx.QueryRow(ctx, `SELECT banned,clock_timestamp(),mfa_secret,mfa_last_step FROM fishing.identities WHERE account_id=$1`, id).Scan(&banned, &now, &existing, &last); err != nil {
		return ErrStorage
	}
	if banned {
		return ErrBanned
	}
	// Re-provisioning the same secret must not reset its replay guard.
	previous, err := decryptMFA(key, id, existing)
	if err != nil || previous != secret {
		last = -1
	}
	step, valid := verifyOTP(secret, otp, now.Unix()/30, last)
	if !valid {
		return ErrCredentials
	}
	sealed, err := EncryptMFA(key, id, secret)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET admin=true,mfa_secret=$2,mfa_last_step=$3,updated_at=clock_timestamp() WHERE account_id=$1`, id, sealed, step); err != nil {
		return ErrStorage
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin`, id); err != nil {
		return ErrStorage
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.operator_audit(action,account_id) VALUES('admin_mfa_provision',$1)`, id); err != nil {
		return ErrStorage
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrCommitUnknown
	}
	return nil
}
func RevokeAdmin(ctx context.Context, pool *pgxpool.Pool, username string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return ErrStorage
	}
	defer rollback(tx)
	var id int64
	if err := tx.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1`, strings.ToLower(strings.TrimSpace(username))).Scan(&id); err != nil {
		return ErrInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, id); err != nil {
		return ErrStorage
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.identities SET admin=false,mfa_secret=NULL,mfa_last_step=-1,updated_at=clock_timestamp() WHERE account_id=$1`, id); err != nil {
		return ErrStorage
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin`, id); err != nil {
		return ErrStorage
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.operator_audit(action,account_id) VALUES('admin_revoke',$1)`, id); err != nil {
		return ErrStorage
	}
	if err := tx.Commit(ctx); err != nil {
		return ErrCommitUnknown
	}
	return nil
}
