package assets

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (t *Transaction) HoldOrderEquipment(ctx context.Context, owner, id, order int64) error {
	if !t.players[owner] || id <= 0 || order <= 0 {
		return ErrInvalid
	}
	var part string
	err := t.SQL().QueryRow(ctx, `SELECT e.part FROM fishing.equipment_instances e JOIN fishing.market_orders o ON o.id=$3 WHERE e.id=$1 AND e.owner_id=$2 AND e.lifecycle='available' AND NOT e.reward_bound AND o.seller_id=$2 AND o.state='open' AND o.kind IN ('equipment','rod') AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id)`, id, owner, order).Scan(&part)
	if errors.Is(err, pgx.ErrNoRows) {
		return Rejection("equipment_unavailable")
	}
	if err != nil {
		return err
	}
	if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.market_order_equipment(order_id,equipment_id,part) VALUES($1,$2,$3)`, order, id, part); err != nil {
		return err
	}
	if _, err = t.SQL().Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='escrow',escrow_order_id=$2 WHERE id=$1`, id, order); err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,next_owner,action) VALUES($1,$2,$3,$3,'hold')`, t.OperationID(), id, owner)
	return err
}
func (t *Transaction) HoldOrderRod(ctx context.Context, owner, order int64, slot int) error {
	if !t.players[owner] || slot < 0 || slot > 7 {
		return ErrInvalid
	}
	before, err := t.u.rodState(ctx, owner)
	if err != nil {
		return err
	}
	rows, err := t.SQL().Query(ctx, `SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 ORDER BY equipment_id`, owner, slot)
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return Rejection("empty_rod")
	}
	var active bool
	if err := t.SQL().QueryRow(ctx, `SELECT active FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=$2`, owner, slot).Scan(&active); err != nil {
		return err
	}
	if _, err = t.SQL().Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2`, owner, slot); err != nil {
		return err
	}
	if _, err = t.SQL().Exec(ctx, `UPDATE fishing.rod_loadouts SET name='' WHERE owner_id=$1 AND slot=$2`, owner, slot); err != nil {
		return err
	}
	if active {
		if err = t.u.activate(ctx, owner, -1); err != nil {
			return err
		}
	}
	for _, id := range ids {
		if err = t.HoldOrderEquipment(ctx, owner, id, order); err != nil {
			return err
		}
	}
	return t.recordRod(ctx, owner, before)
}
func (t *Transaction) recordRod(ctx context.Context, owner int64, before []byte) error {
	after, err := t.u.rodState(ctx, owner)
	if err != nil {
		return err
	}
	if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.rod_entries(operation_id,owner_id,before_state,after_state) VALUES($1,$2,$3,$4)`, t.OperationID(), owner, before, after); err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `UPDATE fishing.player_state SET loadout_rev=loadout_rev+1 WHERE account_id=$1`, owner)
	return err
}

// ReturnOrderEquipment restores whole rods into a free saved slot. On seller
// cancellation/expiry only, a full rod rack returns the components loose, as legacy server does.
func (t *Transaction) ReturnOrderEquipment(ctx context.Context, seller, buyer, order int64, rod bool, name string) error {
	if !t.players[seller] || !t.players[buyer] || order < 1 {
		return ErrInvalid
	}
	slot := -1
	var before []byte
	var err error
	if rod {
		before, err = t.u.rodState(ctx, buyer)
		if err != nil {
			return err
		}
		err = t.SQL().QueryRow(ctx, `SELECT n FROM fishing.player_state p CROSS JOIN LATERAL generate_series(0,p.rod_capacity-1) n WHERE p.account_id=$1 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.owner_id=$1 AND r.slot=n) ORDER BY n LIMIT 1`, buyer).Scan(&slot)
		if errors.Is(err, pgx.ErrNoRows) {
			if buyer != seller {
				return Rejection("rod_capacity")
			}
			slot = -1
		} else if err != nil {
			return err
		}
	}
	rows, err := t.SQL().Query(ctx, `SELECT e.equipment_id,e.part FROM fishing.market_order_equipment e JOIN fishing.equipment_instances i ON i.id=e.equipment_id WHERE e.order_id=$1 AND i.owner_id=$2 AND i.lifecycle='escrow' AND i.escrow_order_id=$1 ORDER BY e.equipment_id`, order, seller)
	if err != nil {
		return err
	}
	type gear struct {
		id   int64
		part string
	}
	list := []gear{}
	for rows.Next() {
		var g gear
		if err := rows.Scan(&g.id, &g.part); err != nil {
			rows.Close()
			return err
		}
		list = append(list, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		return ErrUnavailable
	}
	for _, g := range list {
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.equipment_instances SET owner_id=$2,lifecycle='available',escrow_order_id=NULL WHERE id=$1`, g.id, buyer); err != nil {
			return err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,next_owner,action) VALUES($1,$2,$3,$4,'release')`, t.OperationID(), g.id, seller, buyer); err != nil {
			return err
		}
	}
	if rod && slot >= 0 {
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,active) SELECT $1,-1,NOT EXISTS(SELECT 1 FROM fishing.rod_loadouts WHERE owner_id=$1 AND active) ON CONFLICT(owner_id,slot) DO NOTHING`, buyer); err != nil {
			return err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,name) VALUES($1,$2,$3) ON CONFLICT(owner_id,slot) DO UPDATE SET name=EXCLUDED.name`, buyer, slot, name); err != nil {
			return err
		}
		for _, g := range list {
			if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, buyer, slot, g.part, g.id); err != nil {
				return err
			}
		}
		return t.recordRod(ctx, buyer, before)
	}
	return nil
}
