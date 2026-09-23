package workshop

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/randomintent"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool    *pgxpool.Pool
	assets  *assets.Service
	catalog *rules.Catalog
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service { return &Service{pool, assets.New(pool), c} }

type Command struct {
	ActorID                         int64
	RequestKey, Action              string
	MainID, SubID                   int64
	MainAffix, SubAffix, MaterialID string
	Materials                       []rules.Material
	Pearl                           bool
	Relics                          int64
	Target                          int
}

func (s *Service) ruleVersion() string { return s.catalog.Version + ":" + s.catalog.SourceSHA256 }
func (s *Service) intent(ctx context.Context, actor int64, key string, input any) ([]byte, error) {
	return randomintent.Load(ctx, s.pool, actor, key, input)
}
func signature(ctx context.Context, t *assets.Transaction, owner, id int64) (string, error) {
	var attributes []byte
	err := t.SQL().QueryRow(ctx, `SELECT attributes FROM fishing.equipment_instances e WHERE id=$1 AND owner_id=$2 AND lifecycle='available' AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id)`, id, owner).Scan(&attributes)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", assets.Rejection("equipment_unavailable")
	}
	if err != nil {
		return "", err
	}
	var value struct {
		Signature string `json:"signature"`
	}
	if json.Unmarshal(attributes, &value) != nil || value.Signature == "" {
		return "", assets.Rejection("equipment_rules_missing")
	}
	return value.Signature, nil
}
func (s *Service) create(ctx context.Context, t *assets.Transaction, owner int64, signature string) (int64, error) {
	base, _, _, ok := s.catalog.Instance(signature)
	if !ok {
		return 0, assets.ErrInvalid
	}
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	return t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: base.ID, Part: base.Part, Attributes: attrs})
}
func (s *Service) Apply(ctx context.Context, r Command) (assets.Result, error) {
 if s.catalog.GearConfig().Enabled { return assets.Result{},assets.Rejection("legacy_workshop_retired") }
	if r.MainID < 1 || r.Relics < 0 || len(r.Materials) > 12 {
		return assets.Result{}, assets.ErrInvalid
	}
	switch r.Action {
	case "smelt":
		if r.SubID < 1 || r.SubID == r.MainID {
			return assets.Result{}, assets.ErrInvalid
		}
	case "recast", "forge":
		if r.SubID != 0 || len(r.Materials) != 0 || r.Relics != 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	default:
		return assets.Result{}, assets.ErrInvalid
	}
	version := s.ruleVersion()
	input := struct {
		Command Command
		Version string
	}{r, version}
	seed, err := s.intent(ctx, r.ActorID, r.RequestKey, input)
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "workshop_" + r.Action, RuleVersion: version, Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		main, err := signature(ctx, t, r.ActorID, r.MainID)
		if err != nil {
			return assets.Result{}, err
		}
		baseMain, _, _, _ := s.catalog.Instance(main)
		if baseMain.SetID != "" {
			return assets.Result{}, assets.Rejection("set_immutable")
		}
		cfg, w := s.catalog.ComponentConfig(), s.catalog.WorkshopConfig()
		rng := rules.Stream(seed, "workshop:"+r.Action)
		var newSignature string
		cost := int64(0)
		consumed := map[string]int64{}
		details := any(nil)
		switch r.Action {
		case "smelt":
			sub, err := signature(ctx, t, r.ActorID, r.SubID)
			if err != nil {
				return assets.Result{}, err
			}
			plan, err := s.catalog.SmeltPlan(rules.SmeltInput{MainID: main, SubID: sub, MainAffix: r.MainAffix, SubAffix: r.SubAffix, Materials: r.Materials, Pearl: r.Pearl, Relics: r.Relics}, cfg, w)
			if err != nil {
				return assets.Result{}, assets.Rejection("invalid_smelt_plan")
			}
			out := plan.Roll(rng)
			if out.Success {
				newSignature = *out.ResultID
			} else {
				newSignature = *out.MainAfterID
			}
			details = out
			cost = int64(plan.Gold)
			for _, m := range plan.Consume {
				consumed[m.ID] += m.Quantity
			}
			if err := t.ConsumeEquipment(ctx, r.ActorID, r.SubID); err != nil {
				return assets.Result{}, err
			}
		case "recast":
			id, pearls, gold, err := s.catalog.Recast(main, r.Target, cfg, w, rng)
			if err != nil {
				return assets.Result{}, assets.Rejection("invalid_recast_plan")
			}
			newSignature = id
			cost = int64(gold)
			consumed["dragonpearl"] = int64(pearls)
			details = map[string]any{"signature": id, "pearls": pearls, "gold": gold, "target": r.Target}
		case "forge":
			base, q, aa, ok := s.catalog.Instance(main)
			kind := rules.MaterialAffix(r.MaterialID)
			if !ok || kind == "" || (!base.Legacy && !s.catalog.AffixAllowed(base.Part, kind)) {
				return assets.Result{}, assets.Rejection("invalid_forge_plan")
			}
			cap := map[string]int{"common": 1, "rare": 2, "epic": 3, "mythic": 4}[q]
			if len(aa) >= cap {
				return assets.Result{}, assets.Rejection("affix_capacity")
			}
			inPool := false
			for _, a := range base.Pool {
				if a.Type == kind {
					inPool = true
				}
			}
			if !w.ForgeAnyAffix && !inPool {
				return assets.Result{}, assets.Rejection("invalid_forge_affix")
			}
			for _, a := range aa {
				if a.Type == kind {
					return assets.Result{}, assets.Rejection("duplicate_affix")
				}
			}
			aa = s.catalog.ResolveAffixSources(base, aa, cfg)
			span := s.catalog.CatalystRange(cfg, w, base.Part, kind, r.Pearl)
			src := "ct"
			if r.Pearl {
				src = "ct_full"
				consumed["dragonpearl"] = 1
			}
			value := rules.RollAffix(span[0], span[1], cfg.RollModel, rng)
			var heat int
			if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT heat FROM fishing.sea_captains WHERE owner_id=$1),0)`, r.ActorID).Scan(&heat); err != nil {
				return assets.Result{}, err
			}
			if heat > 0 {
				value = span[1]
				if _, err := t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET heat=heat-1 WHERE owner_id=$1`, r.ActorID); err != nil {
					return assets.Result{}, err
				}
			}
			aa = append(aa, rules.Affix{Type: kind, Value: value, Source: src, Explicit: true})
			newSignature = rules.InstanceID(base, q, aa)
			consumed[r.MaterialID]++
			details = map[string]any{"signature": newSignature, "type": kind, "value": value, "src": src}
		}
		if err := t.Coins(ctx, r.ActorID, -cost); err != nil {
			return assets.Result{}, err
		}
		deltas := []assets.StackDelta{}
		for id, n := range consumed {
			if n > 0 {
				deltas = append(deltas, assets.StackDelta{ItemID: id, Tier: "normal", Quantity: -n})
			}
		}
		if len(deltas) > 0 {
			if err := t.Stacks(ctx, r.ActorID, deltas); err != nil {
				return assets.Result{}, err
			}
		}
		if err := t.ConsumeEquipment(ctx, r.ActorID, r.MainID); err != nil {
			return assets.Result{}, err
		}
		id, err := s.create(ctx, t, r.ActorID, newSignature)
		if err != nil {
			return assets.Result{}, err
		}
		body, _ := json.Marshal(details)
		return assets.Result{Status: "crafted", EquipmentIDs: []string{strconv.FormatInt(id, 10)}, Details: body}, nil
	})
}
