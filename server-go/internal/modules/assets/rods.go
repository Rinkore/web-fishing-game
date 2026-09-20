package assets

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type RodCommand struct {
	ActorID     int64
	RequestKey  string
	Action      string // equip, save, use, stow, delete, rename
	Part        string
	EquipmentID int64 // equip: zero uninstalls the selected part
	Slot        int   // saved slot 0..7; capacity still checked under player lock
	Name        string
	Force       bool // save only: explicitly replace occupied destination
}

func (s *Service) ChangeRod(ctx context.Context, r RodCommand) (Result, error) {
	if r.ActorID <= 0 || !validRequestKey(r.RequestKey) || !utf8.ValidString(r.Name) || strings.ContainsRune(r.Name, 0) || len(utf16.Encode([]rune(r.Name))) > 20 {
		return Result{}, ErrInvalid
	}
	switch r.Action {
	case "equip":
		if !partValid(r.Part) || r.EquipmentID < 0 || r.Slot != 0 || r.Name != "" || r.Force {
			return Result{}, ErrInvalid
		}
	case "save", "use", "delete", "rename":
		if r.Slot < 0 || r.Slot >= 8 || r.Part != "" || r.EquipmentID != 0 {
			return Result{}, ErrInvalid
		}
		if r.Action != "save" && r.Force || r.Action != "save" && r.Action != "rename" && r.Name != "" {
			return Result{}, ErrInvalid
		}
	case "stow":
		if r.Part != "" || r.EquipmentID != 0 || r.Slot != 0 || r.Name != "" || r.Force {
			return Result{}, ErrInvalid
		}
	default:
		return Result{}, ErrInvalid
	}
	hash := fingerprint(struct {
		Version string
		Plan    RodCommand
	}{"rod-change-v1", r})
	return s.execute(ctx, command{r.ActorID, r.RequestKey, "rod_change", "rod-change-v1", hash, []int64{r.ActorID}}, func(ctx context.Context, u *assetTx) (Result, error) {
		// A new account lazily gets one unsaved active assembly. Saved loadouts
		// are created only when used by Save, after the purchased-capacity check.
		if _, err := u.tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,active) VALUES ($1,-1,true) ON CONFLICT(owner_id,slot) DO NOTHING`, r.ActorID); err != nil {
			return Result{}, err
		}
		before, err := u.rodState(ctx, r.ActorID)
		if err != nil {
			return Result{}, err
		}
		var active, capacity int
		if err = u.tx.QueryRow(ctx, "SELECT slot FROM fishing.rod_loadouts WHERE owner_id=$1 AND active", r.ActorID).Scan(&active); err != nil {
			return Result{}, err
		}
		if err = u.tx.QueryRow(ctx, "SELECT rod_capacity FROM fishing.player_state WHERE account_id=$1", r.ActorID).Scan(&capacity); err != nil {
			return Result{}, err
		}
		if r.Action != "equip" && r.Action != "stow" && r.Slot >= capacity {
			return Result{}, rejection("slot_not_purchased")
		}
		switch r.Action {
		case "equip":
			err = u.equip(ctx, r, active)
		case "save":
			if active >= 0 && active != r.Slot {
				return Result{}, rejection("rod_already_saved")
			}
			if !u.hasParts(ctx, r.ActorID, active, &err) {
				if err != nil {
					return Result{}, err
				}
				return Result{}, rejection("empty_rod")
			}
			if active != r.Slot && u.hasParts(ctx, r.ActorID, r.Slot, &err) && !r.Force {
				return Result{}, rejection("slot_occupied")
			}
			if err != nil {
				return Result{}, err
			}
			if _, err = u.tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,name) VALUES ($1,$2,$3) ON CONFLICT(owner_id,slot) DO UPDATE SET name=EXCLUDED.name`, r.ActorID, r.Slot, r.Name); err != nil {
				return Result{}, err
			}
			if active != r.Slot {
				if _, err = u.tx.Exec(ctx, "DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2", r.ActorID, r.Slot); err != nil {
					return Result{}, err
				}
				if _, err = u.tx.Exec(ctx, "UPDATE fishing.rod_components SET slot=$2 WHERE owner_id=$1 AND slot=-1", r.ActorID, r.Slot); err != nil {
					return Result{}, err
				}
			}
			err = u.activate(ctx, r.ActorID, r.Slot)
		case "use":
			if active == r.Slot {
				return Result{}, rejection("rod_already_active")
			}
			if !u.hasParts(ctx, r.ActorID, r.Slot, &err) {
				if err != nil {
					return Result{}, err
				}
				return Result{}, rejection("empty_rod")
			}
			if active == -1 {
				if _, err = u.tx.Exec(ctx, "DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=-1", r.ActorID); err != nil {
					return Result{}, err
				}
			}
			err = u.activate(ctx, r.ActorID, r.Slot)
		case "stow":
			if !u.hasParts(ctx, r.ActorID, active, &err) {
				if err != nil {
					return Result{}, err
				}
				return Result{}, rejection("empty_rod")
			}
			if active == -1 {
				if _, err = u.tx.Exec(ctx, "DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=-1", r.ActorID); err != nil {
					return Result{}, err
				}
			}
			err = u.activate(ctx, r.ActorID, -1)
		case "delete":
			if !u.hasParts(ctx, r.ActorID, r.Slot, &err) {
				if err != nil {
					return Result{}, err
				}
				return Result{}, rejection("empty_rod")
			}
			if _, err = u.tx.Exec(ctx, "DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2", r.ActorID, r.Slot); err != nil {
				return Result{}, err
			}
			if _, err = u.tx.Exec(ctx, "UPDATE fishing.rod_loadouts SET name='' WHERE owner_id=$1 AND slot=$2", r.ActorID, r.Slot); err != nil {
				return Result{}, err
			}
			if active == r.Slot {
				err = u.activate(ctx, r.ActorID, -1)
			}
		case "rename":
			if !u.hasParts(ctx, r.ActorID, r.Slot, &err) {
				if err != nil {
					return Result{}, err
				}
				return Result{}, rejection("empty_rod")
			}
			_, err = u.tx.Exec(ctx, "UPDATE fishing.rod_loadouts SET name=$3 WHERE owner_id=$1 AND slot=$2", r.ActorID, r.Slot, r.Name)
		}
		if err != nil {
			return Result{}, err
		}
		after, err := u.rodState(ctx, r.ActorID)
		if err != nil {
			return Result{}, err
		}
		if _, err = u.tx.Exec(ctx, "INSERT INTO fishing.rod_entries(operation_id,owner_id,before_state,after_state) VALUES ($1,$2,$3,$4)", u.op, r.ActorID, before, after); err != nil {
			return Result{}, err
		}
		if _, err = u.tx.Exec(ctx, "UPDATE fishing.player_state SET loadout_rev=loadout_rev+1 WHERE account_id=$1", r.ActorID); err != nil {
			return Result{}, err
		}
		return Result{Status: "rod_updated"}, nil
	})
}

