package sea

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/gear"
	"fishing.local/server/internal/modules/randomintent"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

type Captain struct {
	Target    string          `json:"target"`
	Marks     int64           `json:"marks"`
	Voyages   int             `json:"voyages"`
	Successes int             `json:"successes"`
	Starter   int             `json:"starter"`
	Clears    map[string]bool `json:"clears"`
	Heat      int             `json:"heat"`
	Clues     int             `json:"clues"`
	Samples   int             `json:"samples"`
	Tracking  int             `json:"tracking"`
}
type ExpeditionSnapshot struct {
	Growth         bool               `json:"growth"`
	Stage          int                `json:"stage"`
	Focus          string             `json:"focus"`
	Mode           string             `json:"mode"`
	ReceiptHours   int                `json:"receiptHours"`
	SpecialEffects map[string]float64 `json:"specialEffects,omitempty"`
	Level          int                `json:"level"`
	Set            string             `json:"set"`
	Effects        rules.Effects      `json:"effects"`
	Success        float64            `json:"success"`
}
type ExpeditionReward struct {
	ArchaeologyHours int              `json:"archaeologyHours"`
	Receipts         int64            `json:"receipts"`
	Success          bool             `json:"success"`
	Event            string           `json:"event"`
	Coins            int64            `json:"coins"`
	XP               int64            `json:"xp"`
	Marks            int64            `json:"marks"`
	Items            map[string]int64 `json:"items"`
	Heat             int              `json:"heat"`
	Clues            int              `json:"clues"`
	SamplesUsed      int              `json:"samplesUsed"`
}
type Expedition struct {
	ID        string             `json:"id"`
	Route     string             `json:"route"`
	Hours     int                `json:"hours"`
	StartedAt int64              `json:"startedAt"`
	EndsAt    int64              `json:"endsAt"`
	Ready     bool               `json:"ready"`
	Claimed   bool               `json:"claimed"`
	Snapshot  ExpeditionSnapshot `json:"snapshot"`
	Reward    *ExpeditionReward  `json:"reward,omitempty"`
}
type ExpeditionView struct {
	FreeTrades int                    `json:"freeTrades"`
	Now        int64                  `json:"now"`
	Captain    Captain                `json:"captain"`
	Config     rules.ExpeditionConfig `json:"config"`
	Sets       []rules.GearSet        `json:"sets"`
	Active     *Expedition            `json:"active"`
	Last       *Expedition            `json:"last"`
	Gear       ExpeditionSnapshot     `json:"gear"`
}

