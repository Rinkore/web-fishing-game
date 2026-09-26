package house

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
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

const ruleVersion = "house-v1"

// secondSlotLevel opens the second companion slot. The design pins it to Lv8;
// HutConfig carries the unlock level and the slot count, so the split lives here.
const secondSlotLevel = 8

// workerInterval keeps settlement latency well inside the documented
// one-minute budget (design §9.4).
const workerInterval = 30 * time.Second

// stealPickCeiling is the hard ceiling on daily picks. Roles and prestige can
// raise the budget, never past this (design §5.2).
const stealPickCeiling = 5

type Service struct {
	pool *pgxpool.Pool
	c    *rules.Catalog
	a    *assets.Service
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service {
	return &Service{pool: pool, c: c, a: assets.New(pool)}
}

func (s *Service) hut() rules.HutConfig { return s.c.HutConfig() }

// affinityMax is the affinity cap of a single companion (+20% over ten levels).
func affinityMax(h rules.HutConfig) int {
	if h.PetPerLevel <= 0 {
		return 0
	}
	return int(math.Round(h.PetBonusCap / h.PetPerLevel))
}

// trackCap is the per-track point cap (three points for the shipped config).
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

// guardCoins is the red-team backstop (design §10.3 ⑤): a single settlement can
// never exceed one full day of the asymptotic rate. In a valid catalog it never
// binds — the real bound is the 8h pond — it only stops an implementation that
// forgot to clamp the elapsed window.
func guardCoins(h rules.HutConfig) int64 {
	return int64(math.Ceil(h.DailyMax(h.AsymptoteRate, h.PetBonusCap+h.RoleBonusCap)))
}

func (s *Service) bonus(h rules.HutConfig, r row) float64 {
	stationed := make([]int, 0, len(r.Stationed))
	for _, id := range r.Stationed {
		stationed = append(stationed, r.Pets[id])
	}
	return h.Bonus(r.Level, stationed, r.Roles)
}

// input is the immutable, server-built command input. Two requests that reuse a
// request key with different parameters are rejected as key conflicts.
type input struct {
	Op       string `json:"op"`
	PetID    string `json:"petId,omitempty"`
	Action   string `json:"action,omitempty"`
	Track    string `json:"track,omitempty"`
	Points   int    `json:"points,omitempty"`
	Target   string `json:"target,omitempty"`
	TargetID int64  `json:"targetId,omitempty,string"`
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

// consume empties the pond: it locks the row, measures the accrual against the
// server clock and advances settled_at in the same snapshot. Because the window
// is always measured against the previous settled_at, the lazy path and the
// worker can never pay for the same hours twice.
func consume(ctx context.Context, t *assets.Transaction, owner int64, capacity float64) (row, float64, error) {
	if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.house_state(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING`, owner); err != nil {
		return row{}, 0, err
	}
	r := row{Level: 1, Pets: Pets{}, Roles: Roles{}}
	var pets, roles, extra []byte
	var hours float64
	err := t.SQL().QueryRow(ctx, `
WITH prev AS (
 SELECT level,endless,prestige,pets,roles,state,settled_at,enabled_at,clock_timestamp() AS now_ts
   FROM fishing.house_state WHERE owner_id=$1 FOR UPDATE
), emptied AS (
 UPDATE fishing.house_state h SET settled_at=prev.now_ts FROM prev WHERE h.owner_id=$1
)
SELECT level,endless,prestige,pets,roles,state,
       GREATEST(LEAST(EXTRACT(EPOCH FROM (now_ts-GREATEST(settled_at,enabled_at)))/3600.0,$2::float8),0)
  FROM prev`, owner, capacity).Scan(&r.Level, &r.Endless, &r.Prestige, &pets, &roles, &extra, &hours)
	if err != nil {
		return row{}, 0, err
	}
	for _, pair := range []struct {
		raw []byte
		out any
	}{{pets, &r.Pets}, {roles, &r.Roles}, {extra, &r.extras}} {
		if len(pair.raw) == 0 {
			continue
		}
		if err := json.Unmarshal(pair.raw, pair.out); err != nil {
			return row{}, 0, err
		}
	}
	r.normalize()
	return r, hours, nil
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

// charge spends coins and materials with the module's own rejection codes, then
// delegates the actual transfer to the shared asset transaction.
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

// View is the authoritative projection. It also materialises the row so that a
// first visit starts the pond instead of silently dropping the elapsed window.
func (s *Service) View(ctx context.Context, owner int64) (View, error) {
	h := s.hut()
	if _, err := s.pool.Exec(ctx, `INSERT INTO fishing.house_state(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING`, owner); err != nil {
		return View{}, err
	}
	r := row{Level: 1, Pets: Pets{}, Roles: Roles{}}
	var pets, roles, extra []byte
	var hours float64
	err := s.pool.QueryRow(ctx, `SELECT level,endless,prestige,pets,roles,state,
GREATEST(LEAST(EXTRACT(EPOCH FROM (clock_timestamp()-GREATEST(settled_at,enabled_at)))/3600.0,$2::float8),0)
FROM fishing.house_state WHERE owner_id=$1`, owner, h.CapacityHours).
		Scan(&r.Level, &r.Endless, &r.Prestige, &pets, &roles, &extra, &hours)
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
	if hours < 0 {
		hours = 0
	}

	view := View{
		OwnerID:   owner,
		Level:     r.Level,
		Endless:   r.Endless,
		Prestige:  r.Prestige,
		Rate:      h.Rate(r.Level, r.Endless),
		Capacity:  h.CapacityHours,
		Hours:     hours,
		Pets:      r.Pets,
		Roles:     r.Roles,
		Stationed: append([]string{}, r.Stationed...),
		Slots:     slotsFor(h, r.Level),
		Steal:     StealView{CoinCap: h.StealDailyCoinCap, Heat: r.Heat},
	}
	view.Pending = h.Payout(view.Rate, hours, s.bonus(h, r))
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

// readStealBudget fills today's picks and coin usage from the append-only
// ledger, keyed by the UTC day bucket the server wrote.
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

// dayBucketSQL is the server-clock UTC day, as an epoch-day integer. Both the
// steal guard and the ledger writer use this exact expression, so the "one pick
// per pair per day" rule cannot drift between read and write.
const dayBucketSQL = `extract(epoch FROM date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC'))/86400`

// ── write side ──────────────────────────────────────────────────────────────

// Collect empties the pond and pays rate × min(elapsed, capacity). There is no
// daily collection counter and no payout cap: time is the only limit.
func (s *Service) Collect(ctx context.Context, owner int64, key string) (assets.Result, error) {
	return s.run(ctx, owner, key, "house_collect", []int64{owner}, input{Op: "collect"}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		return s.settle(ctx, t, owner, "collected")
	})
}

func (s *Service) settle(ctx context.Context, t *assets.Transaction, owner int64, status string) (assets.Result, error) {
	h := s.hut()
	r, hours, err := consume(ctx, t, owner, h.CapacityHours)
	if err != nil {
		return assets.Result{}, err
	}
	if r.Frozen {
		return assets.Result{Status: "frozen"}, nil
	}
	payout := int64(0)
	if hours > 0 {
		payout = h.Payout(h.Rate(r.Level, r.Endless), hours, s.bonus(h, r))
	}
	if guard := guardCoins(h); payout > guard {
		payout = guard
	}
	if payout > 0 {
		if err = t.Coins(ctx, owner, payout); err != nil {
			return assets.Result{}, err
		}
	}
	var balance int64
	if err = t.SQL().QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&balance); err != nil {
		return assets.Result{}, err
	}
	return assets.Result{Status: status, RecipientBalance: balance, ResourceID: strconv.FormatInt(payout, 10)}, nil
}

// Upgrade walks the main track Lv1 → Lv10. Materials and coins come from the
// published HUT section; the module never invents a price.
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

// Renovate is the endless layer: it stays available at the level cap and each
// renovation buys an asymptotically smaller rate bump plus one prestige point.
// It shares the house_upgrade feature gate.
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

// Pet feeds affinity and manages the station list. Feeding costs one common
// bait material, exactly like the design's "普通鱼饵材料" rule.
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

// Role invests points into one of the three tracks. Only "cook" feeds the coin
// rate; "brine" and "trader" drive the brine exchange and the social budget.
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

// Steal takes coins and one common material from a friend's overflow pond. The
// victim's own pond is never debited; they gain heat instead.
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

// AdminReset discards the accrual window without paying for it. The operator
// can only ever move the clock forward, never mint coins.
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

// AdminFreeze stops or resumes accrual. Resuming pushes the window forward, so
// a paused house never pays for the hours it was paused.
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

// ── offline settlement worker ───────────────────────────────────────────────

// Sweep settles the ponds of connected players so an active session never
// overflows the 8h pond. It deliberately skips absent players: their pond must
// hold at most one capacity window until they come back (design §1.1 / §10.1 #7).
// This mirrors the autosell worker, which also only serves live connections.
func (s *Service) Sweep(ctx context.Context, after int64) (int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT h.owner_id
FROM fishing.house_state h
JOIN fishing.fishing_connections c ON c.owner_id=h.owner_id AND c.expires_at>clock_timestamp()
JOIN fishing.identities i ON i.account_id=h.owner_id AND NOT i.banned
WHERE h.owner_id>$1 AND NOT COALESCE((h.state->>'frozen')::boolean,false)
  AND h.enabled_at<=clock_timestamp() AND h.settled_at<=clock_timestamp()-interval '1 hour'
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
		key := "house:settle:" + strconv.FormatInt(id, 10) + ":" + strconv.FormatInt(s.settleBucket(ctx), 10)
		_, err = s.run(ctx, id, key, "house_settle", []int64{id}, input{Op: "worker_settle"}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
			return s.settle(ctx, t, id, "settled")
		})
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

func (s *Service) settleBucket(ctx context.Context) int64 {
	var bucket int64
	_ = s.pool.QueryRow(ctx, `SELECT floor(extract(epoch FROM clock_timestamp())/3600)::bigint`).Scan(&bucket)
	return bucket
}

// Run keeps the connected players' ponds settled. Every failed sweep is retried
// on the next tick; the lazy collect path remains the safety net.
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
			logger.Warn("house_settle_retry")
			warned = time.Now()
		}
	}
}
