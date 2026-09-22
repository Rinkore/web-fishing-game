package assets

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

var ErrUnauthenticated = errors.New("asset session expired")

type authContextKey struct{}
type authProof struct {
	actor int64
	hash  [32]byte
	admin bool
}

// WithSession is for authenticated transports only. Internal workers have no
// client session. Every write checks the proof again under the player guard.
func WithSession(ctx context.Context, actor int64, hash [32]byte, admin bool) context.Context {
	return context.WithValue(ctx, authContextKey{}, authProof{actor, hash, admin})
}

// RequireAdmin rejects missing and player-realm proofs. Run additionally
// revalidates the proof against current database state while holding the guard.
func RequireAdmin(ctx context.Context, actor int64) error {
	p, ok := ctx.Value(authContextKey{}).(authProof)
	if !ok || p.actor != actor || !p.admin {
		return ErrUnauthenticated
	}
	return nil
}
func checkSession(ctx context.Context, tx pgx.Tx, actor int64) error {
	p, ok := ctx.Value(authContextKey{}).(authProof)
	if !ok {
		return nil
	}
	if p.actor != actor {
		return ErrUnauthenticated
	}
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.auth_sessions s JOIN fishing.identities i ON i.account_id=s.account_id WHERE s.token_hash=$1 AND s.account_id=$2 AND s.admin=$3 AND s.expires_at>clock_timestamp() AND NOT i.banned AND (NOT s.admin OR i.admin))`, p.hash[:], actor, p.admin).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrUnauthenticated
	}
	return nil
}
