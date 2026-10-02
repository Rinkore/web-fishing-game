package gateway

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/gear"
	"fishing.local/server/internal/rules"
	"net/http"
)

func (a *API) gearView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	view, err := gear.New(a.pool, c).View(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	bindings, err := rewardBindings(r.Context(), a.pool, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	view["rewardBindings"] = bindings
	write(w, 200, view)
}
func (a *API) gearAction(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in gear.Command
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	result, err := gear.New(a.pool, c).Apply(assets.WithSession(r.Context(), session.AccountID, session.Hash, false), session.AccountID, in)
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	if result.Status != "crafted" {
		write(w, 400, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true, "result": result})
}
func (a *API) adminGear(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	out := map[string]any{"config": c.GearConfig(), "revision": rev, "items": c.Items}
	if target := r.URL.Query().Get("target"); target != "" {
		id, exists, e := a.legacyAdminTarget(r.Context(), target)
		if e != nil || !exists {
			write(w, 404, map[string]any{"error": "账号不存在"})
			return
		}
		v, e := gear.New(a.pool, c).View(r.Context(), id)
		if e != nil {
			failure(w, e)
			return
		}
		out["player"] = v
	}
	write(w, 200, out)
}
func (a *API) adminGearConfig(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	var cfg rules.GearConfig
	if json.Unmarshal(body["config"], &cfg) != nil || !cfg.Enabled {
		write(w, 400, map[string]any{"error": "装备系统配置格式错误"})
		return
	}
	c.Constants["GEAR_SYSTEM"] = cfg.Raw()
	if err = c.ValidateGear(); err != nil {
		write(w, 400, map[string]any{"error": err.Error()})
		return
	}
	sets := c.GearSets()
	for i := range sets {
		if ability, ok := cfg.Sets[sets[i].ID]; ok {
			sets[i].Name = ability.Name
			sets[i].Effect = ability.Description
			for j := range sets[i].Pieces {
				if attrs, exists := ability.CoreAttributes[sets[i].Pieces[j].Part]; exists {
					for kind, value := range attrs {
						sets[i].Pieces[j].Type = kind
						sets[i].Pieces[j].Value = value
						break
					}
				}
			}
		} else if ability, ok := cfg.Specializations[sets[i].ID]; ok {
			sets[i].Name = ability.Name
			sets[i].Effect = ability.Description
		}
	}
	c.Constants["GEAR_SETS"], _ = json.Marshal(sets)
	if _, ok = worldPublish(a, w, r, session, body, "/api/admin/gear/config", "装备成长与套装效果", c, rev); !ok {
		return
	}
	write(w, 200, map[string]any{"ok": true})
}
func (a *API) adminGearPlayer(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target     string     `json:"target"`
		RequestKey string     `json:"requestKey"`
		Before     gear.State `json:"before"`
		After      gear.State `json:"after"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner, exists, err := a.legacyAdminTarget(r.Context(), in.Target)
	if err != nil || !exists {
		write(w, 404, map[string]any{"error": "账号不存在"})
		return
	}
	v := in.After
	if v.Heat < 0 || v.Heat > 10000 || v.Receipts < 0 || v.Receipts > 1000000 || v.Tracking < 0 || v.Tracking > 100000 || v.Harvest < 0 || v.Harvest > 100000 || v.HeatMS < 0 || v.HeatMS > 1e9 || v.ArchaeologyHours < 0 || v.ArchaeologyHours > 100000 || v.ReceiptRemainder < 0 || v.ReceiptRemainder > 168 {
		write(w, 400, map[string]any{"error": "进度数值超出范围"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	cfg := c.GearConfig()
	for id, n := range v.Tiers {
		_, f := cfg.Sets[id]
		_, s := cfg.Specializations[id]
		if (!f && !s) || n < 0 || n > 3 {
			write(w, 400, map[string]any{"error": "套装阶段无效"})
			return
		}
	}
	for id := range v.Unlocked {
		if _, ok := cfg.Specializations[id]; !ok {
			write(w, 400, map[string]any{"error": "专精标识无效"})
			return
		}
	}
	allocation, e := gear.ValidateAllocation(cfg, v, v.Allocations, v.VoyageMode)
	if e != nil {
		write(w, 400, map[string]any{"error": "专精配置无效"})
		return
	}
	if v.Focus != "" {
		it, ok := c.Item(v.Focus)
		if !ok || it.Kind != "material" {
			write(w, 400, map[string]any{"error": "定向货物无效"})
			return
		}
	}
	v.Allocations = allocation
	v.Selected = gear.AllocationSelection(allocation)
	players := []int64{owner}
	if owner != session.AccountID {
		players = append(players, session.AccountID)
	}
	result, err := assets.New(a.pool).Run(assets.WithSession(r.Context(), session.AccountID, session.Hash, true), assets.Command{ActorID: session.AccountID, RequestKey: in.RequestKey, Kind: "admin_grant", RuleVersion: "gear-admin-v1", Players: players, Input: in}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		current, e := gear.Read(ctx, t.SQL(), owner)
		if e != nil {
			return assets.Result{}, e
		}
		a, _ := json.Marshal(current)
		b, _ := json.Marshal(in.Before)
		if string(a) != string(b) {
			return assets.Result{}, assets.Rejection("进度已变化，请重新查询")
		}
		if e = gear.Write(ctx, t, owner, v); e != nil {
			return assets.Result{}, e
		}
		_, e = t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,'gear/player',$4,'修改装备与套装成长进度')`, session.AccountID, session.Name, owner, in.Target)
		return assets.Result{Status: "updated"}, e
	})
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	if result.Status != "updated" {
		write(w, 409, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true})
}
