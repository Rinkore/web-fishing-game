package workshop

import (
	"context"
	"encoding/json"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
)

type ChestCommand struct {
	UnboundInputs                             bool `json:"unboundInputs"`
	ActorID                                   int64
	RequestKey, ChestID, Action, Part, BaseID string
	Quantity                                  int64
}

func (s *Service) Chest(ctx context.Context, r ChestCommand) (assets.Result, error) {
	chest, ok := s.catalog.Chest(r.ChestID)
	if !ok || r.ActorID < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.Action != "craft" && r.Action != "open" {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.Action == "craft" && (r.Quantity < 1 || r.Quantity > 99) {
		return assets.Result{}, assets.ErrInvalid
	}
	if r.Action == "open" && r.Quantity != 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	version := s.ruleVersion()
	var seed []byte
	if r.Action == "open" {
		var err error
		seed, err = s.intent(ctx, r.ActorID, r.RequestKey, struct {
			Command ChestCommand
			Version string
		}{r, version})
		if err != nil {
			return assets.Result{}, err
		}
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "chest_" + r.Action, RuleVersion: version, Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		t.UnboundInputsOnly(r.UnboundInputs)
		if r.Action == "craft" {
			if err := t.Coins(ctx, r.ActorID, -chest.CostCoins*r.Quantity); err != nil {
				return assets.Result{}, err
			}
			stacks := []assets.StackDelta{{ItemID: chest.ID, Tier: "normal", Quantity: r.Quantity}}
			if chest.CostRelic > 0 {
				stacks = append(stacks, assets.StackDelta{ItemID: "relic", Tier: "normal", Quantity: -chest.CostRelic * r.Quantity})
			}
			if err := t.Stacks(ctx, r.ActorID, stacks); err != nil {
				return assets.Result{}, err
			}
			return assets.Result{Status: "crafted"}, nil
		}
		if err := t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: chest.ID, Tier: "normal", Quantity: -1}}); err != nil {
			return assets.Result{}, err
		}
		var misses int64
		if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.chest_pity(owner_id,chest_id) VALUES($1,$2) ON CONFLICT(owner_id,chest_id) DO UPDATE SET misses=fishing.chest_pity.misses RETURNING misses`, r.ActorID, chest.ID).Scan(&misses); err != nil {
			return assets.Result{}, err
		}
		// The legacy console's pityN is an operator setting layered into the
		// effective catalog. A trigger at N means the Nth consecutive miss is
		// converted to a guaranteed breakthrough, matching Node's before>=N-1
		// check. Non-breakthrough chests ignore the setting.
		pityN := s.catalog.ChestPityN()
		forced := chest.Extra && pityN > 0 && misses >= pityN-1
		signature, ok := s.catalog.OpenChest(chest, r.Part, r.BaseID, s.catalog.ComponentConfig(), forced, rules.Stream(seed, "chest:"+chest.ID))
		if !ok {
			return assets.Result{}, assets.Rejection("invalid_chest_selection")
		}
		id, err := s.create(ctx, t, r.ActorID, signature)
		if err != nil {
			return assets.Result{}, err
		}
		base, _, affixes, _ := s.catalog.Instance(signature)
		breakthrough := len(affixes) > 3
		if chest.Extra && !breakthrough {
			misses++
		} else {
			misses = 0
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.chest_pity SET misses=$3 WHERE owner_id=$1 AND chest_id=$2`, r.ActorID, chest.ID, misses); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count) VALUES($1,$2,1) ON CONFLICT(owner_id,item_id) DO UPDATE SET count=fishing.player_codex.count+1`, r.ActorID, base.ID); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(map[string]any{"signature": signature, "pityN": pityN, "pityNow": misses, "pityNeed": chest.PityNeed(pityN, misses), "forced": forced && breakthrough})
		return assets.Result{Status: "opened", EquipmentIDs: []string{strconv.FormatInt(id, 10)}, Details: details}, nil
	})
}
