package assets

import (
	"context"
	"errors"
)

// DiscardOrderEquipment consumes server-created equipment that is still held
// in an administrator market order. It deliberately does not return anything
// to the seller: the order's contents were minted for the market itself.
func (t *Transaction) DiscardOrderEquipment(ctx context.Context, owner, order int64) error {
	if !t.players[owner] || owner <= 0 || order <= 0 {
		return ErrInvalid
	}
	rows, err := t.SQL().Query(ctx, `SELECT e.equipment_id
 FROM fishing.market_order_equipment e
 JOIN fishing.equipment_instances i ON i.id=e.equipment_id
 WHERE e.order_id=$1 AND i.owner_id=$2 AND i.lifecycle='escrow' AND i.escrow_order_id=$1
 ORDER BY e.equipment_id FOR UPDATE`, order, owner)
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
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(ids) == 0 {
		return errors.New("market order equipment missing")
	}
	for _, id := range ids {
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed',escrow_order_id=NULL WHERE id=$1 AND owner_id=$2 AND lifecycle='escrow' AND escrow_order_id=$3`, id, owner, order); err != nil {
			return err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume')`, t.OperationID(), id, owner); err != nil {
			return err
		}
	}
	return nil
}
