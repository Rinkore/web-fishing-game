package sea

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
)

// Called before codex writes, within the same fishing transaction. Replayed
// segments cannot accrue another sample or tracking step.
func (s *Service) GearCatchProgress(ctx context.Context, t *assets.Transaction, owner int64, catches []rules.Catch) error {
	snap, err := s.expeditionGear(ctx, t.SQL(), owner)
	if err != nil {
		return err
	}
	if snap.Set != "apex" && snap.Set != "research" && snap.Set != "forge" {
		return nil
	}
	if err = ensureCaptain(ctx, t, owner); err != nil {
		return err
	}
	seen := map[string]bool{}
	cap, err := captain(ctx, t.SQL(), owner)
	if err != nil {
		return err
	}
	fish, hit := false, false
	for _, v := range catches {
		if snap.Set == "forge" && v.Kind == "material" {
			if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET heat=LEAST(30,heat+1) WHERE owner_id=$1`, owner); err != nil {
				return err
			}
		}
		if v.Kind != "fish" {
			continue
		}
		if snap.Set == "apex" {
			fish = true
			hit = hit || v.ID == cap.Target
		} else if snap.Set == "research" && !seen[v.ID] {
			seen[v.ID] = true
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET samples=LEAST(30,samples+1) WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM fishing.player_codex WHERE owner_id=$1 AND item_id=$2)`, owner, v.ID)
		}
		if err != nil {
			return err
		}
	}
	if snap.Set == "apex" && cap.Target != "" && fish {
		_, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET tracking=CASE WHEN $2 THEN 0 ELSE LEAST(3,tracking+1) END WHERE owner_id=$1`, owner, hit)
	}
	return err
}

// SelectTarget resets earned tracking when changing species. Repeating the
// current selection cannot reset progress or invalidate an in-flight catch.
func (s *Service) SelectTarget(ctx context.Context, owner int64, key, target string) (assets.Result, error) {
	it, ok := s.catalog.Item(target)
	if !ok || it.Kind != "fish" {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_set_target", RuleVersion: "expedition-v1", Players: []int64{owner}, Input: struct{ Target string }{target}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		snap, err := s.expeditionGear(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if snap.Set != "apex" {
			return assets.Result{}, assets.Rejection("apex_required")
		}
		if err = ensureCaptain(ctx, t, owner); err != nil {
			return assets.Result{}, err
		}
		cap, err := captain(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if cap.Target != target {
			if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET target=$2,tracking=0 WHERE owner_id=$1`, owner, target); err != nil {
				return assets.Result{}, err
			}
			if _, err = t.SQL().Exec(ctx, `UPDATE fishing.player_state SET loadout_rev=loadout_rev+1 WHERE account_id=$1`, owner); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: "target_selected"}, nil
	})
}

// Only an already present species receives extra weight; tracking cannot add
// a fish from a different fishing ground or bypass that ground's access rules.
func (s *Service) TrackingPool(ctx context.Context, t *assets.Transaction, owner int64, pool []rules.LootEntry) error {
	snap, err := s.expeditionGear(ctx, t.SQL(), owner)
	if err != nil {
		return err
	}
	if snap.Set != "apex" {
		return nil
	}
	cap, err := captain(ctx, t.SQL(), owner)
	if err != nil {
		return err
	}
	var boost func([]rules.LootEntry)
	boost = func(entries []rules.LootEntry) {
		for i := range entries {
			if entries[i].Pick == "fish:"+cap.Target {
				entries[i].Weight *= 1 + float64(cap.Tracking)*0.25
			}
			boost(entries[i].Items)
		}
	}
	boost(pool)
	return nil
}
