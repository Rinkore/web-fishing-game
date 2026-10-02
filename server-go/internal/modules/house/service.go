package house

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const ruleVersion = "house-v2"

// secondSlotLevel opens the second companion slot. The design pins it to Lv8;
// HutConfig carries the unlock level and the slot count, so the split lives here.
const secondSlotLevel = 8

// workerInterval keeps the auto-collect sweep well below a 2-minute cadence.
const workerInterval = 90 * time.Second

// stealPickCeiling is the hard ceiling on daily picks. Roles and prestige can
// raise the budget, never past this.
const stealPickCeiling = 5

// autoCollectLossDefault is the default coin-loss fraction when a collect-pet
// auto-harvests a batch (5%).
const autoCollectLossDefault = 0.05

type Service struct {
	pool *pgxpool.Pool
	c    *rules.Catalog
	a    *assets.Service
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service {
	return &Service{pool: pool, c: c, a: assets.New(pool)}
}

func (s *Service) hut() rules.HutConfig { return s.c.HutConfig() }

// affinityMax is the affinity cap of a single companion.
func affinityMax(h rules.HutConfig) int {
	if h.PetPerLevel <= 0 {
		return 0
	}
	return int(math.Round(h.PetBonusCap / h.PetPerLevel))
}

// trackCap is the per-track point cap.
func trackCap(h rules.HutConfig) int {
	if h.RolePerPoint <= 0 {
		return h.RolePointsMax
	}
	cap := int(math.Round(h.RoleBonusCap / h.RolePerPoint))
	if cap > h.RolePointsMax {
		cap = h.RolePointsMax
	}
	return cap
}

// slotsFor is the number of companions a house of this level may station.
func slotsFor(h rules.HutConfig, level int) int {
	if level < h.BonusUnlockLevel {
		return 0
	}
	if level < secondSlotLevel {
		return 1
	}
	return h.PetSlots
}

// input is the immutable, server-built command input.
type input struct {
	Op       string `json:"op"`
	PetID    string `json:"petId,omitempty"`
	Action   string `json:"action,omitempty"`
	Track    string `json:"track,omitempty"`
	Points   int    `json:"points,omitempty"`
	Target   string `json:"target,omitempty"`
	TargetID int64  `json:"targetId,omitempty,string"`
	SlotIdx  int    `json:"slotIdx,omitempty"`
	FishID   string `json:"fishId,omitempty"`
	FishTier string `json:"fishTier,omitempty"`
	Phases   string `json:"phases,omitempty"` // comma-separated phase ids
}

func (s *Service) run(ctx context.Context, actor int64, key, kind string, players []int64, in input, apply func(context.Context, *assets.Transaction) (assets.Result, error)) (assets.Result, error) {
	return s.a.Run(ctx, assets.Command{
		ActorID:     actor,
		RequestKey:  key,
		Kind:        kind,
		RuleVersion: ruleVersion,
		Players:     players,
		Input:       in,
	}, apply)
}

// lockRow guarantees the row exists and holds it for the rest of the command.
func lockRow(ctx context.Context, t *assets.Transaction, owner int64) (row, error) {
	if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.house_state(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING`, owner); err != nil {
		return row{}, err
	}
	r := row{Level: 1, Pets: Pets{}, Roles: Roles{}}
	var pets, roles, extra []byte
	if err := t.SQL().QueryRow(ctx, `SELECT level,endless,prestige,pets,roles,state FROM fishing.house_state WHERE owner_id=$1 FOR UPDATE`, owner).
		Scan(&r.Level, &r.Endless, &r.Prestige, &pets, &roles, &extra); err != nil {
		return row{}, err
	}
	for _, pair := range []struct {
		raw []byte
		out any
	}{{pets, &r.Pets}, {roles, &r.Roles}, {extra, &r.extras}} {
		if len(pair.raw) == 0 {
			continue
		}
		if err := json.Unmarshal(pair.raw, pair.out); err != nil {
			return row{}, err
		}
	}
	r.normalize()
	return r, nil
}

// holdings reads the player's material stock for the requested ids.
func holdings(ctx context.Context, q assets.SQL, owner int64, ids []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT item_id,COALESCE(sum(quantity),0) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=ANY($2::text[]) GROUP BY item_id`, owner, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int64
		if err = rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// charge spends coins and materials.
func charge(ctx context.Context, t *assets.Transaction, owner int64, coins int64, items map[string]int64) error {
	if coins > 0 {
		var balance int64
		if err := t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&balance); err != nil {
			return err
		}
		if balance < coins {
			return assets.Rejection("house_coin_insufficient")
		}
		if err := t.Coins(ctx, owner, -coins); err != nil {
			return err
		}
	}
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	for id, n := range items {
		if n > 0 {
			ids = append(ids, id)
		}
	}
	held, err := holdings(ctx, t.SQL(), owner, ids)
	if err != nil {
		return err
	}
	deltas := make([]assets.StackDelta, 0, len(ids))
	for _, id := range ids {
		if held[id] < items[id] {
			return assets.Rejection("house_material_insufficient")
		}
		deltas = append(deltas, assets.StackDelta{ItemID: id, Tier: "normal", Quantity: -items[id]})
	}
	if len(deltas) == 0 {
		return nil
	}
	return t.Stacks(ctx, owner, deltas)
}

// ── read side ───────────────────────────────────────────────────────────────

// View materialises the house row and returns the authoritative projection.
func (s *Service) View(ctx context.Context, owner int64) (View, error) {
	h := s.hut()
	if _, err := s.pool.Exec(ctx, `INSERT INTO fishing.house_state(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING`, owner); err != nil {
		return View{}, err
	}
	r := row{Level: 1, Pets: Pets{}, Roles: Roles{}}
	var pets, roles, extra []byte
	err := s.pool.QueryRow(ctx, `SELECT level,endless,prestige,pets,roles,state FROM fishing.house_state WHERE owner_id=$1`, owner).
		Scan(&r.Level, &r.Endless, &r.Prestige, &pets, &roles, &extra)
	if err != nil {
		return View{}, err
	}
	for _, pair := range []struct {
		raw []byte
		out any
	}{{pets, &r.Pets}, {roles, &r.Roles}, {extra, &r.extras}} {
		if len(pair.raw) == 0 {
			continue
		}
		if err = json.Unmarshal(pair.raw, pair.out); err != nil {
			return View{}, err
		}
	}
	r.normalize()

	prodAffinity := stationedProductionAffinity(h, r.Stationed, r.Pets)
	now := time.Now().UTC()

	slots := make([]RackSlotView, 0, len(r.Racks))
	for _, rs := range r.Racks {
		sv := rackSlotToView(h, rs, prodAffinity, now)
		slots = append(slots, sv)
	}

	view := View{
		OwnerID:      owner,
		Level:        r.Level,
		Endless:      r.Endless,
		Prestige:     r.Prestige,
		Pets:         r.Pets,
		Roles:        r.Roles,
		Stationed:    append([]string{}, r.Stationed...),
		Slots:        slotsFor(h, r.Level),
		RackSlots:    slots,
		RackCapacity: rackCapacityFor(h, r.Level),
		Steal:        StealView{CoinCap: h.StealDailyCoinCap, Heat: r.Heat},
	}
	if cost, ok := h.Cost(r.Level); ok {
		view.NextCost = &Cost{Coins: cost.Coins, Items: cost.Items}
	}
	if r.Level >= h.MaxLevel() {
		coins, relic, alloy := h.RenovatePrice(r.Endless + 1)
		items := map[string]int64{}
		if relic > 0 {
			items["storm_relic"] = relic
		}
		if alloy > 0 {
			items["gear_alloy"] = alloy
		}
		view.RenovateCost = &Cost{Coins: coins, Items: items}
	}
	if err = readStealBudget(ctx, s.pool, h, owner, r, &view.Steal); err != nil {
		return View{}, err
	}
	return view, nil
}

// rackSlotToView converts an internal RackSlot to its client projection.
func rackSlotToView(h rules.HutConfig, rs RackSlot, prodAffinity int, now time.Time) RackSlotView {
	sv := RackSlotView{
		SlotIdx:  rs.SlotIdx,
		FishID:   rs.FishID,
		FishTier: rs.FishTier,
		Phases:   rs.Phases,
		PhaseIdx: rs.PhaseIdx,
		Done:     rs.Done,
		Premium:  rs.Premium,
	}
	if !rs.Done && len(rs.Phases) > 0 {
		elapsed := now.Sub(rs.StartedAt).Hours()
		remaining := 0.0
		for i := rs.PhaseIdx; i < len(rs.Phases); i++ {
			if sc, ok := rackStageConfig(h, rs.Phases[i]); ok {
				if i == rs.PhaseIdx {
					stageH := sc.Hours
					if prodAffinity > 0 {
						for _, rc := range h.PetRoles {
							if rc.ID == "production" && rc.SpeedBonus > 0 {
								frac := float64(prodAffinity) * rc.SpeedBonus
								if frac > 0.5 {
									frac = 0.5
								}
								stageH *= (1.0 - frac)
								break
							}
						}
					}
					rem := stageH - elapsed
					if rem < 0 {
						rem = 0
					}
					remaining += rem
				} else {
					remaining += sc.Hours
				}
			}
		}
		sv.ReadyAt = now.Add(time.Duration(remaining * float64(time.Hour)))
	}
	return sv
}

// readStealBudget fills today's picks and coin usage.
func readStealBudget(ctx context.Context, q assets.SQL, h rules.HutConfig, owner int64, r row, out *StealView) error {
	max := h.StealPicksPerDay
	if r.Roles != nil {
		max += r.Roles["trader"]
	}
	if max > stealPickCeiling {
		max = stealPickCeiling
	}
	if max < 0 {
		max = 0
	}
	out.PicksMax = max
	out.PicksLeft = max
	var picks int
	var used int64
	if err := q.QueryRow(ctx, `SELECT count(*),COALESCE(sum(coins),0) FROM fishing.house_steals WHERE actor_id=$1 AND day_bucket=(`+dayBucketSQL+`)`, owner).Scan(&picks, &used); err != nil {
		return err
	}
	if used > out.CoinCap {
		used = out.CoinCap
	}
	out.CoinUsed = used
	if picks < out.PicksMax {
		out.PicksLeft = out.PicksMax - picks
	} else {
		out.PicksLeft = 0
	}
	return nil
}

const dayBucketSQL = `extract(epoch FROM date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'))/86400`

// ── write side ──────────────────────────────────────────────────────────────

// PlaceFish puts a fish on a rack slot with the chosen processing chain.
// fishID must be a catalog item of kind "fish". Price and tier are resolved
// from the catalog — the caller must not supply them.
// chain must contain "dry" exactly once; "pre" and "post" are optional.
func (s *Service) PlaceFish(ctx context.Context, owner int64, key, fishID string, slotIdx int, chain []string) (assets.Result, error) {
	if fishID == "" || slotIdx < 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	for _, p := range chain {
		if p != PhasePrep && p != PhaseDry && p != PhasePost {
			return assets.Result{}, assets.ErrInvalid
		}
	}
	// Resolve price and tier from the catalog server-side — never trust the client.
	item, ok := s.c.Item(fishID)
	if !ok || item.Kind != "fish" {
		return assets.Result{}, assets.Rejection("house_fish_unknown")
	}
	fishPrice := int64(item.Price)
	fishTier := s.c.FishTier(fishID)
	if fishTier == "" {
		fishTier = item.Rarity // fall back to item rarity when tier index is absent
	}

	chainStr := strings.Join(chain, ",")
	return s.run(ctx, owner, key, "house_place", []int64{owner}, input{Op: "place", FishID: fishID, FishTier: fishTier, SlotIdx: slotIdx, Phases: chainStr}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		cap := rackCapacityFor(h, r.Level)
		if cap <= 0 {
			return assets.Result{}, assets.Rejection("house_rack_locked")
		}
		if slotIdx >= cap {
			return assets.Result{}, assets.Rejection("house_rack_slot_invalid")
		}
		for _, rs := range r.Racks {
			if rs.SlotIdx == slotIdx {
				return assets.Result{}, assets.Rejection("house_rack_slot_occupied")
			}
		}
		hasDry := false
		for _, p := range chain {
			if p == PhaseDry {
				hasDry = true
			}
		}
		if !hasDry {
			return assets.Result{}, assets.Rejection("house_rack_chain_invalid")
		}
		for _, p := range chain {
			if sc, ok2 := rackStageConfig(h, p); ok2 {
				if sc.MinCookLevel > 0 && r.Roles["cook"] < sc.MinCookLevel {
					return assets.Result{}, assets.Rejection("house_stage_locked_cook")
				}
				if sc.MinBrineLevel > 0 && r.Roles["brine"] < sc.MinBrineLevel {
					return assets.Result{}, assets.Rejection("house_stage_locked_brine")
				}
			}
		}
		if err = charge(ctx, t, owner, 0, map[string]int64{fishID: 1}); err != nil {
			return assets.Result{}, err
		}
		for _, p := range chain {
			if p == PhasePrep {
				if sc, ok2 := rackStageConfig(h, PhasePrep); ok2 && sc.MaterialCost != "" && sc.MaterialQty > 0 {
					if err = charge(ctx, t, owner, 0, map[string]int64{sc.MaterialCost: sc.MaterialQty}); err != nil {
						return assets.Result{}, err
					}
				}
			}
		}
		rs := RackSlot{
			SlotIdx:   slotIdx,
			FishID:    fishID,
			FishTier:  fishTier,
			FishPrice: fishPrice,
			Phases:    chain,
			PhaseIdx:  0,
			StartedAt: time.Now().UTC(),
		}
		r.Racks = append(r.Racks, rs)
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "placed", ResourceID: strconv.Itoa(slotIdx)}, nil
	})
}

