package assets

import "context"

func (u *assetTx) commercial() bool {
	switch u.kind {
	case "asset_exchange", "market_list", "trade_confirm", "shop_sell", "autosell_run":
		return true
	}
	return false
}

// Binding is an asset property, independent of the catalog's global noSell.
// Existing readers still see total quantities. Only commercial debits exclude
// the bound subset; ordinary consumption spends bound stock first.
func (t *Transaction) BindStacks(ctx context.Context, owner int64, items []StackDelta, inherit bool) error {
	if !t.players[owner] {
		return ErrInvalid
	}
	for _, item := range items {
		if item.Quantity <= 0 {
			return ErrInvalid
		}
		inherited := int64(0)
		if inherit {
			inherited = item.Quantity
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.inventory_stacks SET bound_quantity=bound_quantity+$4,inherit_quantity=inherit_quantity+$5 WHERE owner_id=$1 AND item_id=$2 AND tier=$3`, owner, item.ItemID, item.Tier, item.Quantity, inherited); err != nil {
			return err
		}
	}
	return nil
}

func (t *Transaction) BindEquipment(ctx context.Context, owner, id int64, inherit bool) error {
	if !t.players[owner] {
		return ErrInvalid
	}
	tag, err := t.SQL().Exec(ctx, `UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=$3 WHERE id=$1 AND owner_id=$2 AND created_operation=$4`, id, owner, inherit, t.u.op)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return Rejection("equipment_unavailable")
	}
	return nil
}

// Apply inheritance after all inputs and outputs have been resolved, so caller
// ordering and recipe item sort order cannot remove binding. Fishing and voyage
// rewards are deliberately not direct transformations of equipped assets.
func (u *assetTx) bindCraftOutputs(ctx context.Context) error {
	switch u.kind {
	case "asset_change", "workshop_smelt", "workshop_recast", "workshop_forge", "chest_craft", "chest_open", "chart_craft", "sea_quest_claim":
	default:
		return nil
	}
	for owner, inherited := range u.inherit {
		if !inherited {
			continue
		}
		if _, err := u.tx.Exec(ctx, `UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=true WHERE owner_id=$1 AND created_operation=$2`, owner, u.op); err != nil {
			return err
		}
		if _, err := u.tx.Exec(ctx, `UPDATE fishing.inventory_stacks s SET bound_quantity=s.bound_quantity+e.delta,inherit_quantity=s.inherit_quantity+e.delta FROM fishing.inventory_entries e WHERE e.operation_id=$1 AND e.owner_id=$2 AND e.delta>0 AND (s.owner_id,s.item_id,s.tier)=(e.owner_id,e.item_id,e.tier)`, u.op, owner); err != nil {
			return err
		}
	}
	return nil
}

func (u *assetTx) recordBindings(ctx context.Context) error {
	_, err := u.tx.Exec(ctx, `INSERT INTO fishing.inventory_binding_entries(operation_id,owner_id,item_id,tier,bound_after,inherit_after) SELECT e.operation_id,e.owner_id,e.item_id,e.tier,s.bound_quantity,s.inherit_quantity FROM fishing.inventory_entries e JOIN fishing.inventory_stacks s USING(owner_id,item_id,tier) WHERE e.operation_id=$1`, u.op)
	return err
}

// Restrict a craft to ordinary inputs without changing any binding policy.
func (t *Transaction) UnboundInputsOnly(enabled bool) { t.u.unboundInputs = enabled }
