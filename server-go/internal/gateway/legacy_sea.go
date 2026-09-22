package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

type legacyShipCfg struct {
	Levels []struct {
		Lv   int    `json:"lv"`
		Name string `json:"name"`
	} `json:"levels"`
	XPNeed  []int64 `json:"xpNeed"`
	UpCoins []int64 `json:"upCoins"`
	UpScale []int64 `json:"upScale"`
}

type legacyNightglow struct {
	On   bool `json:"on"`
	From int  `json:"from"`
	To   int  `json:"to"`
	Rare int  `json:"rare"`
}

// legacySea assembles the original /api/sea view from the durable sea module.
func (a *API) legacySea(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	view, err := a.legacySeaView(r, c, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, view)
}

func (a *API) legacySeaView(r *http.Request, c *rules.Catalog, owner int64) (map[string]any, error) {
	ctx := r.Context()
	svc := sea.New(a.pool, c, a.location)
	state, err := svc.View(ctx, owner)
	if err != nil {
		return nil, err
	}
	zones, err := svc.Zones(ctx, owner)
	if err != nil {
		return nil, err
	}
	shared, err := sea.MemberZones(ctx, a.pool, owner)
	if err != nil {
		return nil, err
	}
	board, err := svc.QuestView(ctx, owner)
	if err != nil {
		return nil, err
	}
	var shipCfg legacyShipCfg
	if err := c.Constant("SHIP", &shipCfg); err != nil {
		return nil, identity.ErrStorage
	}
	var raw struct {
		Nightglow legacyNightglow `json:"nightglow"`
	}
	_ = c.Constant("SEA", &raw)
	ng := raw.Nightglow
	seaCfg := c.SeaConfig()

	counts := map[string]int64{}
	rows, err := a.pool.Query(ctx, `SELECT item_id,COALESCE(sum(quantity),0) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id IN ('chartfrag','deepscale') GROUP BY item_id`, owner)
	if err != nil {
		return nil, identity.ErrStorage
	}
	for rows.Next() {
		var id string
		var qty int64
		if rows.Scan(&id, &qty) != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		counts[id] = qty
	}
	if rows.Err() != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()
	var coins int64
	_ = a.pool.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&coins)

	level := state.Level
	var xpNeed any
	if level < 5 {
		xpNeed = shipCfg.XPNeed[level]
	}
	upCoins, upScale := int64(0), int64(0)
	if level < 5 {
		upCoins, upScale = shipCfg.UpCoins[level], shipCfg.UpScale[level]
	}
	shipName := ""
	if level >= 1 && level <= len(shipCfg.Levels) {
		shipName = shipCfg.Levels[level-1].Name
	}

	var ownerKey string
	if err := a.pool.QueryRow(ctx, `SELECT lower(username) FROM fishing.identities WHERE account_id=$1`, owner).Scan(&ownerKey); err != nil {
		return nil, identity.ErrStorage
	}
	zoneList := []map[string]any{}
	for _, z := range zones {
		spots := []map[string]any{}
		for _, s := range z.Spots {
			spots = append(spots, map[string]any{"id": s.ID, "name": s.Name, "buffs": s.Buffs, "pool": s.Pool})
		}
		zoneList = append(zoneList, map[string]any{
			"groundId": "sea:" + ownerKey + ":" + z.ID, "id": z.ID, "name": z.Name,
			"mood": z.Mood, "expire": z.Expire, "anchors": z.Anchors, "spots": spots,
		})
	}
	partyZoneList, err := a.legacySharedZones(ctx, shared)
	if err != nil {
		return nil, err
	}
	questList := []map[string]any{}
	for _, q := range board.Selected {
		tpl := rules.SeaQuest{}
		for _, t := range seaCfg.Quests {
			if t.ID == q.ID {
				tpl = t
				break
			}
		}
		var submit any
		if tpl.Submit != nil {
			var have int64
			_ = a.pool.QueryRow(ctx, `SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier='normal'),0)`, owner, tpl.Submit.ID).Scan(&have)
			it, _ := c.Item(tpl.Submit.ID)
			submit = map[string]any{"id": tpl.Submit.ID, "name": it.Name, "count": tpl.Submit.Count, "have": have}
		}
		questList = append(questList, map[string]any{
			"id": q.ID, "title": tpl.Title, "need": tpl.Need, "progress": q.Progress, "claimed": q.Claimed,
			"reward": tpl.Reward, "kind": tpl.Kind, "submit": submit,
		})
	}

	glow := false
	if ng.On {
		h := time.Now().In(a.location).Hour()
		from, to := ng.From, ng.To
		if from == 0 {
			from = 20
		}
		if to == 0 {
			to = 23
		}
		glow = h >= from && h < to
	}

	var partyID any
	var invite any
	{
		var id int64
		if err := a.pool.QueryRow(ctx, `SELECT m.party_id FROM fishing.party_members m JOIN fishing.parties p ON p.id=m.party_id AND p.active WHERE m.owner_id=$1`, owner).Scan(&id); err == nil {
			partyID = strconv.FormatInt(id, 10)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, identity.ErrStorage
		}
		var invID int64
		if err := a.pool.QueryRow(ctx, `SELECT i.party_id FROM fishing.party_invites i JOIN fishing.parties p ON p.id=i.party_id AND p.active WHERE i.target_id=$1`, owner).Scan(&invID); err == nil {
			var leaderName string
			_ = a.pool.QueryRow(ctx, `SELECT COALESCE(pl.display_name,'') FROM fishing.party_members m JOIN fishing.identities pl ON pl.account_id=m.owner_id WHERE m.party_id=$1 ORDER BY m.joined_revision,m.owner_id LIMIT 1`, invID).Scan(&leaderName)
			invite = map[string]any{"id": strconv.FormatInt(invID, 10), "leaderName": leaderName}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, identity.ErrStorage
		}
	}

	return map[string]any{
		"ship": map[string]any{
			"lv": level, "xp": state.Experience, "name": shipName, "xpNeed": xpNeed,
			"xpOk":    xpNeed != nil && state.Experience >= shipCfg.XPNeed[level],
			"upCoins": upCoins, "upScale": upScale, "max": level >= 5,
		},
		"chartfrag": counts["chartfrag"], "deepscale": counts["deepscale"],
		"charts": state.Charts, "chartCost": seaCfg.ChartCost,
		"zones": zoneList, "glow": glow, "partyZones": partyZoneList, "quests": questList,
		"party": map[string]any{"id": partyID, "invite": invite}, "coins": coins,
		"cfg": map[string]any{
			"ship": map[string]any{"names": shipNames(shipCfg), "xpNeed": shipCfg.XPNeed, "upCoins": shipCfg.UpCoins, "upScale": shipCfg.UpScale},
			"sea": map[string]any{
				"chartCost": seaCfg.ChartCost, "zoneTtlMin": seaCfg.ZoneTTL / 60000, "zoneMax": seaCfg.ZoneMax,
				"events": seaCfg.Events, "anchor": seaCfg.Anchor, "nightglow": ng, "questResetHour": seaCfg.QuestResetHour,
			},
		},
	}, nil
}

