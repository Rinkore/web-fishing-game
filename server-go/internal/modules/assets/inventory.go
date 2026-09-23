package assets

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type StackDelta struct {
	ItemID   string
	Tier     string
	Quantity int64
}
type EquipmentSpec struct {
	DefinitionID string
	Part         string
	Attributes   json.RawMessage
}

// Change is a server-resolved reward/craft/consume plan, NEVER client input.
// The caller verifies recipes, rule versions, costs and RNG before invoking it.
// Inputs are immutable across retries; it cannot reroll a failed transaction.
type Change struct {
	ActorID                         int64
	RequestKey, Reason, RuleVersion string
	Coins                           int64
	Stacks                          []StackDelta
	Create                          []EquipmentSpec
	Consume                         []int64
}

// Exchange transfers a bundle atomically from ActorID to RecipientID. Positive
// coins/items move actor -> recipient, negative values move in reverse. All
// listed equipment moves actor -> recipient. Gameplay permissions are external.
type Exchange struct {
	ActorID, RecipientID int64
	RequestKey           string
	Coins                int64
	Stacks               []StackDelta
	Equipment            []int64
}

func partValid(part string) bool {
	switch part {
	case "rod", "line", "hook", "bait", "reel", "accessory", "charm":
		return true
	}
	return false
}
func amountValid(n int64) bool { return n >= -MaxCoins && n <= MaxCoins }
func normalizeStacks(input []StackDelta) ([]StackDelta, bool) {
	if len(input) > 100 {
		return nil, false
	}
	out := append([]StackDelta{}, input...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].ItemID == out[j].ItemID {
			return out[i].Tier < out[j].Tier
		}
		return out[i].ItemID < out[j].ItemID
	})
	for i, v := range out {
		if !validKey(v.ItemID) || !amountValid(v.Quantity) || v.Quantity == 0 {
			return nil, false
		}
		if v.Tier != "normal" && v.Tier != "large" && v.Tier != "giant" {
			return nil, false
		}
		if i > 0 && out[i-1].ItemID == v.ItemID && out[i-1].Tier == v.Tier {
			return nil, false
		}
	}
	return out, true
}
func normalizeIDs(ids []int64) ([]int64, bool) {
	if len(ids) > 128 {
		return nil, false
	}
	out := append([]int64{}, ids...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	for i, id := range out {
		if id <= 0 || i > 0 && out[i-1] == id {
			return nil, false
		}
	}
	return out, true
}
func fingerprint(value any) []byte {
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return hash[:]
}

func (s *Service) ApplyChange(ctx context.Context, c Change) (Result, error) {
	var ok bool
	if c.ActorID <= 0 || !validRequestKey(c.RequestKey) || !validKey(c.RuleVersion) || !amountValid(c.Coins) || len(c.Create) > 100 {
		return Result{}, ErrInvalid
	}
	if c.Reason != "reward" && c.Reason != "craft" && c.Reason != "consume" {
		return Result{}, ErrInvalid
	}
	c.Stacks, ok = normalizeStacks(c.Stacks)
	if !ok {
		return Result{}, ErrInvalid
	}
	c.Consume, ok = normalizeIDs(c.Consume)
	if !ok {
		return Result{}, ErrInvalid
	}
	c.Create = append([]EquipmentSpec{}, c.Create...)
	for i, spec := range c.Create {
		if !validKey(spec.DefinitionID) || !partValid(spec.Part) || len(spec.Attributes) > 32768 || !utf8.Valid(spec.Attributes) {
			return Result{}, ErrInvalid
		}
		value, err := canonicalAttributes(spec.Attributes)
		if err != nil {
			return Result{}, ErrInvalid
		}
		c.Create[i].Attributes = value
	}
	if c.Coins == 0 && len(c.Stacks)+len(c.Create)+len(c.Consume) == 0 {
		return Result{}, ErrInvalid
	}
	// Explicit sources/sinks are narrowed further before database access.
	if c.Reason == "reward" && (c.Coins < 0 || len(c.Consume) > 0) {
		return Result{}, ErrInvalid
	}
	if c.Reason == "consume" && (c.Coins > 0 || len(c.Create) > 0) {
		return Result{}, ErrInvalid
	}
	for _, v := range c.Stacks {
		if c.Reason == "reward" && v.Quantity < 0 || c.Reason == "consume" && v.Quantity > 0 {
			return Result{}, ErrInvalid
		}
	}
	hash := fingerprint(struct {
		Version string
		Plan    Change
	}{"asset-change-v1", c})
	return s.execute(ctx, command{c.ActorID, c.RequestKey, "asset_change", c.RuleVersion, hash, []int64{c.ActorID}}, func(ctx context.Context, u *assetTx) (Result, error) {
		if err := u.coins(ctx, c.ActorID, c.Coins); err != nil {
			return Result{}, err
		}
		if err := u.stacks(ctx, c.ActorID, c.Stacks); err != nil {
			return Result{}, err
		}
		for _, id := range c.Consume {
			if err := u.moveEquipment(ctx, c.ActorID, 0, id); err != nil {
				return Result{}, err
			}
		}
		r := Result{Status: "applied"}
		for _, spec := range c.Create {
			id, err := u.createEquipment(ctx, c.ActorID, spec)
			if err != nil {
				return Result{}, err
			}
			r.EquipmentIDs = append(r.EquipmentIDs, strconv.FormatInt(id, 10))
		}
		return r, nil
	})
}

func (s *Service) ExchangeAssets(ctx context.Context, r Exchange) (Result, error) {
	var ok bool
	if r.ActorID <= 0 || r.RecipientID <= 0 || r.ActorID == r.RecipientID || !validRequestKey(r.RequestKey) || !amountValid(r.Coins) {
		return Result{}, ErrInvalid
	}
	r.Stacks, ok = normalizeStacks(r.Stacks)
	if !ok {
		return Result{}, ErrInvalid
	}
	r.Equipment, ok = normalizeIDs(r.Equipment)
	if !ok {
		return Result{}, ErrInvalid
	}
	if r.Coins == 0 && len(r.Stacks)+len(r.Equipment) == 0 {
		return Result{}, ErrInvalid
	}
	hash := fingerprint(struct {
		Version string
		Plan    Exchange
	}{"asset-exchange-v1", r})
	return s.execute(ctx, command{r.ActorID, r.RequestKey, "asset_exchange", "asset-exchange-v1", hash, []int64{r.ActorID, r.RecipientID}}, func(ctx context.Context, u *assetTx) (Result, error) {
		if err := u.coins(ctx, r.ActorID, -r.Coins); err != nil {
			return Result{}, err
		}
		if err := u.coins(ctx, r.RecipientID, r.Coins); err != nil {
			return Result{}, err
		}
		out := append([]StackDelta{}, r.Stacks...)
		for i := range out {
			out[i].Quantity = -out[i].Quantity
		}
		if err := u.stacks(ctx, r.ActorID, out); err != nil {
			return Result{}, err
		}
		if err := u.stacks(ctx, r.RecipientID, r.Stacks); err != nil {
			return Result{}, err
		}
		for _, id := range r.Equipment {
			if err := u.moveEquipment(ctx, r.ActorID, r.RecipientID, id); err != nil {
				return Result{}, err
			}
		}
		return Result{Status: "exchanged"}, nil
	})
}

func (u *assetTx) coins(ctx context.Context, owner, delta int64) error {
	if delta == 0 {
		return nil
	}
	var before int64
	if err := u.tx.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", owner).Scan(&before); err != nil {
		return err
	}
	if delta < 0 && before < -delta {
		return rejection("insufficient_funds")
	}
	if delta > 0 && before > MaxCoins-delta {
		return rejection("balance_limit")
	}
	after := before + delta
	if _, err := u.tx.Exec(ctx, "UPDATE fishing.wallets SET coins=$2 WHERE account_id=$1", owner, after); err != nil {
		return err
	}
	_, err := u.tx.Exec(ctx, "INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES ($1,$2,$3,$4)", u.op, owner, delta, after)
	return err
}

