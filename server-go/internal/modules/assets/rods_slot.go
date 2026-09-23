package assets

import (
	"context"
	"strconv"
)

// RodSlotPrices follows the legacy 2nd..8th slot price ladder. Slot one is the
// free active assembly.
var RodSlotPrices = []int64{10000, 50000, 100000, 200000, 400000, 800000, 1600000}

// NextRodSlotPrice returns the price of the next purchasable slot and whether
// one is available for the given already-purchased capacity.
func NextRodSlotPrice(capacity int) (int64, bool) {
	if capacity < 1 || capacity >= 8 {
		return 0, false
	}
	return RodSlotPrices[capacity-1], true
}

// BuyRodSlot purchases one additional saved-rod capacity atomically with the
// coin charge. It reuses the rod_change command kind so no schema change is
// needed for the purchase itself.
func (s *Service) BuyRodSlot(ctx context.Context, actor int64, key string) (Result, error) {
	if actor < 1 || !validRequestKey(key) {
		return Result{}, ErrInvalid
	}
	return s.execute(ctx, command{actor, key, "rod_change", "rod-slot-v1", fingerprint(struct {
		Version string
		Actor   int64
	}{"rod-slot-buy-v1", actor}), []int64{actor}}, func(ctx context.Context, u *assetTx) (Result, error) {
		// Imported accounts can have an active saved rod without slot -1. Keep
		// the existing assembly active, as ChangeRod does during initialization.
		if _, err := u.tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,active)
 VALUES ($1,-1,NOT EXISTS(SELECT 1 FROM fishing.rod_loadouts WHERE owner_id=$1 AND active))
 ON CONFLICT(owner_id,slot) DO NOTHING`, actor); err != nil {
			return Result{}, err
		}
		var capacity int
		if err := u.tx.QueryRow(ctx, `SELECT rod_capacity FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, actor).Scan(&capacity); err != nil {
			return Result{}, err
		}
		price, ok := NextRodSlotPrice(capacity)
		if !ok {
			return Result{}, rejection("rod_slot_limit")
		}
		if err := u.coins(ctx, actor, -price); err != nil {
			return Result{}, err
		}
		if _, err := u.tx.Exec(ctx, `UPDATE fishing.player_state SET rod_capacity=rod_capacity+1 WHERE account_id=$1`, actor); err != nil {
			return Result{}, err
		}
		return Result{Status: "rod_slot_bought", ResourceID: strconv.FormatInt(price, 10)}, nil
	})
}