func captain(ctx context.Context, q assets.SQL, owner int64) (Captain, error) {
	v := Captain{Clears: map[string]bool{}}
	var raw []byte
	err := q.QueryRow(ctx, `SELECT marks,voyages,successes,starter,first_clears,heat,clues,samples,tracking,target FROM fishing.sea_captains WHERE owner_id=$1`, owner).Scan(&v.Marks, &v.Voyages, &v.Successes, &v.Starter, &raw, &v.Heat, &v.Clues, &v.Samples, &v.Tracking, &v.Target)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v.Clears)
	return v, err
}
func ensureCaptain(ctx context.Context, t *assets.Transaction, owner int64) error {
	_, err := t.SQL().Exec(ctx, `INSERT INTO fishing.sea_captains(owner_id) VALUES($1) ON CONFLICT DO NOTHING`, owner)
	return err
}
func (s *Service) expeditionGear(ctx context.Context, q assets.SQL, owner int64) (ExpeditionSnapshot, error) {
	out := ExpeditionSnapshot{Effects: rules.EmptyEffects()}
	v, err := readState(ctx, q, owner)
	if err != nil {
		return out, err
	}
	out.Level = v.Level
	if s.catalog.GearConfig().Enabled {
		return out, nil
	}
	rows, err := q.Query(ctx, `SELECT r.part,e.attributes FROM fishing.rod_components r JOIN fishing.rod_loadouts l ON l.owner_id=r.owner_id AND l.slot=r.slot AND l.active JOIN fishing.equipment_instances e ON e.id=r.equipment_id WHERE r.owner_id=$1 ORDER BY r.part`, owner)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	parts := map[string]string{}
	bd := map[string]struct {
		CompID string `json:"compId"`
	}{}
	for rows.Next() {
		var part string
		var raw []byte
		var a struct {
			Signature string `json:"signature"`
		}
		if err = rows.Scan(&part, &raw); err != nil {
			return out, err
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return out, err
		}
		parts[part] = a.Signature
		bd[part] = struct {
			CompID string `json:"compId"`
		}{a.Signature}
	}
	out.Effects = s.catalog.RodEffects(bd)
	out.Set = s.catalog.ActiveSet(parts)
	return out, rows.Err()
}
func (s *Service) ExpeditionView(ctx context.Context, owner int64) (ExpeditionView, error) {
	v := ExpeditionView{Config: s.catalog.ExpeditionConfig(), Sets: s.catalog.GearSets()}
	var now time.Time
	if err := s.pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return v, err
	}
	v.Now = now.UnixMilli()
	var trades int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM fishing.sea_expeditions WHERE owner_id=$1 AND route='trade'`, owner).Scan(&trades); err != nil {
		return v, err
	}
	v.FreeTrades = max(0, 3-trades)
	var err error
	v.Captain, err = captain(ctx, s.pool, owner)
	if err != nil {
		return v, err
	}
	v.Gear, err = s.expeditionGear(ctx, s.pool, owner)
	if err != nil {
		return v, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,route,hours,started_at,ends_at,snapshot,reward,claimed_at IS NOT NULL FROM fishing.sea_expeditions WHERE owner_id=$1 ORDER BY id DESC LIMIT 2`, owner)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var e Expedition
		var id int64
		var start, end time.Time
		var snap, reward []byte
		if err = rows.Scan(&id, &e.Route, &e.Hours, &start, &end, &snap, &reward, &e.Claimed); err != nil {
			return v, err
		}
		e.ID = strconv.FormatInt(id, 10)
		e.StartedAt = start.UnixMilli()
		e.EndsAt = end.UnixMilli()
		e.Ready = !now.Before(end)
		if err = json.Unmarshal(snap, &e.Snapshot); err != nil {
			return v, err
		}
		// The persisted result never leaks before return; rerolls and client clock changes cannot affect it.
		if e.Ready || e.Claimed {
			if err = json.Unmarshal(reward, &e.Reward); err != nil {
				return v, err
			}
		}
		if !e.Claimed {
			v.Active = &e
		} else if v.Last == nil {
			v.Last = &e
		}
	}
	return v, rows.Err()
}
func expeditionReward(cfg rules.ExpeditionConfig, route rules.ExpeditionRoute, hours int, snap ExpeditionSnapshot, rng rules.RNG) ExpeditionReward {
	r := ExpeditionReward{Success: rng()*100 < snap.Success, Event: "平安返航", Items: map[string]int64{}, XP: int64(hours * 2)}
	multiplier := 1 + math.Min(30, math.Max(0, snap.Effects["material"]))/100
	if hours >= 8 {
		multiplier += math.Min(20, math.Max(0, snap.Effects["settle"])) / 100
	}
	if snap.Set == "storm" {
		multiplier += float64(route.Level-1) * 0.08
	}
	loss := 1.0
	if !r.Success {
		loss = 0.5
		r.Event = "遭遇风浪，保留一半收获"
		if snap.Set == "rescue" {
			loss = 0.9
			r.Event = "救援协议启动，撤离保留九成收获"
		}
	}
	r.Coins = int64(float64(route.Coins*int64(hours)) * loss)
	r.XP = max(1, int64(float64(r.XP)*loss))
	if r.Success {
		r.Marks = map[int]int64{2: 1, 8: 5, 12: 8}[hours]
	}
	for _, c := range cfg.Catalysts {
		if c.Route == route.ID && hours >= c.MinHours {
			r.Items[c.ID] = max(1, int64(float64(hours/2)*multiplier*loss))
		}
	}
	switch route.ID {
	case "trade":
		r.Items["bait_pack"] = int64(hours * 2)
	case "gather":
		r.Items["deepscale"] = max(1, int64(float64(1+hours/4)*loss))
	case "salvage":
		r.Items["relic"] = max(1, int64(float64(hours)*multiplier*loss))
		r.Items["chartfrag"] = max(1, int64(float64(hours/2)*loss))
	case "danger", "king":
		r.Items["deepscale"] = max(1, int64(float64(hours/4+1)*loss))
		r.Items["dragonpearl"] = max(1, int64(float64(hours/4+1)*loss))
	}
	resonance := 1 + math.Min(30, math.Max(0, snap.Effects["resonance"]))/100
	switch snap.Set {
	case "tide":
		r.Items["relic"] += max(1, int64(float64(hours/2)*resonance*loss))
	case "forge":
		r.Heat = max(1, int(float64(hours/2)*resonance*loss))
	case "wreck":
		if route.Level >= 3 {
			r.Clues = max(1, int(float64(hours/2)*resonance*loss))
		}
	}
	return r
}
func (s *Service) StartExpedition(ctx context.Context, owner int64, key, routeID string, hours int, choices ...string) (assets.Result, error) {
	cfg := s.catalog.ExpeditionConfig()
	var route rules.ExpeditionRoute
	for _, v := range cfg.Routes {
		if v.ID == routeID {
			route = v
		}
	}
	allowedHours := false
	for _, h := range cfg.Hours {
		if h == hours {
			allowedHours = true
		}
	}
	if route.ID == "" || !allowedHours || (hours != 2 && hours != 8 && hours != 12) {
		return assets.Result{}, assets.ErrInvalid
	}
	input := struct {
		Route   string
		Hours   int
		Choices []string
	}{routeID, hours, choices}
	version := "expedition-v1"
	seed, err := randomintent.Load(ctx, s.pool, owner, key, input)
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "expedition_start", RuleVersion: version, Players: []int64{owner}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if err := t.RequireFeature(ctx, "sea.expedition"); err != nil {
			return assets.Result{}, err
		}
		var active bool
		if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.sea_expeditions WHERE owner_id=$1 AND claimed_at IS NULL)`, owner).Scan(&active); err != nil {
			return assets.Result{}, err
		}
		if active {
			return assets.Result{}, assets.Rejection("expedition_active")
		}
		snap, err := s.expeditionGear(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if snap.Level < route.Level {
			return assets.Result{}, assets.Rejection("ship_level_insufficient")
		}
		if err = ensureCaptain(ctx, t, owner); err != nil {
			return assets.Result{}, err
		}
		// Three starter coastal trips keep a new account out of a ticket deadlock.
		free := false
		if route.ID == "trade" {
			var trades int
			if err = t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.sea_expeditions WHERE owner_id=$1 AND route='trade'`, owner).Scan(&trades); err != nil {
				return assets.Result{}, err
			}
			free = trades < 3
		}
		if !free && cfg.Ticket > 0 {
			if err = t.Stacks(ctx, owner, []assets.StackDelta{{ItemID: "deepscale", Tier: "normal", Quantity: -cfg.Ticket}}); err != nil {
				return assets.Result{}, err
			}
		}
		snap.Success = math.Min(100, route.Success+25*math.Max(0, snap.Effects["stability"])/(50+math.Max(0, snap.Effects["stability"])))
		if snap.Set == "storm" {
			snap.Success = math.Min(100, snap.Success+10)
		}
		reward := expeditionReward(cfg, route, hours, snap, rules.Stream(seed, "expedition"))
		if s.catalog.GearConfig().Enabled {
			progress, e := gear.Read(ctx, t.SQL(), owner)
			if e != nil {
				return assets.Result{}, e
			}
			selected, focus, mode := progress.Selected, progress.Focus, progress.VoyageMode
			if len(choices) == 3 {
				selected, focus, mode = choices[0], choices[1], choices[2]
			}
			gc := s.catalog.GearConfig()
			ability, exists := gc.Specializations[selected]
			if selected != "" && (!exists || !progress.Unlocked[selected]) {
				return assets.Result{}, assets.Rejection("specialization_locked")
			}
			if mode != "" && mode != "normal" && mode != "deep" && mode != "evacuate" && mode != "concentrate" {
				return assets.Result{}, assets.ErrInvalid
			}
			fx := ability.Effect(progress.Tiers[selected])
			if (mode == "deep" && (selected != "storm" || fx["deepRisk"] == 0)) || (mode == "evacuate" && (selected != "rescue" || fx["evacuate"] == 0)) || (mode == "concentrate" && (selected != "tide" || fx["concentrate"] == 0)) {
				return assets.Result{}, assets.Rejection("specialization_mode_locked")
			}
			if focus != "" {
				it, ok := s.catalog.Item(focus)
				if !ok || it.Kind != "material" {
					return assets.Result{}, assets.ErrInvalid
				}
			}
			snap.Growth = true
			snap.Set = selected
			snap.Stage = progress.Tiers[selected]
			snap.Focus = focus
			snap.Mode = mode
			snap.Effects = rules.EmptyEffects()
			snap.Success = route.Success
			snap.ReceiptHours = gc.ReceiptHours
			snap.SpecialEffects = fx
			if selected == "storm" && mode == "deep" && route.Level >= int(fx["minRouteLevel"]) {
				snap.Success = math.Max(0, snap.Success-fx["deepRisk"])
			}
			reward = growthExpeditionReward(s.catalog, route, hours, snap, progress, rules.Stream(seed, "growth-expedition"))
			progress.Selected = selected
			progress.Focus = focus
			progress.VoyageMode = mode
			if e = gear.Write(ctx, t, owner, progress); e != nil {
				return assets.Result{}, e
			}
		}
		raw, _ := json.Marshal(reward)
		snapshot, _ := json.Marshal(snap)
		var now time.Time
		if err = t.SQL().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.sea_expeditions(id,owner_id,route,hours,started_at,ends_at,snapshot,reward) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, t.OperationID(), owner, routeID, hours, now, now.Add(time.Duration(hours)*time.Hour), snapshot, raw); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET voyages=voyages+1 WHERE owner_id=$1`, owner); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "dispatched", ResourceID: strconv.FormatInt(t.OperationID(), 10)}, nil
	})
}
func (s *Service) ClaimExpedition(ctx context.Context, owner int64, key string, id int64) (assets.Result, error) {
	return s.claimExpedition(ctx, owner, owner, key, id, false, "")
}

// FinishExpedition settles the original persisted reward under the same player
// lock as a normal claim. It never rerolls, changes duration, or splits the grant.
func (s *Service) FinishExpedition(ctx context.Context, actor, owner int64, key string, id int64, actorName string) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, actor); err != nil {
		return assets.Result{}, err
	}
	return s.claimExpedition(ctx, actor, owner, key, id, true, actorName)
}
func (s *Service) claimExpedition(ctx context.Context, actor, owner int64, key string, id int64, force bool, actorName string) (assets.Result, error) {
	if id <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	players := []int64{owner}
	if actor != owner {
		players = append(players, actor)
	}
	var input any = struct{ ID int64 }{id}
	if force {
		input = struct {
			ID, Owner int64
			Force     bool
		}{id, owner, true}
	}
	return s.assets.Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "expedition_claim", RuleVersion: "expedition-v1", Players: players, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var route string
		var hours int
		var raw, snapshot []byte
		var ready, claimed bool
		err := t.SQL().QueryRow(ctx, `SELECT route,hours,reward,snapshot,ends_at<=clock_timestamp(),claimed_at IS NOT NULL FROM fishing.sea_expeditions WHERE id=$1 AND owner_id=$2`, id, owner).Scan(&route, &hours, &raw, &snapshot, &ready, &claimed)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("expedition_missing")
		}
		if err != nil {
			return assets.Result{}, err
		}
		if claimed {
			return assets.Result{}, assets.Rejection("expedition_claimed")
		}
		if !ready && !force {
			return assets.Result{}, assets.Rejection("expedition_not_ready")
		}
		var reward ExpeditionReward
		var snap ExpeditionSnapshot
		if err = json.Unmarshal(raw, &reward); err != nil {
			return assets.Result{}, err
		}
		if err = json.Unmarshal(snapshot, &snap); err != nil {
			return assets.Result{}, err
		}
		if snap.Growth {
			v, e := gear.Read(ctx, t.SQL(), owner)
			if e != nil {
				return assets.Result{}, e
			}
			v.ReceiptRemainder += hours
			unit := max(1, snap.ReceiptHours)
			reward.Receipts = int64(v.ReceiptRemainder / unit)
			v.Receipts += reward.Receipts
			v.ReceiptRemainder %= unit
			if snap.Set == "wreck" {
				v.ArchaeologyHours = reward.ArchaeologyHours
			}
			if e = gear.Write(ctx, t, owner, v); e != nil {
				return assets.Result{}, e
			}
		}
		cap, err := captain(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if reward.Success {
			clearKey := route + ":" + strconv.Itoa(hours)
			if cap.Successes == 0 {
				cap.Starter = 1
			} else if !cap.Clears[clearKey] {
				if hours == 8 {
					reward.Marks += 10
				}
				if hours == 12 {
					reward.Marks += 15
				}
			}
			cap.Clears[clearKey] = true
			cap.Successes++
		}
		if snap.Set == "research" && cap.Samples > 0 {
			reward.SamplesUsed = cap.Samples
			reward.Items["chartfrag"] += int64(cap.Samples)
			reward.XP += int64(cap.Samples * 2)
			cap.Samples = 0
		}
		// Archaeology converts real accumulated clues, never a gear switch.
		if reward.Clues > 0 {
			clues := cap.Clues + reward.Clues
			reward.Items["chest_deep"] += int64(clues / 6)
			cap.Clues = clues % 6
			if reward.Items["chest_deep"] == 0 {
				delete(reward.Items, "chest_deep")
			}
		}
		if cap.Marks > assets.MaxCoins-reward.Marks {
			return assets.Result{}, assets.Rejection("mark_overflow")
		}
		if err = t.Coins(ctx, owner, reward.Coins); err != nil {
			return assets.Result{}, err
		}
		deltas := []assets.StackDelta{}
		for item, n := range reward.Items {
			deltas = append(deltas, assets.StackDelta{ItemID: item, Tier: "normal", Quantity: n})
		}
		if err = t.Stacks(ctx, owner, deltas); err != nil {
			return assets.Result{}, err
		}
		v, err := state(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if v.Experience > assets.MaxCoins-reward.XP {
			return assets.Result{}, assets.Rejection("experience_overflow")
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_players SET experience=experience+$2 WHERE owner_id=$1`, owner, reward.XP); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.sea_progress_entries(operation_id,owner_id,field,delta,after_value) VALUES($1,$2,'experience',$3,$4)`, t.OperationID(), owner, reward.XP, v.Experience+reward.XP); err != nil {
			return assets.Result{}, err
		}
		clears, _ := json.Marshal(cap.Clears)
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET marks=marks+$2,successes=$3,starter=$4,first_clears=$5,heat=LEAST(30,heat+$6),clues=$7,samples=$8 WHERE owner_id=$1`, owner, reward.Marks, cap.Successes, cap.Starter, clears, reward.Heat, cap.Clues, cap.Samples); err != nil {
			return assets.Result{}, err
		}
		raw, _ = json.Marshal(reward)
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_expeditions SET claimed_at=clock_timestamp(),claim_operation=$2,reward=$3 WHERE id=$1`, id, t.OperationID(), raw); err != nil {
			return assets.Result{}, err
		}
		if force {
			if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,'expedition/finish',$4,'管理员提前结束并按原奖励结算')`, actor, actorName, owner, strconv.FormatInt(id, 10)); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: "claimed", ResourceID: strconv.FormatInt(id, 10), Details: raw}, nil
	})
}
func (s *Service) RedeemSet(ctx context.Context, owner int64, key, setID, part string, starter bool) (assets.Result, error) {
	var set rules.GearSet
	for _, v := range s.catalog.GearSets() {
		if v.ID == setID {
			set = v
		}
	}
	if set.ID == "" || set.Pending || (!starter && part != "rod" && part != "charm") || (starter && part != "") {
		return assets.Result{}, assets.ErrInvalid
	}
	input := struct {
		Set, Part string
		Starter   bool
	}{setID, part, starter}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_set_redeem", RuleVersion: "expedition-v1", Players: []int64{owner}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		v, err := state(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if v.Level < set.Level {
			return assets.Result{}, assets.Rejection("ship_level_insufficient")
		}
		if err = ensureCaptain(ctx, t, owner); err != nil {
			return assets.Result{}, err
		}
		cap, err := captain(ctx, t.SQL(), owner)
		if err != nil {
			return assets.Result{}, err
		}
		if starter {
			if cap.Starter != 1 {
				return assets.Result{}, assets.Rejection("starter_unavailable")
			}
		} else if cap.Marks < set.Cost {
			return assets.Result{}, assets.Rejection("marks_insufficient")
		}
		ids := []string{}
		for _, p := range set.Pieces {
			if !starter && part != p.Part {
				continue
			}
			base, ok := s.catalog.Item("set_" + set.ID + "_" + p.Part)
			if !ok {
				return assets.Result{}, assets.ErrInvalid
			}
			signature := rules.InstanceID(base, "epic", []rules.Affix{{Type: p.Type, Value: p.Value}})
			if sig, ok := s.catalog.GearCoreSignature(set.ID, p.Part); ok {
				signature = sig
			}
			attrs, _ := json.Marshal(map[string]any{"signature": signature})
			id, err := t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: base.ID, Part: p.Part, Attributes: attrs})
			if err != nil {
				return assets.Result{}, err
			}
			ids = append(ids, strconv.FormatInt(id, 10))
		}
		if starter {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET starter=2 WHERE owner_id=$1`, owner)
		} else {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_captains SET marks=marks-$2 WHERE owner_id=$1`, owner, set.Cost)
		}
		if err != nil {
			return assets.Result{}, err
		}
		raw, _ := json.Marshal(map[string]any{"equipmentIds": ids, "set": set.ID})
		return assets.Result{Status: "redeemed", Details: raw}, nil
	})
}
