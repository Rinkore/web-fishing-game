package economy

import (
	"context"
	"encoding/json"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"math"
)

func (s *Service) SellEquipment(ctx context.Context, owner, id int64, key string) (assets.Result, error) {
	if owner < 1 || id < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "shop_sell", RuleVersion: s.version(), Players: []int64{owner}, Input: struct{ EquipmentID int64 }{id}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var raw []byte
		err := t.SQL().QueryRow(ctx, `SELECT attributes FROM fishing.equipment_instances WHERE id=$1 AND owner_id=$2 AND lifecycle='available'`, id, owner).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("equipment_unavailable")
		}
		if err != nil {
			return assets.Result{}, err
		}
		var attrs struct {
			Signature string `json:"signature"`
			Bound     bool   `json:"bound"`
		}
		if json.Unmarshal(raw, &attrs) != nil {
			return assets.Result{}, assets.ErrUnavailable
		}
		if attrs.Bound {
			return assets.Result{}, assets.Rejection("bound_equipment")
		}
		base, unit, err := s.equipmentPrice(attrs.Signature)
		if err != nil {
			return assets.Result{}, err
		}
		return applyEquipmentSale(ctx, t, owner, []int64{id}, base, unit)
	})
}

// Component inventory rows group concrete equipment by signature. Resolve the
// requested quantity only after the same player guard used by all asset writes.
func (s *Service) sellComponents(ctx context.Context, r Sell) (assets.Result, error) {
	if r.ActorID < 1 || r.Quantity < 1 || r.Quantity > assets.MaxCoins || r.Tier != "normal" {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "shop_sell", RuleVersion: s.version(), Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		base, unit, err := s.equipmentPrice(r.ItemID)
		if err != nil {
			return assets.Result{}, err
		}
		rows, err := t.SQL().Query(ctx, `SELECT e.id,e.reward_bound FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND e.attributes->>'signature'=$2
 AND NOT COALESCE((e.attributes->>'bound')::boolean,false)
 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id)
 ORDER BY e.reward_bound,e.id LIMIT $3`, r.ActorID, r.ItemID, r.Quantity)
		if err != nil {
			return assets.Result{}, err
		}
		ids := []int64{}
		rewardBound := false
		for rows.Next() {
			var id int64
			var bound bool
			if err := rows.Scan(&id, &bound); err != nil {
				rows.Close()
				return assets.Result{}, err
			}
			ids = append(ids, id)
			rewardBound = rewardBound || bound
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return assets.Result{}, err
		}
		if rewardBound {
			return assets.Result{}, assets.Rejection("reward_bound")
		}
		if int64(len(ids)) != r.Quantity {
			return assets.Result{}, assets.Rejection("equipment_unavailable")
		}
		return applyEquipmentSale(ctx, t, r.ActorID, ids, base, unit)
	})
}

func (s *Service) equipmentPrice(signature string) (string, int64, error) {
	base, quality, _, ok := s.catalog.Instance(signature)
	if !ok {
		return "", 0, assets.Rejection("equipment_rules_missing")
	}
	if base.NoSell {
		return "", 0, assets.ErrInvalid
	}
	var qualities map[string]struct {
		Mult float64 `json:"mult"`
	}
	if err := s.catalog.Constant("QUALITY", &qualities); err != nil {
		return "", 0, err
	}
	value := rules.Round(base.Price * qualities[quality].Mult)
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 1 || value > float64(assets.MaxCoins) {
		return "", 0, assets.ErrInvalid
	}
	return base.ID, int64(value), nil
}

func applyEquipmentSale(ctx context.Context, t *assets.Transaction, owner int64, ids []int64, base string, unit int64) (assets.Result, error) {
	quantity := int64(len(ids))
	if quantity < 1 || quantity > assets.MaxCoins/unit {
		return assets.Result{}, assets.Rejection("coin_overflow")
	}
	gain := unit * quantity
	for _, id := range ids {
		if err := t.ConsumeEquipment(ctx, owner, id); err != nil {
			return assets.Result{}, err
		}
	}
	if err := t.Coins(ctx, owner, gain); err != nil {
		return assets.Result{}, err
	}
	if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.shop_sales(operation_id,owner_id,item_id,tier,quantity,unit,bonus,gain,automatic) VALUES($1,$2,$3,'equipment',$4,$5,0,$6,false)`, t.OperationID(), owner, base, quantity, unit, gain); err != nil {
		return assets.Result{}, err
	}
	details, _ := json.Marshal(map[string]any{"gain": gain})
	return assets.Result{Status: "sold", Details: details}, nil
}