// CollectRack collects all finished batches, pays their coin value, and
// clears those slots. lossy=true applies the auto-collect pet loss fraction
// (used by the worker sweep); player-triggered collect is always lossless.
func (s *Service) CollectRack(ctx context.Context, owner int64, key string, lossy bool) (assets.Result, error) {
	return s.run(ctx, owner, key, "house_collect_rack", []int64{owner}, input{Op: "collect_rack"}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		now := time.Now().UTC()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if r.Frozen {
			return assets.Result{Status: "frozen"}, nil
		}

		prodAffinity := stationedProductionAffinity(h, r.Stationed, r.Pets)
		advancePhases(h, &r, prodAffinity, now)

		total := int64(0)
		kept := r.Racks[:0]
		for _, rs := range r.Racks {
			if !rs.Done {
				kept = append(kept, rs)
				continue
			}
			coins := batchCoins(h, rs.FishPrice, rs.FishTier, rs.Phases, r.Roles["cook"], prodAffinity, rs.Premium)
			if lossy {
				loss := autoCollectLossDefault
				for _, rc := range h.PetRoles {
					if rc.ID == "collect" && rc.CollectLoss > 0 {
						loss = rc.CollectLoss
						break
					}
				}
				coins = int64(float64(coins) * (1.0 - loss))
			}
			total += coins
		}
		r.Racks = kept

		if total <= 0 {
			return assets.Result{Status: "nothing_ready"}, nil
		}
		if err = t.Coins(ctx, owner, total); err != nil {
			return assets.Result{}, err
		}
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		var balance int64
		if err = t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&balance); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "collected", RecipientBalance: balance, ResourceID: strconv.FormatInt(total, 10)}, nil
	})
}

