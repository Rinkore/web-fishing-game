package gateway

import (
	"encoding/json"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

type legacyChestDef struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Rarity     string  `json:"rarity"`
	Desc       string  `json:"desc"`
	Mode       string  `json:"mode"`
	CostRelic  int64   `json:"costRelic"`
	CostCoins  int64   `json:"costCoins"`
	Price      float64 `json:"price"`
	Extra      bool    `json:"extra"`
	MinAffixes int     `json:"minAffixes"`
	ForceMax   bool    `json:"forceMax"`
}

func (a *API) legacyChestDefs(c *rules.Catalog) []legacyChestDef {
	var defs []legacyChestDef
	_ = c.Constant("CHESTS", &defs)
	return defs
}

// legacyChestList rebuilds the legacy chest catalogue view with pity progress.
func (a *API) legacyChestList(r *http.Request, c *rules.Catalog, owner int64) ([]map[string]any, error) {
	have := map[string]int64{}
	rows, err := a.pool.Query(r.Context(), `SELECT item_id,COALESCE(sum(quantity),0) FROM fishing.inventory_stacks WHERE owner_id=$1 AND quantity>0 GROUP BY item_id`, owner)
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
		have[id] = qty
	}
	if rows.Err() != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()
	pity := map[string]int64{}
	rows, err = a.pool.Query(r.Context(), `SELECT chest_id,misses FROM fishing.chest_pity WHERE owner_id=$1`, owner)
	if err != nil {
		return nil, identity.ErrStorage
	}
	for rows.Next() {
		var id string
		var n int64
		if rows.Scan(&id, &n) != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		pity[id] = n
	}
	if rows.Err() != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()
	out := []map[string]any{}
	for _, d := range a.legacyChestDefs(c) {
		out = append(out, map[string]any{
			"id": d.ID, "name": d.Name, "rarity": d.Rarity, "desc": d.Desc, "mode": d.Mode,
			"costRelic": d.CostRelic, "costCoins": d.CostCoins, "price": d.Price,
			"hasExtra": d.Extra, "minAffixes": d.MinAffixes, "forceMax": d.ForceMax,
			"have": have[d.ID], "pityNow": pity[d.ID], "pityNeed": 0,
		})
	}
	return out, nil
}

func (a *API) legacyChest(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	chests, err := a.legacyChestList(r, c, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	relic, _ := c.Item("relic")
	var relicHave, coins int64
	_ = a.pool.QueryRow(r.Context(), `SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='relic' AND tier='normal'),0)`, session.AccountID).Scan(&relicHave)
	_ = a.pool.QueryRow(r.Context(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, session.AccountID).Scan(&coins)
	write(w, 200, map[string]any{
		"chests": chests, "relicId": "relic", "relicName": relic.Name, "relicHave": relicHave,
		"relicPrice": relic.Price, "pityN": 0, "coins": coins,
	})
}

func (a *API) legacyChestCraft(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ChestID string `json:"chestId"`
		Qty     int64  `json:"qty"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Qty == 0 {
		in.Qty = 1
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if _, ok := c.Chest(in.ChestID); !ok {
		write(w, 400, map[string]any{"error": "unknown_chest", "code": "unknown_chest"})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Chest(ctx, workshop.ChestCommand{ActorID: session.AccountID, RequestKey: "legacy:chest:craft:" + strconv.FormatInt(timeNowMS(), 10), ChestID: in.ChestID, Action: "craft", Quantity: in.Qty})
	if err != nil {
		a.legacySeaFailure(w, err)
		return
	}
	if res.Status != "crafted" {
		write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	chests, err := a.legacyChestList(r, c, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{
		"ok": true, "chestId": in.ChestID, "qty": in.Qty, "coins": profile["coins"],
		"inventory": profile["inventory"], "invRev": profile["invRev"], "chests": chests,
	})
}

func (a *API) legacyChestOpen(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ChestID string `json:"chestId"`
		Part    string `json:"part"`
		BaseID  string `json:"baseId"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	def, ok := c.Chest(in.ChestID)
	if !ok {
		write(w, 400, map[string]any{"error": "unknown_chest", "code": "unknown_chest"})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Chest(ctx, workshop.ChestCommand{ActorID: session.AccountID, RequestKey: "legacy:chest:open:" + strconv.FormatInt(timeNowMS(), 10), ChestID: in.ChestID, Action: "open", Part: in.Part, BaseID: in.BaseID, Quantity: 1})
	if err != nil {
		a.legacySeaFailure(w, err)
		return
	}
	if res.Status != "opened" {
		write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	var details struct {
		Signature string `json:"signature"`
		PityNow   int64  `json:"pityNow"`
		Forced    bool   `json:"forced"`
	}
	_ = json.Unmarshal(res.Details, &details)
	meta, _ := c.ComponentMeta(details.Signature)
	item := map[string]any{
		"id": meta.ID, "baseId": meta.BaseID, "kind": "component", "name": meta.Name,
		"part": meta.Part, "quality": meta.Quality, "qualityName": meta.QualityName,
		"rarity": meta.Rarity, "rarityName": meta.RarityName, "affixes": meta.Affixes,
		"pool": meta.Pool, "maxAffixes": meta.MaxAffixes, "full": meta.Full,
		"breakthrough": len(meta.Affixes) > 3, "price": meta.Price, "size": nil,
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	chests, err := a.legacyChestList(r, c, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	chestName := ""
	for _, d := range a.legacyChestDefs(c) {
		if d.ID == def.ID {
			chestName = d.Name
			break
		}
	}
	write(w, 200, map[string]any{
		"ok": true, "chestId": def.ID, "chestName": chestName, "item": item, "coins": profile["coins"],
		"inventory": profile["inventory"], "invRev": profile["invRev"], "forced": details.Forced,
		"pityNow": details.PityNow, "pityNeed": 0, "chests": chests,
	})
}