func (u *assetTx) stacks(ctx context.Context, owner int64, deltas []StackDelta) error {
	for _, d := range deltas {
		var kind string
		if err := u.tx.QueryRow(ctx, "SELECT kind FROM fishing.item_definitions WHERE id=$1", d.ItemID).Scan(&kind); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return rejection("unknown_item")
			}
			return err
		}
		if kind == "equipment" || kind != "fish" && d.Tier != "normal" {
			return rejection("invalid_item_tier")
		}
		var before int64
		err := u.tx.QueryRow(ctx, "SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier=$3", owner, d.ItemID, d.Tier).Scan(&before)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if d.Quantity < 0 && before < -d.Quantity {
			return rejection("insufficient_items")
		}
		if d.Quantity > 0 && before > MaxCoins-d.Quantity {
			return rejection("quantity_limit")
		}
		after := before + d.Quantity
		if _, err = u.tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=EXCLUDED.quantity`, owner, d.ItemID, kind, d.Tier, after); err != nil {
			return err
		}
		if _, err = u.tx.Exec(ctx, `INSERT INTO fishing.inventory_entries(operation_id,owner_id,item_id,tier,delta,quantity_after) VALUES ($1,$2,$3,$4,$5,$6)`, u.op, owner, d.ItemID, d.Tier, d.Quantity, after); err != nil {
			return err
		}
	}
	// Check the final total across tiers, so relabeling a fish never double counts
	// intermediate state. Player guard also protects absent inventory rows.
	for i, d := range deltas {
		if i > 0 && deltas[i-1].ItemID == d.ItemID {
			continue
		}
		var tooLarge bool
		if err := u.tx.QueryRow(ctx, "SELECT COALESCE(sum(quantity),0)>$3 FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2", owner, d.ItemID, MaxCoins).Scan(&tooLarge); err != nil {
			return err
		}
		if tooLarge {
			return rejection("quantity_limit")
		}
	}
	return nil
}

func (u *assetTx) createEquipment(ctx context.Context, owner int64, spec EquipmentSpec) (int64, error) {
	var allowed bool
	if err := u.tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM fishing.item_definitions WHERE id=$1 AND kind='equipment' AND part=$2)", spec.DefinitionID, spec.Part).Scan(&allowed); err != nil {
		return 0, err
	}
	if !allowed {
		return 0, rejection("invalid_equipment_definition")
	}
	var id int64
	if err := u.tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES ($1,$2,$3,$4,$5) RETURNING id`, owner, spec.DefinitionID, spec.Part, []byte(spec.Attributes), u.op).Scan(&id); err != nil {
		return 0, err
	}
	_, err := u.tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES ($1,$2,$3,'create')`, u.op, id, owner)
	return id, err
}

func (u *assetTx) moveEquipment(ctx context.Context, from, to, id int64) error {
	if to != 0 {
		var locked bool
		if err := u.tx.QueryRow(ctx, `SELECT COALESCE((attributes->>'bound')::boolean,false) FROM fishing.equipment_instances WHERE id=$1`, id).Scan(&locked); err != nil {
			return err
		}
		if locked {
			return rejection("bound_equipment")
		}
	}
	var owner int64
	var lifecycle string
	err := u.tx.QueryRow(ctx, "SELECT owner_id,lifecycle FROM fishing.equipment_instances WHERE id=$1 FOR UPDATE", id).Scan(&owner, &lifecycle)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (owner != from || lifecycle != "available") {
		return rejection("equipment_unavailable")
	}
	if err != nil {
		return err
	}
	var bound bool
	if err = u.tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM fishing.rod_components WHERE equipment_id=$1)", id).Scan(&bound); err != nil {
		return err
	}
	if bound {
		return rejection("equipment_locked")
	}
	if to == 0 {
		if _, err = u.tx.Exec(ctx, "UPDATE fishing.equipment_instances SET lifecycle='consumed' WHERE id=$1", id); err != nil {
			return err
		}
		_, err = u.tx.Exec(ctx, "INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES ($1,$2,$3,'consume')", u.op, id, from)
	} else {
		if _, err = u.tx.Exec(ctx, "UPDATE fishing.equipment_instances SET owner_id=$2 WHERE id=$1", id, to); err != nil {
			return err
		}
		_, err = u.tx.Exec(ctx, "INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,next_owner,action) VALUES ($1,$2,$3,$4,'transfer')", u.op, id, from, to)
	}
	return err
}
