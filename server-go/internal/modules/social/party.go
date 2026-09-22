package social

import (
	"context"
	"encoding/json"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/sea"
	"github.com/jackc/pgx/v5"
	"sort"
	"strconv"
)

type PartyCommand struct {
	ActorID, TargetID, PartyID int64
	RequestKey, Action         string
}
type Party struct {
	ID       int64    `json:"id,string"`
	LeaderID int64    `json:"leaderId,string"`
	Revision int64    `json:"revision,string"`
	Members  []string `json:"members"`
}

func partyOf(ctx context.Context, q assets.SQL, owner int64) (Party, error) {
	var p Party
	var members []int64
	err := q.QueryRow(ctx, `SELECT p.id,p.leader_id,p.revision,ARRAY(SELECT m.owner_id FROM fishing.party_members m WHERE m.party_id=p.id ORDER BY m.joined_revision,m.owner_id) FROM fishing.party_members mine JOIN fishing.parties p ON p.id=mine.party_id WHERE mine.owner_id=$1 AND p.active`, owner).Scan(&p.ID, &p.LeaderID, &p.Revision, &members)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	p.Members = []string{}
	for _, id := range members {
		p.Members = append(p.Members, strconv.FormatInt(id, 10))
	}
	return p, nil
}
func (s *Service) PartyView(ctx context.Context, owner int64) (map[string]any, error) {
	if owner < 1 {
		return nil, assets.ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer tx.Rollback(ctx)
	p, err := partyOf(ctx, tx, owner)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	var invite int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT i.party_id FROM fishing.party_invites i JOIN fishing.parties p ON p.id=i.party_id WHERE i.target_id=$1 AND p.active),0)`, owner).Scan(&invite); err != nil {
		return nil, assets.ErrUnavailable
	}
	zones, err := sea.MemberZones(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	return map[string]any{"party": p, "invitedPartyId": strconv.FormatInt(invite, 10), "max": 4, "memberZones": zones}, nil
}
func memberIDs(p Party) []int64 {
	out := []int64{}
	for _, id := range p.Members {
		n, _ := strconv.ParseInt(id, 10, 64)
		out = append(out, n)
	}
	return out
}
func leaveParty(ctx context.Context, t *assets.Transaction, p Party, owner int64) error {
	if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.party_members WHERE owner_id=$1 AND party_id=$2`, owner, p.ID); err != nil {
		return err
	}
	var next int64
	if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT owner_id FROM fishing.party_members WHERE party_id=$1 ORDER BY joined_revision,owner_id LIMIT 1),0)`, p.ID).Scan(&next); err != nil {
		return err
	}
	if next == 0 {
		_, err := t.SQL().Exec(ctx, `UPDATE fishing.parties SET active=false,revision=revision+1 WHERE id=$1`, p.ID)
		return err
	}
	_, err := t.SQL().Exec(ctx, `UPDATE fishing.parties SET leader_id=CASE WHEN leader_id=$2 THEN $3::bigint ELSE leader_id END,revision=revision+1 WHERE id=$1`, p.ID, owner, next)
	return err
}
func (s *Service) Party(ctx context.Context, r PartyCommand) (assets.Result, error) {
	players := []int64{r.ActorID}
	if r.ActorID < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	switch r.Action {
	case "invite", "kick":
		if r.TargetID < 1 || r.TargetID == r.ActorID {
			return assets.Result{}, assets.ErrInvalid
		}
		players = append(players, r.TargetID)
	case "create", "leave", "disband", "decline":
		if r.TargetID != 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	case "accept":
		if r.PartyID < 1 || r.TargetID != 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	default:
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "party_change", RuleVersion: "party-v0.21.4-atomic-switch", Players: players, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if r.Action == "create" || r.Action == "invite" || r.Action == "accept" {
			if err := t.RequireFeature(ctx, "party"); err != nil {
				return assets.Result{}, err
			}
		}
		// Always after player guards. No further player guards/asset writes are acquired.
		var revision int64
		if err := t.SQL().QueryRow(ctx, `UPDATE fishing.party_guard SET revision=revision+1 WHERE singleton RETURNING revision`).Scan(&revision); err != nil {
			return assets.Result{}, err
		}
		p, err := partyOf(ctx, t.SQL(), r.ActorID)
		if err != nil {
			return assets.Result{}, err
		}
		recipients := append([]int64{r.ActorID}, memberIDs(p)...)
		status := ""
		switch r.Action {
		case "create":
			if p.ID != 0 {
				return assets.Result{}, assets.Rejection("already_in_party")
			}
			if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.parties(leader_id,created_operation) VALUES($1,$2) RETURNING id`, r.ActorID, t.OperationID()).Scan(&p.ID); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.party_members(owner_id,party_id,joined_operation,joined_revision) VALUES($1,$2,$3,$4)`, r.ActorID, p.ID, t.OperationID(), revision); err != nil {
				return assets.Result{}, err
			}
			status = "created"
		case "invite":
			if p.ID == 0 {
				return assets.Result{}, assets.Rejection("party_missing")
			}
			if p.LeaderID != r.ActorID {
				return assets.Result{}, assets.Rejection("party_leader_required")
			}
			if len(p.Members) >= 4 {
				return assets.Result{}, assets.Rejection("party_full")
			}
			var friends bool
			if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.friend_relations WHERE a_id=LEAST($1::bigint,$2::bigint) AND b_id=GREATEST($1::bigint,$2::bigint) AND state='accepted')`, r.ActorID, r.TargetID).Scan(&friends); err != nil {
				return assets.Result{}, err
			}
			if !friends {
				return assets.Result{}, assets.Rejection("party_friend_required")
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.party_invites(target_id,party_id,operation_id,issued_revision) VALUES($1,$2,$3,$4) ON CONFLICT(target_id) DO UPDATE SET party_id=excluded.party_id,operation_id=excluded.operation_id,issued_revision=excluded.issued_revision`, r.TargetID, p.ID, t.OperationID(), revision); err != nil {
				return assets.Result{}, err
			}
			if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.party_invites WHERE party_id=$1 AND target_id IN (SELECT target_id FROM fishing.party_invites WHERE party_id=$1 ORDER BY issued_revision DESC,target_id DESC OFFSET 50)`, p.ID); err != nil {
				return assets.Result{}, err
			}
			recipients = append(recipients, r.TargetID)
			status = "invited"
		case "accept":
			var leader int64
			var count int
			err := t.SQL().QueryRow(ctx, `SELECT p.leader_id,(SELECT count(*) FROM fishing.party_members WHERE party_id=p.id) FROM fishing.party_invites i JOIN fishing.parties p ON p.id=i.party_id WHERE i.target_id=$1 AND p.id=$2 AND p.active`, r.ActorID, r.PartyID).Scan(&leader, &count)
			if errors.Is(err, pgx.ErrNoRows) {
				return assets.Result{}, assets.Rejection("party_invite_missing")
			}
			if err != nil {
				return assets.Result{}, err
			}
			if p.ID != r.PartyID {
				// User-approved compatibility correction: reject before leaving the old party.
				if count >= 4 {
					return assets.Result{}, assets.Rejection("party_full")
				}
				other, err := partyOf(ctx, t.SQL(), leader)
				if err != nil {
					return assets.Result{}, err
				}
				recipients = append(recipients, memberIDs(other)...)
				if p.ID != 0 {
					if err := leaveParty(ctx, t, p, r.ActorID); err != nil {
						return assets.Result{}, err
					}
				}
				if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.party_members(owner_id,party_id,joined_operation,joined_revision) VALUES($1,$2,$3,$4)`, r.ActorID, r.PartyID, t.OperationID(), revision); err != nil {
					return assets.Result{}, err
				}
				if _, err := t.SQL().Exec(ctx, `UPDATE fishing.parties SET revision=revision+1 WHERE id=$1`, r.PartyID); err != nil {
					return assets.Result{}, err
				}
			}
			if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.party_invites WHERE target_id=$1`, r.ActorID); err != nil {
				return assets.Result{}, err
			}
			status = "accepted"
		case "decline":
			var leader int64
			if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT p.leader_id FROM fishing.party_invites i JOIN fishing.parties p ON p.id=i.party_id WHERE i.target_id=$1 AND p.active),0)`, r.ActorID).Scan(&leader); err != nil {
				return assets.Result{}, err
			}
			if leader > 0 {
				recipients = append(recipients, leader)
			}
			if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.party_invites WHERE target_id=$1`, r.ActorID); err != nil {
				return assets.Result{}, err
			}
			status = "declined"
		case "leave", "kick", "disband":
			if p.ID == 0 {
				return assets.Result{}, assets.Rejection("party_missing")
			}
			if r.Action != "leave" && p.LeaderID != r.ActorID {
				return assets.Result{}, assets.Rejection("party_leader_required")
			}
			if r.Action == "disband" {
				if _, err := t.SQL().Exec(ctx, `DELETE FROM fishing.party_members WHERE party_id=$1`, p.ID); err != nil {
					return assets.Result{}, err
				}
				if _, err := t.SQL().Exec(ctx, `UPDATE fishing.parties SET active=false,revision=revision+1 WHERE id=$1`, p.ID); err != nil {
					return assets.Result{}, err
				}
				status = "disbanded"
			} else {
				owner := r.ActorID
				if r.Action == "kick" {
					owner = r.TargetID
					found := false
					for _, id := range memberIDs(p) {
						if id == owner {
							found = true
						}
					}
					if !found {
						return assets.Result{}, assets.Rejection("party_member_missing")
					}
				}
				if err := leaveParty(ctx, t, p, owner); err != nil {
					return assets.Result{}, err
				}
				status = map[string]string{"kick": "kicked", "leave": "left"}[r.Action]
			}
		}
		unique := map[int64]bool{}
		for _, id := range recipients {
			unique[id] = true
		}
		recipients = recipients[:0]
		for id := range unique {
			recipients = append(recipients, id)
		}
		sort.Slice(recipients, func(i, j int) bool { return recipients[i] < recipients[j] })
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.party_events(operation_id,recipients,action,revision) VALUES($1,$2,$3,$4)`, t.OperationID(), recipients, r.Action, revision); err != nil {
			return assets.Result{}, err
		}
		current, err := partyOf(ctx, t.SQL(), r.ActorID)
		if err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(current)
		return assets.Result{Status: status, Details: details}, nil
	})
}
