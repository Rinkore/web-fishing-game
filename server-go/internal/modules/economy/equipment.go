package economy

import (
	"context"
	"encoding/json"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
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
		}
		if json.Unmarshal(raw, &attrs) != nil {
			return assets.Result{}, assets.ErrUnavailable
		}
		base, q, _, ok := s.catalog.Instance(attrs.Signature)
		if !ok {
			return assets.Result{}, assets.Rejection("equipment_rules_missing")
		}
		var qualities map[string]struct {
			Mult float64 `json:"mult"`
		}
		if err := s.catalog.Constant("QUALITY", &qualities); err != nil {
			return assets.Result{}, err
		}
		value := rules.Round(base.Price * qualities[q].Mult)
		if value < 1 || value > float64(assets.MaxCoins) {
			return assets.Result{}, assets.ErrInvalid
		}
		gain := int64(value)
		if err := t.ConsumeEquipment(ctx, owner, id); err != nil {
			return assets.Result{}, err
		}
		if err := t.Coins(ctx, owner, gain); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.shop_sales(operation_id,owner_id,item_id,tier,quantity,unit,bonus,gain,automatic) VALUES($1,$2,$3,'equipment',1,$4,0,$4,false)`, t.OperationID(), owner, base.ID, gain); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(map[string]any{"gain": gain})
		return assets.Result{Status: "sold", Details: details}, nil
	})
}
