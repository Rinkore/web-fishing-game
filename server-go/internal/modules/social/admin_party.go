package social

import (
	"context"
	"errors"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
)

// AdminDisband shares the topology guard with player membership changes and
// fishing permission checks; it never acquires member asset guards afterwards.
func (s *Service) AdminDisband(ctx context.Context, actor, party int64, key string, expected *int64) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, actor); err != nil {
		return assets.Result{}, err
	}
	if party < 1 || expected != nil && *expected < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	input := struct {
		Party    int64
		Expected *int64
	}{party, expected}
	return s.assets.Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "party_change", RuleVersion: "admin-party-v1", Players: []int64{actor}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var revision int64
		if err := t.SQL().QueryRow(ctx, `UPDATE fishing.party_guard SET revision=revision+1 WHERE singleton RETURNING revision`).Scan(&revision); err != nil {
			return assets.Result{}, err
		}
		var current int64
		err := t.SQL().QueryRow(ctx, `SELECT revision FROM fishing.parties WHERE id=$1 AND active`, party).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("party_missing")
		}
		if err != nil {
			return assets.Result{}, err
		}
		if expected != nil && *expected != current {
			return assets.Result{}, assets.Rejection("party_revision_changed")
		}
		var recipients []int64
		if err := t.SQL().QueryRow(ctx, `SELECT ARRAY(SELECT owner_id FROM fishing.party_members WHERE party_id=$1 UNION SELECT target_id FROM fishing.party_invites WHERE party_id=$1 ORDER BY 1)`, party).Scan(&recipients); err != nil {
			return assets.Result{}, err
		}
		for _, query := range []string{`DELETE FROM fishing.party_members WHERE party_id=$1`, `DELETE FROM fishing.party_invites WHERE party_id=$1`, `UPDATE fishing.parties SET active=false,revision=revision+1 WHERE id=$1`} {
			if _, err := t.SQL().Exec(ctx, query, party); err != nil {
				return assets.Result{}, err
			}
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.party_events(operation_id,recipients,action,revision) VALUES($1,$2,'admin_disband',$3)`, t.OperationID(), recipients, revision); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,action,target,detail)
 SELECT account_id,display_name,'party/disband',$2,$3 FROM fishing.identities WHERE account_id=$1`, actor, strconv.FormatInt(party, 10), "revision="+strconv.FormatInt(current, 10)); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "disbanded", ResourceID: strconv.FormatInt(party, 10)}, nil
	})
}
