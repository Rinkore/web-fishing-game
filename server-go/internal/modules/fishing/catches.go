package fishing

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
)

type codexDelta struct {
	count    int64
	min, max *float64
	tier     string
}

func (s *NativeService) award(ctx context.Context, t *assets.Transaction, owner int64, ground, spot string, now time.Time, catches []rules.Catch) error {
	stacks := map[string]assets.StackDelta{}
	codex := map[string]*codexDelta{}
	for i, v := range catches {
		if err := ctx.Err(); err != nil {
			return err
		}
		if v.Kind == "component" {
			base, _, _, _ := s.catalog.Instance(v.ID)
			attrs, _ := json.Marshal(map[string]string{"signature": v.ID})
			if _, err := t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}); err != nil {
				return err
			}
		} else {
			key := v.ID + ":" + v.Tier
			d := stacks[key]
			d.ItemID = v.ID
			d.Tier = v.Tier
			d.Quantity++
			stacks[key] = d
		}
		d := codex[v.CodexID]
		if d == nil {
			d = &codexDelta{tier: "normal"}
			codex[v.CodexID] = d
		}
		d.count++
		if v.Size != nil {
			if d.min == nil || *v.Size < *d.min {
				d.min = v.Size
			}
			if d.max == nil || *v.Size > *d.max {
				d.max = v.Size
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, t.OperationID(), i+1, owner, v.ID, *v.Size, ground, spot, now); err != nil {
				return err
			}
		}
		if v.Tier == "giant" || v.Tier == "large" && d.tier != "giant" {
			d.tier = v.Tier
		}
	}
	// One ledger delta per item/tier per operation, including recursive catches.
	keys := make([]string, 0, len(stacks))
	for key := range stacks {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for start := 0; start < len(keys); start += 100 {
		end := min(start+100, len(keys))
		deltas := make([]assets.StackDelta, 0, end-start)
		for _, key := range keys[start:end] {
			deltas = append(deltas, stacks[key])
		}
		if err := t.Stacks(ctx, owner, deltas); err != nil {
			return err
		}
	}
	keys = keys[:0]
	for key := range codex {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, id := range keys {
		d := codex[id]
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at,min_size,max_size,best_tier) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(owner_id,item_id) DO UPDATE SET count=fishing.player_codex.count+EXCLUDED.count,min_size=LEAST(fishing.player_codex.min_size,EXCLUDED.min_size),max_size=GREATEST(fishing.player_codex.max_size,EXCLUDED.max_size),best_tier=CASE WHEN fishing.player_codex.best_tier='giant' OR EXCLUDED.best_tier='giant' THEN 'giant' WHEN fishing.player_codex.best_tier='large' OR EXCLUDED.best_tier='large' THEN 'large' ELSE 'normal' END`, owner, id, d.count, now, d.min, d.max, d.tier); err != nil {
			return err
		}
	}
	if len(catches) > 0 {
		var count int64
		if err := t.SQL().QueryRow(ctx, `SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&count); err != nil {
			return err
		}
		if count > assets.MaxCoins-int64(len(catches)) {
			return assets.ErrDeferred
		}
		_, err := t.SQL().Exec(ctx, `UPDATE fishing.player_state SET catch_count=catch_count+$2 WHERE account_id=$1`, owner, len(catches))
		return err
	}
	return nil
}

// Record is an immutable catch, unaffected by inventory sales or transfers.
type Record struct {
	OwnerID  int64     `json:"ownerId,string"`
	ItemID   string    `json:"itemId"`
	Size     float64   `json:"size"`
	GroundID string    `json:"groundId"`
	SpotID   string    `json:"spotId"`
	CaughtAt time.Time `json:"caughtAt"`
}

// Records returns bounded personal (owner>0) or global (owner=0) rankings.
// Ties retain the first settled catch. This is not the legacy records API.
func (s *NativeService) Records(ctx context.Context, owner int64, item string, small bool, limit int) ([]Record, error) {
	it, ok := s.catalog.Item(item)
	if owner < 0 || !ok || it.Kind != "fish" || limit < 1 || limit > 100 {
		return nil, assets.ErrInvalid
	}
	direction := "DESC"
	if small {
		direction = "ASC"
	}
	rows, err := s.pool.Query(ctx, `SELECT owner_id,item_id,size,ground_id,spot_id,caught_at FROM fishing.catch_records WHERE item_id=$1 AND ($2::bigint=0 OR owner_id=$2) ORDER BY size `+direction+`,caught_at,operation_id,ordinal LIMIT $3`, item, owner, limit)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	result := []Record{}
	for rows.Next() {
		var r Record
		if err = rows.Scan(&r.OwnerID, &r.ItemID, &r.Size, &r.GroundID, &r.SpotID, &r.CaughtAt); err != nil {
			return nil, assets.ErrUnavailable
		}
		result = append(result, r)
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	return result, nil
}