func (a *API) legacySharedZones(ctx context.Context, zones []sea.SharedZone) ([]map[string]any, error) {
	out := []map[string]any{}
	keys := map[int64]string{}
	for _, z := range zones {
		key, ok := keys[z.OwnerID]
		if !ok {
			if err := a.pool.QueryRow(ctx, `SELECT lower(username) FROM fishing.identities WHERE account_id=$1`, z.OwnerID).Scan(&key); err != nil {
				return nil, identity.ErrStorage
			}
			keys[z.OwnerID] = key
		}
		out = append(out, map[string]any{"owner": key, "ownerName": z.OwnerName, "groundId": "sea:" + key + ":" + z.ID,
			"id": z.ID, "name": z.Name, "mood": z.Mood, "expire": z.Expire, "spots": z.Spots})
	}
	return out, nil
}

func shipNames(cfg legacyShipCfg) []string {
	out := make([]string, 0, len(cfg.Levels))
	for _, l := range cfg.Levels {
		out = append(out, l.Name)
	}
	return out
}

// legacySeaAction runs one sea write command and returns the refreshed view.
func (a *API) legacySeaAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := a.authorize(w, r, false)
		if !ok {
			return
		}
		feature := map[string]string{"ship": "sea.upgrade", "chart": "sea.chart", "voyage": "sea.voyage", "anchor": "sea.anchor", "quest": "sea.quest"}[action]
		if feature != "" {
			features, featureErr := operations.New(a.pool).Features(r.Context())
			if featureErr != nil {
				failure(w, featureErr)
				return
			}
			if enabled, exists := features.Flags[feature]; exists && !enabled {
				write(w, http.StatusForbidden, map[string]any{"error": "feature_disabled", "code": "feature_disabled"})
				return
			}
		}
		c, err := a.catalog(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		svc := sea.New(a.pool, c, a.location)
		key := "legacy:sea:" + action + ":" + strconv.FormatInt(timeNowMS(), 10)
		ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
		var res assets.Result
		switch action {
		case "ship":
			state, err := svc.View(r.Context(), session.AccountID)
			if err != nil {
				failure(w, err)
				return
			}
			res, err = svc.Apply(ctx, sea.Command{ActorID: session.AccountID, RequestKey: key, Action: "upgrade", ExpectedLevel: state.Level})
			if err != nil {
				a.legacySeaFailure(w, err)
				return
			}
		case "chart":
			res, err = svc.Apply(ctx, sea.Command{ActorID: session.AccountID, RequestKey: key, Action: "chart"})
			if err != nil {
				a.legacySeaFailure(w, err)
				return
			}
		case "voyage":
			res, err = svc.Voyage(ctx, session.AccountID, key)
			if err != nil {
				a.legacySeaFailure(w, err)
				return
			}
		case "anchor":
			var in struct {
				ZoneID string `json:"zoneId"`
			}
			if !decode(w, r, &in) {
				return
			}
			res, err = svc.Anchor(ctx, session.AccountID, key, in.ZoneID)
			if err != nil {
				a.legacySeaFailure(w, err)
				return
			}
		case "quest":
			var in struct {
				ID string `json:"id"`
			}
			if !decode(w, r, &in) {
				return
			}
			res, err = svc.QuestClaim(ctx, session.AccountID, key, in.ID)
			if err != nil {
				a.legacySeaFailure(w, err)
				return
			}
		}
		if res.Status != "upgraded" && res.Status != "crafted" && res.Status != "voyaged" && res.Status != "anchored" && res.Status != "claimed" {
			write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
			return
		}
		view, err := a.legacySeaView(r, c, session.AccountID)
		if err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "sea": view})
	}
}

func (a *API) legacySeaFailure(w http.ResponseWriter, err error) {
	var rejection assets.Rejection
	if errors.As(err, &rejection) {
		write(w, 400, map[string]any{"error": string(rejection), "code": string(rejection)})
		return
	}
	failure(w, identity.ErrStorage)
}
