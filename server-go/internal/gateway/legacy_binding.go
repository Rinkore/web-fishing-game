package gateway

import (
	"context"
	"encoding/json"

	"fishing.local/server/internal/modules/assets"
)

type bindingCount struct {
	Bound   int64 `json:"bound"`
	Inherit int64 `json:"inherit"`
}
type bindingView map[string]map[string]bindingCount

func rewardBindings(ctx context.Context, q assets.SQL, owner int64) (bindingView, error) {
	out := bindingView{}
	rows, err := q.Query(ctx, `SELECT item_id,tier,bound_quantity,inherit_quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND bound_quantity>0
 UNION ALL SELECT e.attributes->>'signature','normal',count(*),count(*) FILTER(WHERE e.bind_outputs) FROM fishing.equipment_instances e WHERE e.owner_id=$1 AND e.lifecycle='available' AND e.reward_bound AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) GROUP BY 1
 UNION ALL SELECT '@rod:'||r.slot::text,'normal',count(*),count(*) FILTER(WHERE e.bind_outputs) FROM fishing.rod_components r JOIN fishing.equipment_instances e ON e.id=r.equipment_id WHERE r.owner_id=$1 AND e.reward_bound GROUP BY r.slot`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, tier string
		var v bindingCount
		if err = rows.Scan(&id, &tier, &v.Bound, &v.Inherit); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]bindingCount{}
		}
		out[id][tier] = v
	}
	return out, rows.Err()
}

// Snapshot replacement must restore the binding subset as well as totals.
// New snapshots carry this metadata; legacy/manual edits preserve the current
// subset, clamped to remaining quantities, rather than minting tradable copies.
func restoreRewardBindings(ctx context.Context, q assets.SQL, owner, operation int64, view any) error {
	raw, err := json.Marshal(view)
	if err != nil {
		return err
	}
	var bindings bindingView
	if err = json.Unmarshal(raw, &bindings); err != nil {
		return err
	}
	for id, tiers := range bindings {
		for tier, v := range tiers {
			if v.Bound < 0 || v.Inherit < 0 || v.Inherit > v.Bound {
				return assets.ErrInvalid
			}
			if _, err = q.Exec(ctx, `UPDATE fishing.inventory_stacks SET bound_quantity=LEAST(quantity,$4),inherit_quantity=LEAST(quantity,$5) WHERE owner_id=$1 AND item_id=$2 AND tier=$3`, owner, id, tier, v.Bound, v.Inherit); err != nil {
				return err
			}
			if tier == "normal" {
				if _, err = q.Exec(ctx, `WITH chosen AS (SELECT id,row_number() OVER(ORDER BY id) n FROM fishing.equipment_instances WHERE owner_id=$1 AND created_operation=$2 AND attributes->>'signature'=$3 AND lifecycle='available') UPDATE fishing.equipment_instances e SET reward_bound=true,bind_outputs=c.n<=$5 FROM chosen c WHERE e.id=c.id AND c.n<=$4`, owner, operation, id, v.Bound, v.Inherit); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
