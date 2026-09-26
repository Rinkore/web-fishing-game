// Package gear owns material-only growth and independent fishing/voyage progress.
package gear

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type State struct {
	Tiers                map[string]int  `json:"tiers"`
	Unlocked             map[string]bool `json:"unlocked"`
	Receipts             int64           `json:"receipts"`
	ReceiptRemainder     int             `json:"receiptRemainder"`
	Heat                 int             `json:"heat"`
	HeatMS               float64         `json:"heatMs"`
	Harvest              int             `json:"harvest"`
	Recent               []rules.Catch   `json:"recent"`
	HarvestMode          string          `json:"harvestMode"`
	Target               string          `json:"target"`
	Tracking             int             `json:"tracking"`
	TargetQueue          []string        `json:"targetQueue"`
	TargetGoal           int             `json:"targetGoal"`
	TargetCaught         int             `json:"targetCaught"`
	Allocations          map[string]int  `json:"allocations"`
	ArchaeologyRemainder int             `json:"archaeologyRemainder"`
	Selected             string          `json:"selected"`
	Focus                string          `json:"focus"`
	VoyageMode           string          `json:"voyageMode"`
	ArchaeologyHours     int             `json:"archaeologyHours"`
	StormFailures        int             `json:"stormFailures"`
	LastCast             string          `json:"lastCast"`
	CastHit              bool            `json:"castHit"`
	CastProgressed       bool            `json:"castProgressed"`
}

