package gateway

import (
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/house"
	"fishing.local/server/internal/rules"
	"net/http"
)

// houseInvariants renders the load-bearing rules as operator-readable badges.
// It mirrors ValidateHut, which only enforces lower bounds and structural
// coherence: the console has no upper limits, so oversized (but self-consistent)
// values must read as healthy here as well.
func houseInvariants(c *rules.Catalog) []map[string]any {
	h := c.HutConfig()
	// A production catalog can still point at a release published before the
	// HUT section existed: HutConfig then reports a zero value and the level
	// curve is empty. Report that as a failing badge instead of indexing an
	// empty slice (which used to drop the admin request).
	topLevel := 0.0
	if len(h.Levels) > 0 {
		topLevel = h.Levels[len(h.Levels)-1]
	}
	rows := []struct {
		name string
		ok   bool
		note string
	}{
		{"已发布渔屋配置段", len(h.Levels) > 0, "缺失时升级 / 翻新 / 宠物 / 角色全部不可用"},
		{"等级曲线单调不减", len(h.Levels) == 10 && monotonic(h.Levels), "Lv1→Lv10"},
		{"晒场容量 ≥ 1h", h.CapacityHours >= 1, "当前 " + trimNum(h.CapacityHours) + "h，后台不设上限"},
		{"渐近线不低于满级速率", h.AsymptoteRate >= topLevel, "否则翻新会降速"},
		{"渐近速度 > 0", h.EndlessTau > 0, "越小越快撞线"},
		{"偷取参数自洽", h.StealPerPickCap*int64(h.StealPicksPerDay) >= h.StealDailyCoinCap, "单次 × 次数 ≥ 日上限"},
		{"好友关系门槛 ≥ 24h", h.RelationshipMinHours >= 24, "防小号互刷"},
		{"升级消耗只用白名单材料", hutMaterialsAllowed(c), "风暴遗物 / 强化合金 / 普通鱼饵材料"},
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]any{"name": r.name, "ok": r.ok, "detail": r.note})
	}
	return out
}

func monotonic(v []float64) bool {
	for i := 1; i < len(v); i++ {
		if v[i] < v[i-1] {
			return false
		}
	}
	return true
}

func trimNum(v float64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func hutMaterialsAllowed(c *rules.Catalog) bool {
	h := c.HutConfig()
	for _, cost := range h.UpgradeCosts {
		for id := range cost.Items {
			found := false
			for _, want := range h.MaterialWhitelist {
				if want == id {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}
	return true
}

// adminHouse serves the current config plus (optionally) one player's view.
// Shape mirrors adminGear so the console code stays uniform.
func (a *API) adminHouse(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	out := map[string]any{
		"config":     c.HutConfig(),
		"revision":   rev,
		"invariants": houseInvariants(c),
	}
	if target := r.URL.Query().Get("target"); target != "" {
		id, exists, e := a.legacyAdminTarget(r.Context(), target)
		if e != nil || !exists {
			write(w, 404, map[string]any{"error": "账号不存在"})
			return
		}
		view, e := house.New(a.pool, c).View(r.Context(), id)
		if e != nil {
			failure(w, e)
			return
		}
		out["player"] = view
	}
	write(w, 200, out)
}

// adminHouseConfig publishes a new HUT section through the catalog release
// chain, exactly like the gear system: validate first, then publish atomically
// with the caller's expected revision.
func (a *API) adminHouseConfig(w http.ResponseWriter, r *http.Request) {
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
	var cfg rules.HutConfig
	if len(body["config"]) == 0 || json.Unmarshal(body["config"], &cfg) != nil {
		write(w, 400, map[string]any{"error": "渔屋配置格式错误"})
		return
	}
	c.Constants["HUT"] = cfg.Raw()
	if err = c.ValidateHut(); err != nil {
		write(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if _, ok = worldPublish(a, w, r, session, body, "/api/admin/house/config", "渔屋", c, rev); !ok {
		return
	}
	write(w, 200, map[string]any{"ok": true})
}

// adminHouseSimulate answers "what would this draft do?" without writing
// anything — the console refuses to publish while violations are non-empty.
func (a *API) adminHouseSimulate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	var cfg rules.HutConfig
	if len(body["config"]) == 0 || json.Unmarshal(body["config"], &cfg) != nil {
		write(w, 400, map[string]any{"error": "渔屋配置格式错误"})
		return
	}
	c.Constants["HUT"] = cfg.Raw()
	if err = c.ValidateHut(); err != nil {
		write(w, 200, map[string]any{"ok": true, "violations": []string{err.Error()}})
		return
	}
	sim := c.SimulateHut()
	// Invariant badges are returned for the draft, not the live config, so the
	// console can highlight exactly what would break.
	write(w, 200, map[string]any{
		"ok":           true,
		"phases":       sim.Phases,
		"endlessTotal": sim.EndlessTotal,
		"violations":   sim.Violations,
		"invariants":   houseInvariants(c),
	})
}

// adminHousePlayer performs one of the bounded operator interventions. There is
// deliberately no "set coins" or "set level" backdoor: every write still goes
// through the same asset transaction and audit path the player uses.
func (a *API) adminHousePlayer(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target     string      `json:"target"`
		RequestKey string      `json:"requestKey"`
		Before     house.State `json:"before"`
		After      house.State `json:"after"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner, exists, err := a.legacyAdminTarget(r.Context(), in.Target)
	if err != nil || !exists {
		write(w, 404, map[string]any{"error": "账号不存在"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	svc := house.New(a.pool, c)
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, true)
	var result assets.Result
	switch r.URL.Query().Get("op") {
	case "reset":
		// 清空已攒时长（结算时刻前推到 now）。只允许往前推，绝不提前发奖。
		result, err = svc.AdminReset(ctx, session.AccountID, owner, in.RequestKey)
	case "freeze":
		result, err = svc.AdminFreeze(ctx, session.AccountID, owner, in.RequestKey, true)
	case "unfreeze":
		result, err = svc.AdminFreeze(ctx, session.AccountID, owner, in.RequestKey, false)
	default:
		write(w, 400, map[string]any{"error": "unknown_op"})
		return
	}
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	if code := houseRejection(result); code != "" {
		write(w, 409, map[string]any{"error": code})
		return
	}
	write(w, 200, map[string]any{"ok": true, "result": result})
}