// advancePhases updates all rack slots: completes phases whose time has
// elapsed, rolls the premium die on the final phase, and marks Done.
func advancePhases(h rules.HutConfig, r *row, prodAffinity int, now time.Time) {
	pchance := premiumChance(h, prodAffinity)
	updated := make([]RackSlot, len(r.Racks))
	copy(updated, r.Racks)
	for i, rs := range updated {
		if rs.Done || len(rs.Phases) == 0 {
			continue
		}
		elapsed := now.Sub(rs.StartedAt).Hours()
		for rs.PhaseIdx < len(rs.Phases) {
			phase := rs.Phases[rs.PhaseIdx]
			sc, ok := rackStageConfig(h, phase)
			if !ok {
				rs.PhaseIdx++
				continue
			}
			stageH := sc.Hours
			if prodAffinity > 0 {
				for _, rc := range h.PetRoles {
					if rc.ID == "production" && rc.SpeedBonus > 0 {
						frac := float64(prodAffinity) * rc.SpeedBonus
						if frac > 0.5 {
							frac = 0.5
						}
						stageH *= (1.0 - frac)
						break
					}
				}
			}
			if elapsed < stageH {
				break
			}
			elapsed -= stageH
			rs.StartedAt = rs.StartedAt.Add(time.Duration(stageH * float64(time.Hour)))
			rs.PhaseIdx++
		}
		if rs.PhaseIdx >= len(rs.Phases) {
			rs.Done = true
			rs.Premium = rand.Float64() < pchance //nolint:gosec
		}
		updated[i] = rs
	}
	r.Racks = updated
}

