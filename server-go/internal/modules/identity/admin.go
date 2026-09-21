package identity

import (
	"context"
	"log/slog"
	"time"
)

// Operator console ban projection.
//
// identities.banned stays the single "currently banned" flag that every module
// already checks, so a timed ban only adds a deadline: this projection reports
// the legacy shape (banned/permanent/until/remainMs) and RunBanExpiry clears the
// flag once the deadline passes. The original computed the state on the fly and
// never persisted the flag, which is why an expired ban can read as "not
// banned" for up to one sweep interval.
type BanState struct {
	Banned    bool   `json:"banned"`
	Permanent bool   `json:"permanent"`
	Until     int64  `json:"until"`
	RemainMS  int64  `json:"remainMs"`
	Reason    string `json:"reason"`
	By        string `json:"banBy"`
	At        int64  `json:"banAt"`
}

// BanStateOf mirrors the original banInfoOf(): a timed ban in the past reports
// the empty state, a ban without a deadline is permanent.
func BanStateOf(banned bool, until *time.Time, reason, by string, at *time.Time) BanState {
	state := BanState{}
	if at != nil {
		state.At = at.UnixMilli()
	}
	if !banned {
		return state
	}
	if until == nil {
		state.Banned, state.Permanent, state.Reason, state.By = true, true, reason, by
		return state
	}
	remain := until.UnixMilli() - time.Now().UnixMilli()
	if remain <= 0 {
		return BanState{At: state.At}
	}
	state.Banned, state.Until, state.RemainMS, state.Reason, state.By = true, until.UnixMilli(), remain, reason, by
	return state
}

type Lockout struct {
	User     string `json:"user"`
	IP       string `json:"ip"`
	RemainMS int64  `json:"remainMs"`
}

// Lockouts projects the login failure guard for the console security panel. The
// Go gateway keys its attempt guard by realm+username only, so the original
// per-source-IP column has no value to report.
func (s *Service) Lockouts(ctx context.Context) ([]Lockout, error) {
	rows, err := s.pool.Query(ctx, `SELECT username,(extract(epoch FROM locked_until-clock_timestamp())*1000)::bigint
 FROM fishing.auth_attempts WHERE locked_until>clock_timestamp() AND failures>=5 ORDER BY locked_until DESC LIMIT 200`)
	if err != nil {
		return nil, ErrStorage
	}
	defer rows.Close()
	out := []Lockout{}
	for rows.Next() {
		var lock Lockout
		if err := rows.Scan(&lock.User, &lock.RemainMS); err != nil {
			return nil, ErrStorage
		}
		if lock.RemainMS < 0 {
			lock.RemainMS = 0
		}
		out = append(out, lock)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStorage
	}
	return out, nil
}

// ExpireBans clears timed bans whose deadline passed. Bans are the only reason
// a session is deleted outside logout, so every other module can keep reading
// the plain banned flag.
func (s *Service) ExpireBans(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE fishing.identities
 SET banned=false,ban_until=NULL,ban_reason='',ban_by='',ban_at=NULL,updated_at=clock_timestamp()
 WHERE banned AND ban_until IS NOT NULL AND ban_until<=clock_timestamp()`)
	if err != nil {
		return 0, ErrStorage
	}
	return tag.RowsAffected(), nil
}

// RunBanExpiry keeps the banned flag honest for timed bans.
func (s *Service) RunBanExpiry(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := s.ExpireBans(work)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Error("ban_expiry_failed", "error", err.Error())
		}
	}
}