func (u *assetTx) hasParts(ctx context.Context, owner int64, slot int, err *error) bool {
	var exists bool
	*err = u.tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2)", owner, slot).Scan(&exists)
	return exists
}
func (u *assetTx) activate(ctx context.Context, owner int64, slot int) error {
	if _, err := u.tx.Exec(ctx, "UPDATE fishing.rod_loadouts SET active=false WHERE owner_id=$1 AND active", owner); err != nil {
		return err
	}
	tag, err := u.tx.Exec(ctx, "UPDATE fishing.rod_loadouts SET active=true WHERE owner_id=$1 AND slot=$2", owner, slot)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrUnavailable
	}
	return err
}
func (u *assetTx) equip(ctx context.Context, r RodCommand, active int) error {
	var previous int64
	err := u.tx.QueryRow(ctx, "SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3", r.ActorID, active, r.Part).Scan(&previous)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if previous == r.EquipmentID {
		return nil
	} // Same-instance equip cannot consume it twice.
	if r.EquipmentID > 0 {
		var owner int64
		var part, state string
		err = u.tx.QueryRow(ctx, "SELECT owner_id,part,lifecycle FROM fishing.equipment_instances WHERE id=$1 FOR UPDATE", r.EquipmentID).Scan(&owner, &part, &state)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (owner != r.ActorID || state != "available") {
			return rejection("equipment_unavailable")
		}
		if err != nil {
			return err
		}
		if part != r.Part {
			return rejection("wrong_equipment_part")
		}
		var bound bool
		if err = u.tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM fishing.rod_components WHERE equipment_id=$1)", r.EquipmentID).Scan(&bound); err != nil {
			return err
		}
		if bound {
			return rejection("equipment_locked")
		}
	}
	if _, err = u.tx.Exec(ctx, "DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3", r.ActorID, active, r.Part); err != nil {
		return err
	}
	if r.EquipmentID > 0 {
		_, err = u.tx.Exec(ctx, "INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES ($1,$2,$3,$4)", r.ActorID, active, r.Part, r.EquipmentID)
	} else if active >= 0 {
		// Legacy uninstall dissolves the saved rod; other components stay in the
		// now-unsaved active assembly, and the removed component returns to stock.
		if _, err = u.tx.Exec(ctx, "UPDATE fishing.rod_components SET slot=-1 WHERE owner_id=$1 AND slot=$2", r.ActorID, active); err != nil {
			return err
		}
		if _, err = u.tx.Exec(ctx, "UPDATE fishing.rod_loadouts SET name='' WHERE owner_id=$1 AND slot=$2", r.ActorID, active); err != nil {
			return err
		}
		err = u.activate(ctx, r.ActorID, -1)
	}
	return err
}
func (u *assetTx) rodState(ctx context.Context, owner int64) (json.RawMessage, error) {
	var data []byte
	err := u.tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',r.slot,'name',r.name,'active',r.active,'parts',
 (SELECT COALESCE(jsonb_object_agg(c.part,c.equipment_id::text),'{}'::jsonb) FROM fishing.rod_components c WHERE c.owner_id=r.owner_id AND c.slot=r.slot)) ORDER BY r.slot),'[]'::jsonb)
 FROM fishing.rod_loadouts r WHERE r.owner_id=$1`, owner).Scan(&data)
	return data, err
}
