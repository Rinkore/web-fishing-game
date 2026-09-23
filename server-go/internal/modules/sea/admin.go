package sea

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"

	"fishing.local/server/internal/modules/assets"
)

// EditCaptain is an audited test/operations tool with optimistic concurrency.
func (s *Service) EditCaptain(ctx context.Context, actor, owner int64, key, name string, before, after Captain) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, actor); err != nil {
		return assets.Result{}, err
	}
	if after.Marks < 0 || after.Marks > 1000000000 || after.Heat < 0 || after.Heat > 30 || after.Clues < 0 || after.Clues > 5 || after.Samples < 0 || after.Samples > 30 || after.Tracking < 0 || after.Tracking > 3 || after.Starter < 0 || after.Starter > 2 || after.Successes != before.Successes || after.Voyages != before.Voyages || !reflect.DeepEqual(after.Clears, before.Clears) || after.Target != before.Target {
		return assets.Result{}, assets.ErrInvalid
	}
	players := []int64{actor}
	if actor != owner {
		players = append(players, owner)
	}
	return s.assets.Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "admin_grant", RuleVersion: "captain-edit-v1", Players: players, Input: struct {
		Owner         int64
		Before, After Captain
	}{owner, before, after}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		current, err := captain(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if !reflect.DeepEqual(current, before) {
			return assets.Result{}, assets.Rejection("captain_changed")
		}
		if err = ensureCaptain(ctx, t, owner); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET marks=$2,heat=$3,clues=$4,samples=$5,tracking=$6,starter=$7 WHERE owner_id=$1`, owner, after.Marks, after.Heat, after.Clues, after.Samples, after.Tracking, after.Starter); err != nil {
			return assets.Result{}, err
		}
		detail, _ := json.Marshal(map[string]any{"before": before, "after": after})
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,'expedition/player',$4,$5)`, actor, name, owner, strconv.FormatInt(owner, 10), string(detail)); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "updated"}, nil
	})
}