func Read(ctx context.Context, q assets.SQL, owner int64) (State, error) {
	v := State{Tiers: map[string]int{}, Unlocked: map[string]bool{}}
	var raw []byte
	err := q.QueryRow(ctx, `SELECT state FROM fishing.gear_progress WHERE owner_id=$1`, owner).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	if v.Tiers == nil {
		v.Tiers = map[string]int{}
	}
	if v.Unlocked == nil {
		v.Unlocked = map[string]bool{}
	}
	if v.Allocations == nil {
		v.Allocations = LegacyAllocation(v.Selected)
	}
	return v, err
}
func Write(ctx context.Context, t *assets.Transaction, owner int64, v State) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.gear_progress(owner_id,state) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET state=excluded.state`, owner, raw)
	return err
}
func Active(ctx context.Context, q assets.SQL, c *rules.Catalog, owner int64) (string, error) {
	rows, err := q.Query(ctx, `SELECT r.part,e.attributes->>'signature' FROM fishing.rod_components r JOIN fishing.rod_loadouts l ON l.owner_id=r.owner_id AND l.slot=r.slot AND l.active JOIN fishing.equipment_instances e ON e.id=r.equipment_id WHERE r.owner_id=$1`, owner)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	parts := map[string]string{}
	for rows.Next() {
		var part, sig string
		if err = rows.Scan(&part, &sig); err != nil {
			return "", err
		}
		parts[part] = sig
	}
	id := c.ActiveSet(parts)
	if _, ok := c.GearConfig().Sets[id]; !ok {
		id = ""
	}
	return id, rows.Err()
}

type Service struct {
	pool *pgxpool.Pool
	c    *rules.Catalog
	a    *assets.Service
}

func New(p *pgxpool.Pool, c *rules.Catalog) *Service { return &Service{p, c, assets.New(p)} }

type Equipment struct {
	RewardBound bool              `json:"rewardBound"`
	BindOutputs bool              `json:"bindOutputs"`
	ID          string            `json:"id"`
	Signature   string            `json:"signature"`
	Base        string            `json:"base"`
	Name        string            `json:"name"`
	Part        string            `json:"part"`
	Set         string            `json:"set"`
	Locked      bool              `json:"locked"`
	Bound       bool              `json:"bound"`
	Growth      *rules.GearGrowth `json:"growth"`
	Affixes     []rules.Affix     `json:"affixes"`
}

func (s *Service) View(ctx context.Context, owner int64) (map[string]any, error) {
	v, err := Read(ctx, s.pool, owner)
	if err != nil {
		return nil, err
	}
	active, err := Active(ctx, s.pool, s.c, owner)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT e.id,e.attributes->>'signature',COALESCE((e.attributes->>'bound')::boolean,false) OR e.reward_bound,e.reward_bound,e.bind_outputs,EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) FROM fishing.equipment_instances e WHERE e.owner_id=$1 AND e.lifecycle='available' ORDER BY e.id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Equipment{}
	for rows.Next() {
		var id int64
		var e Equipment
		if err = rows.Scan(&id, &e.Signature, &e.Bound, &e.RewardBound, &e.BindOutputs, &e.Locked); err != nil {
			return nil, err
		}
		e.ID = strconv.FormatInt(id, 10)
		b, _, aa, ok := s.c.Instance(e.Signature)
		if !ok {
			continue
		}
		e.Base = b.ID
		e.Part = b.Part
		e.Name = b.Name
		e.Set = b.SetID
		e.Affixes = s.c.GearAffixes(e.Signature, b, aa)
		if g, ok := rules.Growth(e.Signature); ok {
			e.Growth = &g
		}
		items = append(items, e)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"config": s.c.GearConfig(), "state": v, "activeSet": active, "equipment": items}, nil
}

type Command struct {
	Allocations   map[string]int `json:"allocations"`
	UnboundInputs bool           `json:"unboundInputs"`
	Action        string         `json:"action"`
	RequestKey    string         `json:"requestKey"`
	ID            string         `json:"id"`
	IDs           []string       `json:"ids,omitempty"`
	OtherID       string         `json:"otherId"`
	Sub           string         `json:"sub"`
	Direction     string         `json:"direction"`
	UseHeat       bool           `json:"useHeat"`
	Set           string         `json:"set"`
	Focus         string         `json:"focus"`
	Mode          string         `json:"mode"`
	Target        string         `json:"target"`
	Queue         []string       `json:"queue"`
	Goal          int            `json:"goal"`
}

func Pay(ctx context.Context, t *assets.Transaction, owner int64, cost rules.GearCost, v *State) error {
	if v.Receipts < cost.Receipts {
		return assets.Rejection("航程凭证不足")
	}
	if v.Heat < cost.Heat {
		return assets.Rejection("精工热量不足")
	}
	if err := t.Coins(ctx, owner, -cost.Coins); err != nil {
		return err
	}
	ds := []assets.StackDelta{}
	for id, n := range cost.Items {
		ds = append(ds, assets.StackDelta{ItemID: id, Tier: "normal", Quantity: -n})
	}
	if len(ds) > 0 {
		if err := t.Stacks(ctx, owner, ds); err != nil {
			return err
		}
	}
	v.Receipts -= cost.Receipts
	v.Heat -= cost.Heat
	return nil
}

func LegacyAllocation(selected string) map[string]int {
	out := map[string]int{}
	if selected != "" {
		out[selected] = 3
	}
	return out
}

// AllocationSelection retains the legacy display field only for one specialization.
func AllocationSelection(allocation map[string]int) string {
	if len(allocation) == 1 {
		for id := range allocation {
			return id
		}
	}
	return ""
}

func ValidateAllocation(cfg rules.GearConfig, state State, allocation map[string]int, mode string) (map[string]int, error) {
	out := map[string]int{}
	total := 0
	for id, points := range allocation {
		if points < 0 || points > 3 {
			return nil, assets.ErrInvalid
		}
		if _, ok := cfg.Specializations[id]; !ok {
			return nil, assets.ErrInvalid
		}
		if points == 0 {
			continue
		}
		if !state.Unlocked[id] {
			return nil, assets.Rejection("specialization_locked")
		}
		out[id] = points
		total += points
	}
	if total > 3 {
		return nil, assets.Rejection("specialization_points_exceeded")
	}
	selected := map[string]string{"deep": "storm", "evacuate": "rescue", "concentrate": "tide"}[mode]
	if out[selected] == 0 {
		selected = ""
	}
	var effects map[string]float64
	if selected != "" {
		effects = cfg.Specializations[selected].AllocationEffect(state.Tiers[selected], out[selected])
	}
	if err := ValidateVoyageMode(selected, mode, effects); err != nil {
		return nil, err
	}
	return out, nil
}

// ValidateVoyageMode is shared by saved preferences and departure snapshots.
func ValidateVoyageMode(selected, mode string, effects map[string]float64) error {
	switch mode {
	case "", "normal":
		return nil
	case "deep":
		if selected == "storm" && effects["deepRisk"] != 0 {
			return nil
		}
	case "evacuate":
		if selected == "rescue" && effects["evacuate"] != 0 {
			return nil
		}
	case "concentrate":
		if selected == "tide" && effects["concentrate"] != 0 {
			return nil
		}
	default:
		return assets.ErrInvalid
	}
	return assets.Rejection("specialization_mode_locked")
}

func (s *Service) Apply(ctx context.Context, owner int64, in Command) (assets.Result, error) {
	if len(in.RequestKey) < 8 || len(in.RequestKey) > 100 || !s.c.GearConfig().Enabled {
		return assets.Result{}, assets.ErrInvalid
	}
	// A stable operation rule lets network retries return the original result even after an admin publication.
	return s.a.Run(ctx, assets.Command{ActorID: owner, RequestKey: in.RequestKey, Kind: "workshop_forge", RuleVersion: "gear-growth-v1", Players: []int64{owner}, Input: in}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		t.UnboundInputsOnly(in.UnboundInputs)
		feature := "workshop.growth"
		switch in.Action {
		case "preferences", "target", "harvest_mode", "unlock", "stage":
			feature = "workshop.sets"
		}
		if err := t.RequireFeature(ctx, feature); err != nil {
			return assets.Result{}, err
		}
		cfg := s.c.GearConfig()
		v, err := Read(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		cost := rules.GearCost{}
		result := map[string]any{}
		switch in.Action {
		case "preferences":
			allocation := in.Allocations
			if allocation == nil {
				allocation = LegacyAllocation(in.Set)
			}
			allocation, err = ValidateAllocation(cfg, v, allocation, in.Mode)
			if err != nil {
				return assets.Result{}, err
			}
			if in.Focus != "" {
				it, ok := s.c.Item(in.Focus)
				if !ok || it.Kind != "material" {
					return assets.Result{}, assets.ErrInvalid
				}
			}
			v.Allocations = allocation
			v.Selected = AllocationSelection(allocation)
			v.Focus = in.Focus
			v.VoyageMode = in.Mode
		case "target":
			it, ok := s.c.Item(in.Target)
			if !ok || it.Kind != "fish" || s.c.GearExcluded(in.Target) || len(in.Queue) > 20 || in.Goal < 0 || in.Goal > 10000 {
				return assets.Result{}, assets.ErrInvalid
			}
			for _, id := range in.Queue {
				it, ok := s.c.Item(id)
				if !ok || it.Kind != "fish" || s.c.GearExcluded(id) {
					return assets.Result{}, assets.ErrInvalid
				}
			}
			if len(in.Queue) > 0 && cfg.Sets["apex"].Effect(v.Tiers["apex"])["queue"] == 0 {
				return assets.Result{}, assets.Rejection("追踪名单需要猎王三阶")
			}
			if v.Target != in.Target {
				v.Tracking = 0
				v.TargetCaught = 0
			}
			v.Target = in.Target
			v.TargetQueue = in.Queue
			v.TargetGoal = max(1, in.Goal)
		case "harvest_mode":
			if in.Mode != "small" && in.Mode != "large" {
				return assets.Result{}, assets.ErrInvalid
			}
			if in.Mode == "large" && cfg.Sets["harvest"].Effect(v.Tiers["harvest"])["largeMode"] == 0 {
				return assets.Result{}, assets.Rejection("大丰收需要三阶")
			}
			v.HarvestMode = in.Mode
		case "unlock", "stage":
			_, fish := cfg.Sets[in.Set]
			_, spec := cfg.Specializations[in.Set]
			if !fish && !spec {
				return assets.Result{}, assets.ErrInvalid
			}
			if in.Action == "unlock" {
				if !spec || v.Unlocked[in.Set] {
					return assets.Result{}, assets.Rejection("专精已认证或不存在")
				}
				cost = cfg.Costs.Unlock
			} else {
				if v.Tiers[in.Set] >= 3 {
					return assets.Result{}, assets.Rejection("已达三阶")
				}
				if spec && !v.Unlocked[in.Set] {
					return assets.Result{}, assets.Rejection("请先认证专精")
				}
				cost = cfg.Costs.Stage[v.Tiers[in.Set]]
			}
			// Voyage specialization progress is independent of equipment ownership.
			if spec {
				cost.Cores = 0
			}
			if fish {
				var count int
				err = t.SQL().QueryRow(ctx, `SELECT count(DISTINCT part) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available' AND definition_id=ANY($2::text[])`, owner, []string{"set_" + in.Set + "_rod", "set_" + in.Set + "_charm"}).Scan(&count)
				if err != nil {
					return assets.Result{}, err
				}
				if count != 2 {
					return assets.Result{}, assets.Rejection("需要持有同套竿身与饰品核心")
				}
			}
			if cost.Cores > 0 {
				rows, err := t.SQL().Query(ctx, `SELECT e.id FROM fishing.equipment_instances e WHERE e.owner_id=$1 AND lifecycle='available' AND definition_id=ANY($2::text[]) AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) AND (NOT $3::boolean OR NOT e.reward_bound) ORDER BY e.reward_bound DESC,e.bind_outputs DESC,e.id OFFSET 0`, owner, []string{"set_" + in.Set + "_rod", "set_" + in.Set + "_charm"}, in.UnboundInputs)
				if err != nil {
					return assets.Result{}, err
				}
				ids := []int64{}
				for rows.Next() {
					var id int64
					if err = rows.Scan(&id); err != nil {
						rows.Close()
						return assets.Result{}, err
					}
					ids = append(ids, id)
				}
				err = rows.Err()
				rows.Close()
				if err != nil {
					return assets.Result{}, err
				}
				// Retain at least one core of each part, including equipped/locked cores.
				donors := []int64{}
				for _, id := range ids {
					var part string
					var count int
					if err = t.SQL().QueryRow(ctx, `SELECT part FROM fishing.equipment_instances WHERE id=$1`, id).Scan(&part); err != nil {
						return assets.Result{}, err
					}
					if err = t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available' AND definition_id=$2`, owner, "set_"+in.Set+"_"+part).Scan(&count); err != nil {
						return assets.Result{}, err
					}
					if count <= 1 {
						continue
					}
					if err = t.ConsumeEquipment(ctx, owner, id); err != nil {
						return assets.Result{}, err
					}
					donors = append(donors, id)
					if len(donors) == cost.Cores {
						break
					}
				}
				if len(donors) != cost.Cores {
					return assets.Result{}, assets.Rejection("同套重复核心不足（保留每部位一件）")
				}
				result["consumedCores"] = donors
			}
			if in.Action == "unlock" {
				v.Unlocked[in.Set] = true
			} else {
				v.Tiers[in.Set]++
			}
			result["stage"] = v.Tiers[in.Set]
		default:
			id, _ := strconv.ParseInt(in.ID, 10, 64)
			var sig string
			var bound bool
			err = t.SQL().QueryRow(ctx, `SELECT attributes->>'signature',COALESCE((attributes->>'bound')::boolean,false) FROM fishing.equipment_instances e WHERE id=$1 AND owner_id=$2 AND lifecycle='available'`, id, owner).Scan(&sig, &bound)
			if errors.Is(err, pgx.ErrNoRows) {
				return assets.Result{}, assets.Rejection("请选择可用的配件")
			}
			if err != nil {
				return assets.Result{}, err
			}
			// 工坊允许直接修改已装备的组件：先把来源从配装槽位摘下（否则消耗会被
			// equipment_locked 拒绝），成长结果生成后再放回同一个槽位。
			var slots []loadoutSlot
			if slots, err = takeLoadoutSlots(ctx, t, owner, id); err != nil {
				return assets.Result{}, err
			}
			base, _, aa, ok := s.c.Instance(sig)
			p, ordinary := cfg.Parts[base.Part]
			if !ok || !ordinary || base.SetID != "" {
				return assets.Result{}, assets.Rejection("请选择普通配件")
			}
			g, modern := rules.Growth(sig)
			if !modern {
				g = rules.GearGrowth{Engrave: "none"}
			}
			sub := ""
			for _, a := range aa {
				if a.Type != p.Main {
					sub = a.Type
				}
			}
			if in.Action == "tune" || (in.Action == "upgrade" && g.Level+1 == cfg.SubUnlock) {
				sub = in.Sub
			}
			targetBase := base.ID
			switch in.Action {
			case "upgrade":
				if !modern {
					return assets.Result{}, assets.Rejection("请先转为新制配件")
				}
				if g.Level >= cfg.MaxLevel {
					return assets.Result{}, assets.Rejection("已达强化上限")
				}
				cost = cfg.Costs.Upgrade[g.Level]
				g.Level++
			case "tune":
				if !modern || g.Level < cfg.SubUnlock {
					return assets.Result{}, assets.Rejection("尚未解锁副属性")
				}
				cost = cfg.Costs.Tune
			case "engrave":
				if g.Engrave == in.Direction {
					return assets.Result{}, assets.Rejection("该精工方向已生效")
				}
				if !modern || g.Level < cfg.EngraveLevel {
					return assets.Result{}, assets.Rejection("未达精工档位")
				}
				if in.Direction != "main" && in.Direction != "sub" {
					return assets.Result{}, assets.ErrInvalid
				}
				cost = cfg.Costs.Engrave
				if in.UseHeat {
					cost = cfg.Costs.HeatEngrave
					cost.Heat = max(0, cost.Heat-int(cfg.Sets["forge"].Effect(v.Tiers["forge"])["heatDiscount"]))
				}
				g.Engrave = in.Direction
				if in.Direction == "main" {
					g.Presets |= 1
				} else {
					g.Presets |= 2
				}
			case "preset":
				if g.Engrave == in.Direction {
					return assets.Result{}, assets.Rejection("该精工方向已生效")
				}
				if !modern || cfg.Sets["forge"].Effect(v.Tiers["forge"])["presets"] == 0 || g.Presets != 3 || (in.Direction != "main" && in.Direction != "sub") {
					return assets.Result{}, assets.Rejection("需要工匠三阶且已制作两种精工")
				}
				cost = cfg.Costs.Preset
				g.Engrave = in.Direction
			case "transfer":
				if !modern {
					return assets.Result{}, assets.Rejection("请先转为新制")
				}
				other, _ := strconv.ParseInt(in.OtherID, 10, 64)
				if other == id {
					return assets.Result{}, assets.ErrInvalid
				}
				var otherBase, otherSig string
				err = t.SQL().QueryRow(ctx, `SELECT definition_id,attributes->>'signature' FROM fishing.equipment_instances e WHERE id=$1 AND owner_id=$2 AND lifecycle='available' AND part=$3 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id)`, other, owner, base.Part).Scan(&otherBase, &otherSig)
				if err != nil {
					return assets.Result{}, assets.Rejection("目标必须为未占用同部位基础配件")
				}
				og, ok := rules.Growth(otherSig)
				if !ok || og.Level != 0 || og.Engrave != "none" {
					return assets.Result{}, assets.Rejection("转移目标必须为 +0 未精工配件")
				}
				targetBase = otherBase
				cost = cfg.Costs.Transfer
				if err = t.ConsumeEquipment(ctx, owner, other); err != nil {
					return assets.Result{}, err
				}
			default:
				return assets.Result{}, assets.ErrInvalid
			}
			newsig, err := s.c.GearSignature(targetBase, g.Level, sub, g.Engrave, g.Presets)
			if err != nil {
				return assets.Result{}, assets.Rejection("请选择合法副属性")
			}
			if err = Pay(ctx, t, owner, cost, &v); err != nil {
				return assets.Result{}, err
			}
			cost = rules.GearCost{}
			if err = t.ConsumeEquipment(ctx, owner, id); err != nil {
				return assets.Result{}, err
			}
			bound = bound || g.Level >= cfg.BoundLevel || g.Engrave != "none"
			attrs, _ := json.Marshal(map[string]any{"signature": newsig, "bound": bound})
			newid, err := t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: targetBase, Part: base.Part, Attributes: attrs})
			if err != nil {
				return assets.Result{}, err
			}
			if err = restoreLoadoutSlots(ctx, t, owner, newid, slots); err != nil {
				return assets.Result{}, err
			}
			result["id"] = strconv.FormatInt(newid, 10)
			result["signature"] = newsig
		}
		if err = Pay(ctx, t, owner, cost, &v); err != nil {
			return assets.Result{}, err
		}
		if err = Write(ctx, t, owner, v); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.player_state SET loadout_rev=loadout_rev+1 WHERE account_id=$1`, owner); err != nil {
			return assets.Result{}, err
		}
		result["state"] = v
		raw, _ := json.Marshal(result)
		return assets.Result{Status: "crafted", Details: raw}, nil
	})
}

// loadoutSlot is one rod_components row: which saved loadout slot holds which part.
type loadoutSlot struct {
	slot int
	part string
}

// takeLoadoutSlots detaches an equipped instance from its saved loadouts so the growth
// command may consume it (moveEquipment rejects equipped equipment with
// equipment_locked). The caller restores the rows onto the result instance, so the
// workshop can modify an equipped component without the player unequipping it first.
func takeLoadoutSlots(ctx context.Context, t *assets.Transaction, owner, id int64) ([]loadoutSlot, error) {
	rows, err := t.SQL().Query(ctx, `SELECT slot,part FROM fishing.rod_components WHERE owner_id=$1 AND equipment_id=$2 ORDER BY slot`, owner, id)
	if err != nil {
		return nil, err
	}
	var slots []loadoutSlot
	for rows.Next() {
		var s loadoutSlot
		if err = rows.Scan(&s.slot, &s.part); err != nil {
			rows.Close()
			return nil, err
		}
		slots = append(slots, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(slots) == 0 {
		return nil, err
	}
	if _, err = t.SQL().Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1 AND equipment_id=$2`, owner, id); err != nil {
		return nil, err
	}
	return slots, nil
}

// restoreLoadoutSlots puts the growth result back into the slots the source occupied.
func restoreLoadoutSlots(ctx context.Context, t *assets.Transaction, owner, id int64, slots []loadoutSlot) error {
	for _, s := range slots {
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, owner, s.slot, s.part, id); err != nil {
			return err
		}
	}
	return nil
}

func IsModern(sig string) bool { return strings.Contains(sig, "@g") }
