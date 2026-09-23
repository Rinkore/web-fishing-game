package migration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func realPositive(v any) (int64, error) {
	n, ok := integer(v)
	if !ok || !n.IsInt64() || n.Sign() <= 0 || n.Int64() > 9007199254740991 {
		return 0, errors.New("invalid positive legacy integer")
	}
	return n.Int64(), nil
}

func realMarketParts(c *rules.Catalog, id string) (string, map[string]string, error) {
	if it, ok := c.Item(id); ok && it.Kind != "component" {
		return "stack", nil, nil
	}
	if it, _, _, ok := c.Instance(id); ok {
		return "equipment", map[string]string{it.Part: id}, nil
	}
	if strings.HasPrefix(id, "rodset:") {
		parts := map[string]string{}
		for _, entry := range strings.Split(strings.TrimPrefix(id, "rodset:"), ";") {
			part, sig, ok := strings.Cut(entry, "=")
			if !ok {
				return "", nil, errors.New("invalid legacy rod signature")
			}
			it, _, _, valid := c.Instance(sig)
			if !valid || part != it.Part || parts[part] != "" {
				return "", nil, errors.New("invalid legacy rod component")
			}
			parts[part] = sig
		}
		if len(parts) == 0 {
			return "", nil, errors.New("empty legacy market rod")
		}
		return "rod", parts, nil
	}
	return "", nil, errors.New("unknown legacy market item")
}