// Upgrade walks the main track Lv1 → Lv10.
func (s *Service) Upgrade(ctx context.Context, owner int64, key string) (assets.Result, error) {
	return s.run(ctx, owner, key, "house_upgrade", []int64{owner}, input{Op: "upgrade"}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if r.Level >= h.MaxLevel() {
			return assets.Result{}, assets.Rejection("house_level_max")
		}
		cost, ok := h.Cost(r.Level)
		if !ok {
			return assets.Result{}, assets.Rejection("house_level_max")
		}
		if err = charge(ctx, t, owner, cost.Coins, cost.Items); err != nil {
			return assets.Result{}, err
		}
		r.Level++
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "upgraded", ResourceID: strconv.Itoa(r.Level)}, nil
	})
}

// Renovate is the endless layer.
func (s *Service) Renovate(ctx context.Context, owner int64, key string) (assets.Result, error) {
	return s.run(ctx, owner, key, "house_upgrade", []int64{owner}, input{Op: "renovate"}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if r.Level < h.MaxLevel() {
			return assets.Result{}, assets.Rejection("house_level_max")
		}
		coins, relic, alloy := h.RenovatePrice(r.Endless + 1)
		items := map[string]int64{}
		if relic > 0 {
			items["storm_relic"] = relic
		}
		if alloy > 0 {
			items["gear_alloy"] = alloy
		}
		if err = charge(ctx, t, owner, coins, items); err != nil {
			return assets.Result{}, err
		}
		r.Endless++
		r.Prestige++
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "renovated", ResourceID: strconv.Itoa(r.Endless)}, nil
	})
}

