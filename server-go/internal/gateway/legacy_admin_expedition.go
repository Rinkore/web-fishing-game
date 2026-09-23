package gateway

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/rules"
)

func (a *API) adminExpedition(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	out := map[string]any{"config": c.ExpeditionConfig(), "sets": c.GearSets(), "revision": rev}
	if target := r.URL.Query().Get("target"); target != "" {
		id, exists, err := a.legacyAdminTarget(r.Context(), target)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		if !exists {
			write(w, 404, map[string]any{"error": "账号不存在"})
			return
		}
		v, err := sea.New(a.pool, c, a.location).ExpeditionView(r.Context(), id)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		out["player"] = v
	}
	write(w, 200, out)
}

func (a *API) adminExpeditionPlayer(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target     string      `json:"target"`
		RequestKey string      `json:"requestKey"`
		Before     sea.Captain `json:"before"`
		After      sea.Captain `json:"after"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner, exists, err := a.legacyAdminTarget(r.Context(), in.Target)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if !exists {
		write(w, 404, map[string]any{"error": "账号不存在"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	result, err := sea.New(a.pool, c, a.location).EditCaptain(assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true), actor.AccountID, owner, in.RequestKey, actor.Name, in.Before, in.After)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if result.Status != "updated" {
		write(w, 400, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true})
}
func (a *API) adminExpeditionFinish(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target     string `json:"target"`
		ID         string `json:"id"`
		RequestKey string `json:"requestKey"`
		Confirm    bool   `json:"confirm"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !in.Confirm {
		write(w, 400, map[string]any{"error": "请确认快速结算"})
		return
	}
	owner, exists, err := a.legacyAdminTarget(r.Context(), in.Target)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if !exists {
		write(w, 404, map[string]any{"error": "账号不存在"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	id, _ := strconv.ParseInt(in.ID, 10, 64)
	result, err := sea.New(a.pool, c, a.location).FinishExpedition(assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true), actor.AccountID, owner, in.RequestKey, id, actor.Name)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if result.Status != "claimed" {
		write(w, 400, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true, "result": result})
}
func (a *API) adminExpeditionConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	var cfg rules.ExpeditionConfig
	var sets []rules.GearSet
	if json.Unmarshal(body["config"], &cfg) != nil || json.Unmarshal(body["sets"], &sets) != nil {
		write(w, 400, map[string]any{"error": "远航配置格式错误"})
		return
	}
	// Preserve known route and set identities: rewards/effects use those IDs.
	old := c.ExpeditionConfig()
	known := map[string]bool{}
	for _, v := range old.Routes {
		known[v.ID] = true
	}
	valid := cfg.Ticket >= 0 && cfg.Ticket <= 1000000 && len(cfg.Hours) > 0 && len(cfg.Routes) == len(old.Routes)
	hs := map[int]bool{}
	for _, h := range cfg.Hours {
		if (h != 2 && h != 8 && h != 12) || hs[h] {
			valid = false
		}
		hs[h] = true
	}
	for _, v := range cfg.Routes {
		if !known[v.ID] || len([]rune(v.Name)) < 1 || len([]rune(v.Name)) > 40 || len([]rune(v.Description)) > 500 || v.Level < 1 || v.Level > 5 || v.Success < 0 || v.Success > 100 || v.Coins < 0 || v.Coins > 1000000000 {
			valid = false
		}
		delete(known, v.ID)
	}
	catalysts := map[string]rules.Catalyst{}
	for _, v := range old.Catalysts {
		catalysts[v.ID] = v
	}
	if len(cfg.Catalysts) != len(catalysts) {
		valid = false
	}
	routes := map[string]bool{}
	for _, v := range cfg.Routes {
		routes[v.ID] = true
	}
	for _, v := range cfg.Catalysts {
		prior, exists := catalysts[v.ID]
		if !exists || !routes[v.Route] || v.Affix != prior.Affix || (v.MinHours != 2 && v.MinHours != 8 && v.MinHours != 12) {
			valid = false
		}
		delete(catalysts, v.ID)
	}
	priorSets := map[string]rules.GearSet{}
	for _, v := range c.GearSets() {
		priorSets[v.ID] = v
	}
	if len(sets) != len(priorSets) {
		valid = false
	}
	for _, v := range sets {
		prior, exists := priorSets[v.ID]
		if !exists || len(v.Pieces) != len(prior.Pieces) || v.Level < 1 || v.Level > 5 || v.Cost < 0 || v.Cost > 1000000 || len([]rune(v.Name)) < 1 || len([]rune(v.Name)) > 40 || v.Pending != prior.Pending {
			valid = false
		}
		delete(priorSets, v.ID)
		for i, p := range v.Pieces {
			if i >= len(prior.Pieces) || p.Part != prior.Pieces[i].Part || p.Type != prior.Pieces[i].Type || p.Value < 0 || p.Value > 1000 || math.Trunc(p.Value) != p.Value {
				valid = false
			}
		}
	}
	if !valid {
		write(w, 400, map[string]any{"error": "配置数值无效，航线/套装/催化剂标识必须保留"})
		return
	}
	c.Constants["EXPEDITION"], _ = json.Marshal(cfg)
	c.Constants["GEAR_SETS"], _ = json.Marshal(sets)
	if _, ok = worldPublish(a, w, r, actor, body, "/api/admin/expedition/config", "远航与套装", c, rev); !ok {
		return
	}
	write(w, 200, map[string]any{"ok": true})
}