// ImportRealMarketEconomy restores escrow directly: the old server already
// removed player listings from inventory, and admin listings were minted in
// escrow. Reapplying either a debit or a historical payment would corrupt
// the source balances.
func ImportRealMarketEconomy(ctx context.Context, rc *RealContext) error {
	m, err := readObject(filepath.Join(rc.Root, "market.json"))
	if err != nil {
		return err
	}
	list, _ := m["listings"].([]any)
	nextID := int64(intNumber(m["listingSeq"]))
	if nextID < 1 {
		nextID = 1
	}
	for _, raw := range list {
		v, ok := raw.(map[string]any)
		if !ok {
			return errors.New("invalid listing row")
		}
		id, err := realPositive(v["lid"])
		if err != nil {
			return err
		}
		if id >= nextID {
			nextID = id + 1
		}
	}
	for index, raw := range list {
		v := raw.(map[string]any)
		sid := rc.IDs[strings.ToLower(stringValue(v, "seller"))]
		if sid <= 0 {
			return errors.New("unknown legacy listing seller")
		}
		lid, err := realPositive(v["lid"])
		if err != nil {
			return err
		}
		qty, err := realPositive(v["qty"])
		if err != nil {
			return err
		}
		price, err := realPositive(v["price"])
		if err != nil {
			return err
		}
		hours := intNumber(v["hours"])
		if hours != 6 && hours != 12 && hours != 24 {
			return errors.New("invalid legacy listing hours")
		}
		created, err := realPositive(v["t"])
		if err != nil {
			return err
		}
		expires, err := realPositive(v["expireAt"])
		if err != nil {
			return err
		}
		kind, parts, err := realMarketParts(rc.Catalog, stringValue(v, "id"))
		if err != nil {
			return err
		}
		source := stringValue(v, "src")
		if source == "" {
			source = "player"
		}
		if source != "player" && source != "admin" {
			return errors.New("invalid legacy listing source")
		}
		op, err := realDomainOperation(ctx, rc, sid, fmt.Sprintf("market:%d", index), "market_list")
		if err != nil {
			return err
		}
		copies := int64(1)
		if kind != "stack" {
			copies = qty
		}
		if copies > 100000 {
			return errors.New("legacy market equipment count too large")
		}
		for copy := int64(0); copy < copies; copy++ {
			id := lid
			if copy > 0 {
				id = nextID
				nextID++
			}
			quantity := qty
			var item any = stringValue(v, "id")
			if kind != "stack" {
				quantity = 1
				item = nil
			}
			name := ""
			if kind == "rod" {
				name = stringValue(v, "name")
				if len([]rune(name)) > 20 {
					return errors.New("legacy rod name too long")
				}
			}
			if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.market_orders(id,seller_id,kind,item_id,quantity,remaining,unit_price,rod_name,hours,state,created_operation,created_at,expires_at,source,supply_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'open',$9,$10,$11,$12,NULLIF($13,''))`, id, sid, kind, item, quantity, price, name, hours, op, time.UnixMilli(created), time.UnixMilli(expires), source, stringValue(v, "supplyId")); err != nil {
				return err
			}
			keys := make([]string, 0, len(parts))
			for part := range parts {
				keys = append(keys, part)
			}
			sort.Strings(keys)
			for _, part := range keys {
				sig := parts[part]
				base, _, _, _ := rc.Catalog.Instance(sig)
				var eid int64
				if err := rc.Tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,lifecycle,created_operation,escrow_order_id) VALUES($1,$2,$3,$4,'escrow',$5,$6) RETURNING id`, sid, base.ID, part, jsonBytes(map[string]any{"signature": sig}, nil), op, id).Scan(&eid); err != nil {
					return err
				}
				if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, op, eid, sid); err != nil {
					return err
				}
				if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.market_order_equipment(order_id,equipment_id,part) VALUES($1,$2,$3)`, id, eid, part); err != nil {
					return err
				}
			}
			legacyID := strconv.FormatInt(lid, 10)
			if copy > 0 {
				legacyID += fmt.Sprintf(":copy:%d", copy)
			}
			if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.legacy_id_map(run_id,domain,legacy_id,new_id) VALUES($1,'market-order',$2,$3)`, rc.RunID, legacyID, strconv.FormatInt(id, 10)); err != nil {
				return err
			}
		}
	}
	if _, err := rc.Tx.Exec(ctx, `SELECT setval(pg_get_serial_sequence('fishing.market_orders','id'),$1,false)`, nextID); err != nil {
		return err
	}
	if supply, ok := m["marketSupply"].(map[string]any); ok {
		if err := realSetting(ctx, rc, "market_supply", supply); err != nil {
			return err
		}
	}
	econ, err := readObject(filepath.Join(rc.Root, "economy.json"))
	if err != nil {
		return err
	}
	states, _ := econ["shopSales"].(map[string]any)
	for id, state := range states {
		it, ok := rc.Catalog.Item(id)
		if !ok || (it.Kind != "fish" && it.Kind != "material") {
			return errors.New("unknown legacy economy item")
		}
		var typed rules.SaleState
		if json.Unmarshal(jsonBytes(state, nil), &typed) != nil || typed.SoldToday < 0 || typed.SoldTotal < 0 || typed.LastMS < 0 {
			return errors.New("invalid legacy economy state")
		}
		if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.economy_prices(item_id,state) VALUES($1,$2)`, id, jsonBytes(state, nil)); err != nil {
			return err
		}
	}
	rows, err := realEconomyRows(econ)
	if err != nil {
		return err
	}
	_, err = rc.Tx.CopyFrom(ctx, pgx.Identifier{"fishing", "legacy_economy_history"}, []string{"kind", "item_id", "ordinal", "payload", "occurred_at"}, pgx.CopyFromRows(rows))
	return err
}

func realEconomyRows(econ map[string]any) ([][]any, error) {
	rows := [][]any{}
	add := func(kind, id string, value any) error {
		list, ok := value.([]any)
		if !ok {
			return errors.New("invalid legacy economy history array")
		}
		for i, raw := range list {
			m, ok := raw.(map[string]any)
			if !ok {
				return errors.New("invalid legacy economy history row")
			}
			ts, err := realPositive(m["t"])
			if err != nil {
				return err
			}
			rows = append(rows, []any{kind, id, int64(i), jsonBytes(m, nil), time.UnixMilli(ts)})
		}
		return nil
	}
	for field, kind := range map[string]string{"priceLog": "price", "tradeLog": "shop"} {
		byItem, _ := econ[field].(map[string]any)
		for id, raw := range byItem {
			if err := add(kind, id, raw); err != nil {
				return nil, err
			}
		}
	}
	for field, kind := range map[string]string{"marketLog": "market", "economyLog": "audit"} {
		if v, ok := econ[field]; ok {
			if err := add(kind, "", v); err != nil {
				return nil, err
			}
		}
	}
	return rows, nil
}

func ReconcileRealMarketEconomy(ctx context.Context, rc *RealContext) error {
	m, err := readObject(filepath.Join(rc.Root, "market.json"))
	if err != nil {
		return err
	}
	list, _ := m["listings"].([]any)
	var got int
	want := 0
	for _, raw := range list {
		v := raw.(map[string]any)
		kind, parts, err := realMarketParts(rc.Catalog, stringValue(v, "id"))
		if err != nil {
			return err
		}
		q, _ := realPositive(v["qty"])
		lid, _ := realPositive(v["lid"])
		price, _ := realPositive(v["price"])
		created, _ := realPositive(v["t"])
		expires, _ := realPositive(v["expireAt"])
		copies := int64(1)
		if kind != "stack" {
			copies = q
		}
		want += int(copies)
		var equal bool
		if err := rc.Tx.QueryRow(ctx, `SELECT seller_id=$2 AND remaining=$3 AND unit_price=$4 AND state='open' AND created_at=$5 AND expires_at=$6 AND source=$7 AND COALESCE(supply_id,'')=$8 FROM fishing.market_orders WHERE id=$1`, lid, rc.IDs[strings.ToLower(stringValue(v, "seller"))], q/copies, price, time.UnixMilli(created), time.UnixMilli(expires), func() string {
			s := stringValue(v, "src")
			if s == "" {
				return "player"
			}
			return s
		}(), stringValue(v, "supplyId")).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return errors.New("market order reconciliation mismatch")
		}
		for copy := int64(0); copy < copies; copy++ {
			legacyID := strconv.FormatInt(lid, 10)
			if copy > 0 {
				legacyID += fmt.Sprintf(":copy:%d", copy)
			}
			var orderID int64
			if err := rc.Tx.QueryRow(ctx, `SELECT new_id::bigint FROM fishing.legacy_id_map WHERE run_id=$1 AND domain='market-order' AND legacy_id=$2`, rc.RunID, legacyID).Scan(&orderID); err != nil {
				return err
			}
			item := ""
			if kind == "stack" {
				item = stringValue(v, "id")
			}
			if err := rc.Tx.QueryRow(ctx, `SELECT kind=$2 AND COALESCE(item_id,'')=$3 AND remaining=$4 AND quantity=$4 AND unit_price=$5 FROM fishing.market_orders WHERE id=$1`, orderID, kind, item, q/copies, price).Scan(&equal); err != nil {
				return err
			}
			if !equal {
				return errors.New("market identity reconciliation mismatch")
			}
			if len(parts) > 0 {
				if err := rc.Tx.QueryRow(ctx, `SELECT count(*)=$2 AND COALESCE(jsonb_object_agg(m.part,e.attributes->>'signature'),'{}'::jsonb)=$3::jsonb AND bool_and(e.lifecycle='escrow' AND e.escrow_order_id=m.order_id AND e.owner_id=$4) FROM fishing.market_order_equipment m JOIN fishing.equipment_instances e ON e.id=m.equipment_id WHERE m.order_id=$1`, orderID, len(parts), jsonBytes(parts, nil), rc.IDs[strings.ToLower(stringValue(v, "seller"))]).Scan(&equal); err != nil {
					return err
				}
				if !equal {
					return errors.New("market equipment reconciliation mismatch")
				}
			}
		}
	}
	if err := rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.market_orders`).Scan(&got); err != nil {
		return err
	}
	if got != want {
		return errors.New("market order count mismatch")
	}
	if supply, ok := m["marketSupply"].(map[string]any); ok {
		var equal bool
		if err := rc.Tx.QueryRow(ctx, `SELECT value=$1::jsonb FROM fishing.operator_settings WHERE key='market_supply'`, jsonBytes(supply, nil)).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return errors.New("market supply reconciliation mismatch")
		}
	}
	econ, err := readObject(filepath.Join(rc.Root, "economy.json"))
	if err != nil {
		return err
	}
	states, _ := econ["shopSales"].(map[string]any)
	for id, state := range states {
		var equal bool
		if err := rc.Tx.QueryRow(ctx, `SELECT state=$2::jsonb FROM fishing.economy_prices WHERE item_id=$1`, id, jsonBytes(state, nil)).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return errors.New("economy state reconciliation mismatch")
		}
	}
	wantRows, err := realEconomyRows(econ)
	if err != nil {
		return err
	}
	if err := rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.legacy_economy_history`).Scan(&got); err != nil {
		return err
	}
	if got != len(wantRows) {
		return errors.New("economy history count mismatch")
	}
	check := func(kind, id string, value any) error {
		var equal bool
		if err := rc.Tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(payload ORDER BY ordinal),'[]'::jsonb)=$3::jsonb FROM fishing.legacy_economy_history WHERE kind=$1 AND item_id=$2`, kind, id, jsonBytes(value, []byte("[]"))).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return errors.New("economy history payload mismatch")
		}
		return nil
	}
	for field, kind := range map[string]string{"priceLog": "price", "tradeLog": "shop"} {
		byItem, _ := econ[field].(map[string]any)
		for id, raw := range byItem {
			if err := check(kind, id, raw); err != nil {
				return err
			}
		}
	}
	for field, kind := range map[string]string{"marketLog": "market", "economyLog": "audit"} {
		if v, ok := econ[field]; ok {
			if err := check(kind, "", v); err != nil {
				return err
			}
		}
	}
	return nil
}