// Pet feeds affinity and manages the station list.
func (s *Service) Pet(ctx context.Context, owner int64, key, petID, action string) (assets.Result, error) {
	petID = strings.TrimSpace(petID)
	if petID == "" || len(petID) > 32 || !petIDValid(petID) {
		return assets.Result{}, assets.ErrInvalid
	}
	if action != "feed" && action != "station" && action != "unstow" {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.run(ctx, owner, key, "house_pet", []int64{owner}, input{Op: "pet", PetID: petID, Action: action}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		switch action {
		case "feed":
			if max := affinityMax(h); max > 0 && r.Pets[petID] >= max {
				return assets.Result{}, assets.Rejection("house_pet_max")
			}
			if err = charge(ctx, t, owner, 0, map[string]int64{petFeedItem: 1}); err != nil {
				return assets.Result{}, err
			}
			r.Pets[petID]++
		case "station":
			if !containsPet(r.Stationed, petID) {
				slots := slotsFor(h, r.Level)
				if slots <= 0 || len(r.Stationed) >= slots {
					return assets.Result{}, assets.Rejection("house_pet_slot")
				}
				r.Stationed = append(r.Stationed, petID)
			}
		default:
			r.Stationed = removePet(r.Stationed, petID)
		}
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "pet_" + action, ResourceID: strconv.Itoa(r.Pets[petID])}, nil
	})
}

// Role invests points into one of the three tracks.
func (s *Service) Role(ctx context.Context, owner int64, key, track string, points int) (assets.Result, error) {
	if !trackValid(track) || points < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.run(ctx, owner, key, "house_role", []int64{owner}, input{Op: "role", Track: track, Points: points}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		h := s.hut()
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		used := 0
		for _, n := range r.Roles {
			used += n
		}
		if r.Roles[track]+points > trackCap(h) || used+points > h.RolePointsMax {
			return assets.Result{}, assets.Rejection("house_role_max")
		}
		r.Roles[track] += points
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "role_invested", ResourceID: strconv.Itoa(r.Roles[track])}, nil
	})
}

