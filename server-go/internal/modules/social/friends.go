// Package social owns reciprocal relationships; every change locks both players.
package social

import (
	"context"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool   *pgxpool.Pool
	assets *assets.Service
}

func New(pool *pgxpool.Pool) *Service { return &Service{pool, assets.New(pool)} }

type FriendCommand struct {
	ActorID, TargetID  int64
	RequestKey, Action string
}

func (s *Service) Friend(ctx context.Context, r FriendCommand) (assets.Result, error) {
	if r.ActorID < 1 || r.TargetID < 1 || r.ActorID == r.TargetID {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.Action == "add" {
		r.Action = "request"
	}
	switch r.Action {
	case "request", "accept", "reject", "cancel", "remove":
	default:
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "friend_change", RuleVersion: "friends-v0.21.4", Players: []int64{r.ActorID, r.TargetID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		a, b := min(r.ActorID, r.TargetID), max(r.ActorID, r.TargetID)
		state := "none"
		var requester int64
		err := t.SQL().QueryRow(ctx, `SELECT state,requester_id FROM fishing.friend_relations WHERE a_id=$1 AND b_id=$2`, a, b).Scan(&state, &requester)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, err
		}
		next := "none"
		switch r.Action {
		case "request":
			if state == "accepted" || state == "pending" && requester == r.ActorID {
				return assets.Result{Status: state}, nil
			}
			if state == "pending" {
				return assets.Result{}, assets.Rejection("incoming_request_exists")
			}
			var count int
			if err := t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.friend_relations WHERE state='pending' AND requester_id=$1`, r.ActorID).Scan(&count); err != nil {
				return assets.Result{}, err
			}
			if count >= 50 {
				return assets.Result{}, assets.Rejection("friend_request_limit")
			}
			next, requester = "pending", r.ActorID
		case "accept":
			if state != "pending" || requester != r.TargetID {
				return assets.Result{}, assets.Rejection("friend_request_missing")
			}
			var ac, bc int
			if err := t.SQL().QueryRow(ctx, `SELECT count(*) FILTER(WHERE a_id=$1 OR b_id=$1),count(*) FILTER(WHERE a_id=$2 OR b_id=$2) FROM fishing.friend_relations WHERE state='accepted' AND (a_id IN ($1,$2) OR b_id IN ($1,$2))`, a, b).Scan(&ac, &bc); err != nil {
				return assets.Result{}, err
			}
			if ac >= 200 || bc >= 200 {
				return assets.Result{}, assets.Rejection("friend_limit")
			}
			next = "accepted"
		case "reject":
			if state != "pending" || requester != r.TargetID {
				return assets.Result{}, assets.Rejection("friend_request_missing")
			}
		case "cancel":
			if state != "pending" || requester != r.ActorID {
				return assets.Result{}, assets.Rejection("friend_request_missing")
			}
		case "remove":
			if state == "none" {
				return assets.Result{Status: "removed"}, nil
			}
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.friend_relations(a_id,b_id,requester_id,state,updated_operation) VALUES($1,$2,$3,$4,$5) ON CONFLICT(a_id,b_id) DO UPDATE SET requester_id=excluded.requester_id,state=excluded.state,updated_operation=excluded.updated_operation`, a, b, requester, next, t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		status := next
		if next == "none" {
			status = map[string]string{"reject": "rejected", "cancel": "cancelled", "remove": "removed"}[r.Action]
		}
		return assets.Result{Status: status}, nil
	})
}

type Relation struct {
	ID     int64  `json:"id,string"`
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

func (s *Service) Relations(ctx context.Context, owner, after int64, limit int) ([]Relation, error) {
	if owner < 1 || after < 0 || limit < 1 || limit > 100 {
		return nil, assets.ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `WITH relations AS (SELECT CASE WHEN a_id=$1 THEN b_id ELSE a_id END AS target,state,requester_id FROM fishing.friend_relations WHERE (a_id=$1 OR b_id=$1) AND state<>'none') SELECT target,CASE WHEN state='accepted' THEN 'friend' WHEN requester_id=$1 THEN 'out' ELSE 'in' END,COALESCE(i.display_name,''),COALESCE(c.expires_at>clock_timestamp(),false) FROM relations r LEFT JOIN fishing.identities i ON i.account_id=r.target LEFT JOIN fishing.fishing_connections c ON c.owner_id=r.target WHERE target>$2 ORDER BY target LIMIT $3`, owner, after, limit)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	out := []Relation{}
	for rows.Next() {
		var r Relation
		if err := rows.Scan(&r.ID, &r.Kind, &r.Name, &r.Online); err != nil {
			return nil, assets.ErrUnavailable
		}
		out = append(out, r)
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	return out, nil
}