// Steal takes coins and one bait material from a friend's overflow.
// Guard pets intercept the steal probabilistically.
func (s *Service) Steal(ctx context.Context, actor int64, key, targetName string) (assets.Result, error) {
	targetName = strings.ToLower(strings.TrimSpace(targetName))
	if targetName == "" {
		return assets.Result{}, assets.Rejection("house_target_missing")
	}
	var target int64
	err := s.pool.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1 AND NOT retired`, targetName).Scan(&target)
	if errors.Is(err, pgx.ErrNoRows) {
		return assets.Result{}, assets.Rejection("house_target_missing")
	}
	if err != nil {
		return assets.Result{}, err
	}
	if target == actor {
		return assets.Result{}, assets.Rejection("house_target_missing")
	}
	return s.run(ctx, actor, key, "house_steal", []int64{actor, target}, input{Op: "steal", Target: targetName, TargetID: target}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		return s.steal(ctx, t, actor, target)
	})
}

func (s *Service) steal(ctx context.Context, t *assets.Transaction, actor, target int64) (assets.Result, error) {
	h := s.hut()
	var state string
	var mature bool
	err := t.SQL().QueryRow(ctx, `SELECT r.state,o.created_at<=clock_timestamp()-make_interval(hours=>$3::int)
FROM fishing.friend_relations r JOIN fishing.asset_operations o ON o.id=r.updated_operation
WHERE r.a_id=LEAST($1::bigint,$2::bigint) AND r.b_id=GREATEST($1::bigint,$2::bigint)`, actor, target, h.RelationshipMinHours).Scan(&state, &mature)
	if errors.Is(err, pgx.ErrNoRows) {
		return assets.Result{}, assets.Rejection("house_not_friend")
	}
	if err != nil {
		return assets.Result{}, err
	}
	if state != "accepted" {
		return assets.Result{}, assets.Rejection("house_not_friend")
	}
	if !mature {
		return assets.Result{}, assets.Rejection("house_friend_too_new")
	}

	victim, err := lockRow(ctx, t, target)
	if err != nil {
		return assets.Result{}, err
	}
	actorRow, err := lockRow(ctx, t, actor)
	if err != nil {
		return assets.Result{}, err
	}

	// Guard pet interception.
	guardAffinity := stationedGuardAffinity(h, victim.Stationed, victim.Pets)
	if guardAffinity > 0 {
		interceptProb := 0.0
		for _, rc := range h.PetRoles {
			if rc.ID == "guard" && rc.GuardRate > 0 {
				interceptProb = float64(guardAffinity) * rc.GuardRate
				if interceptProb > 0.85 {
					interceptProb = 0.85
				}
				break
			}
		}
		if rand.Float64() < interceptProb { //nolint:gosec
			return assets.Result{}, assets.Rejection("house_steal_intercepted")
		}
	}

	var bucket int64
	if err = t.SQL().QueryRow(ctx, `SELECT (`+dayBucketSQL+`)::bigint`).Scan(&bucket); err != nil {
		return assets.Result{}, err
	}
	budget := StealView{CoinCap: h.StealDailyCoinCap, Heat: victim.Heat}
	if err = readStealBudget(ctx, t.SQL(), h, actor, actorRow, &budget); err != nil {
		return assets.Result{}, err
	}
	if budget.PicksLeft <= 0 {
		return assets.Result{}, assets.Rejection("house_steal_limit")
	}
	var paired bool
	if err = t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.house_steals WHERE actor_id=$1 AND target_id=$2 AND day_bucket=$3)`, actor, target, bucket).Scan(&paired); err != nil {
		return assets.Result{}, err
	}
	if paired {
		return assets.Result{}, assets.Rejection("house_steal_pair_limit")
	}
	amount := int64(victim.Level) * h.StealPerLevel
	if amount > h.StealPerPickCap {
		amount = h.StealPerPickCap
	}
	if amount <= 0 {
		return assets.Result{}, assets.Rejection("house_steal_empty")
	}
	if budget.CoinUsed+amount > h.StealDailyCoinCap {
		return assets.Result{}, assets.Rejection("house_steal_daily_cap")
	}

	if err = t.Coins(ctx, actor, amount); err != nil {
		return assets.Result{}, err
	}
	gain := map[string]int64{petFeedItem: 1}
	if err = t.Stacks(ctx, actor, []assets.StackDelta{{ItemID: petFeedItem, Tier: "normal", Quantity: 1}}); err != nil {
		return assets.Result{}, err
	}
	items, err := json.Marshal(gain)
	if err != nil {
		return assets.Result{}, err
	}
	if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.house_steals(id,actor_id,target_id,day_bucket,coins,items) VALUES($1,$2,$3,$4,$5,$6)`,
		t.OperationID(), actor, target, bucket, amount, items); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return assets.Result{}, assets.Rejection("house_steal_pair_limit")
		}
		return assets.Result{}, err
	}
	victim.Heat++
	if err = writeRow(ctx, t, target, victim); err != nil {
		return assets.Result{}, err
	}
	return assets.Result{Status: "stolen", RecipientBalance: amount, ResourceID: strconv.FormatInt(amount, 10)}, nil
}

// AdminReset discards any in-progress rack state without paying out.
func (s *Service) AdminReset(ctx context.Context, actor, owner int64, key string) (assets.Result, error) {
	return s.run(ctx, actor, key, "house_settle", []int64{actor, owner}, input{Op: "admin_reset", TargetID: owner}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if _, err := lockRow(ctx, t, owner); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.house_state SET settled_at=clock_timestamp(),enabled_at=clock_timestamp() WHERE owner_id=$1`, owner); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "reset"}, nil
	})
}

// AdminFreeze stops or resumes the rack worker for one player.
func (s *Service) AdminFreeze(ctx context.Context, actor, owner int64, key string, freeze bool) (assets.Result, error) {
	status := "unfrozen"
	if freeze {
		status = "frozen"
	}
	return s.run(ctx, actor, key, "house_settle", []int64{actor, owner}, input{Op: "admin_freeze", TargetID: owner, Points: boolInt(freeze)}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		r, err := lockRow(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		r.Frozen = freeze
		if err = writeRow(ctx, t, owner, r); err != nil {
			return assets.Result{}, err
		}
		if !freeze {
			if _, err = t.SQL().Exec(ctx, `UPDATE fishing.house_state SET settled_at=clock_timestamp(),enabled_at=clock_timestamp() WHERE owner_id=$1`, owner); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: status}, nil
	})
}

// ── auto-collect worker ──────────────────────────────────────────────────────

// Sweep advances phase timers and auto-collects finished racks for online
// players who have a stationed collect-role pet.
func (s *Service) Sweep(ctx context.Context, after int64) (int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT h.owner_id
FROM fishing.house_state h
JOIN fishing.fishing_connections c ON c.owner_id=h.owner_id AND c.expires_at>clock_timestamp()
JOIN fishing.identities i ON i.account_id=h.owner_id AND NOT i.banned
WHERE h.owner_id>$1 AND NOT COALESCE((h.state->>'frozen')::boolean,false)
ORDER BY h.owner_id LIMIT 64`, after)
	if err != nil {
		return after, err
	}
	list := []int64{}
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return after, err
		}
		list = append(list, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return after, err
	}
	for _, id := range list {
		key := "house:auto:" + strconv.FormatInt(id, 10) + ":" + strconv.FormatInt(s.sweepBucket(ctx), 10)
		_, err = s.CollectRack(ctx, id, key, true)
		if err != nil && !errors.Is(err, assets.ErrDeferred) {
			return after, err
		}
		after = id
	}
	if len(list) < 64 {
		after = 0
	}
	return after, nil
}

func (s *Service) sweepBucket(ctx context.Context) int64 {
	var bucket int64
	_ = s.pool.QueryRow(ctx, `SELECT floor(extract(epoch FROM clock_timestamp())/1800)::bigint`).Scan(&bucket)
	return bucket
}

// Run keeps the collect-pet sweep ticking.
func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(workerInterval)
	defer ticker.Stop()
	var after int64
	var warned time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		c, _, err := catalog.Effective(work, s.pool)
		next := after
		if err == nil {
			copy := *s
			copy.c = c
			next, err = copy.Sweep(work, after)
		}
		cancel()
		after = next
		if err != nil && ctx.Err() == nil && time.Since(warned) > time.Minute {
			logger.Warn("house_sweep_retry")
			warned = time.Now()
		}
	}
}
