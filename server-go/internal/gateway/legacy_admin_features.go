package gateway

import (
	"context"
	"net/http"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/operations"
)

// These descriptions are the compatibility contract consumed by the existing
// admin.js editor. The actual gates remain the native feature publication;
// legacy child flags are retained in the same immutable release for old UI
// round-tripping and future per-action gates.
var legacyFeatureGroups = []map[string]any{
	{"id": "fishing", "name": "钓鱼", "parent": nil, "children": []map[string]any{{"id": "fishing.cast", "name": "抛竿与自动钓鱼", "parent": "fishing"}}},
	{"id": "bd", "name": "钓竿（角色页签）", "parent": "fishing", "children": []map[string]any{{"id": "bd.equip", "name": "装备组件", "parent": "bd"}, {"id": "bd.slots", "name": "购买槽位", "parent": "bd"}, {"id": "bd.save", "name": "保存与管理钓竿", "parent": "bd"}, {"id": "bd.autobuild", "name": "自动配装", "parent": "bd"}}},
	{"id": "character", "name": "角色", "parent": nil, "children": []map[string]any{{"id": "character.companion", "name": "选择同伴", "parent": "character"}, {"id": "character.boat", "name": "选择船型", "parent": "character"}}},
	{"id": "sea", "name": "远洋", "parent": nil, "children": []map[string]any{{"id": "sea.upgrade", "name": "船升级", "parent": "sea"}, {"id": "sea.chart", "name": "海图合成", "parent": "sea"}, {"id": "sea.voyage", "name": "随机海域出航", "parent": "sea"}, {"id": "sea.quest", "name": "每日悬赏", "parent": "sea"}, {"id": "sea.anchor", "name": "锚地续期", "parent": "sea"}, {"id": "sea.expedition", "name": "离线远航派遣", "parent": "sea"}}},
	{"id": "ground", "name": "社交", "parent": nil, "children": []map[string]any{{"id": "ground.trade", "name": "玩家交易", "parent": "ground"}, {"id": "ground.party", "name": "编队出海", "parent": "ground"}}},
	{"id": "inventory", "name": "背包", "parent": nil, "children": []map[string]any{{"id": "inventory.subscribe", "name": "组件订阅提醒", "parent": "inventory"}}},
	{"id": "workshop", "name": "工坊", "parent": nil, "children": []map[string]any{{"id": "workshop.craft", "name": "合成宝匣", "parent": "workshop"}, {"id": "workshop.open", "name": "开启宝匣", "parent": "workshop"}, {"id": "workshop.growth", "name": "装备成长", "parent": "workshop"}, {"id": "workshop.sets", "name": "套装成长与偏好", "parent": "workshop"}}},
	{"id": "mall", "name": "商城", "parent": nil, "children": []map[string]any{{"id": "mall.buy", "name": "限购商品购买", "parent": "mall"}, {"id": "mall.sell", "name": "出售物品（含背包入口）", "parent": "mall"}, {"id": "mall.autosell", "name": "自动售出", "parent": "mall"}, {"id": "mall.list", "name": "市集上架", "parent": "mall"}, {"id": "mall.marketbuy", "name": "市集购买", "parent": "mall"}}},
	{"id": "codex", "name": "图鉴", "parent": nil, "children": []map[string]any{}},
	{"id": "records", "name": "记录（图鉴页签）", "parent": "codex", "children": []map[string]any{}},
	{"id": "feedback", "name": "反馈", "parent": nil, "children": []map[string]any{{"id": "feedback.submit", "name": "提交反馈", "parent": "feedback"}, {"id": "feedback.skip", "name": "付费跳过冷却", "parent": "feedback"}}},
	{"id": "mail", "name": "邮件", "parent": nil, "children": []map[string]any{}},
	{"id": "logs", "name": "日志", "parent": nil, "children": []map[string]any{}},
}

var legacyFeatureMenuIDs = []string{"fishing", "sea", "character", "ground", "inventory", "mail", "workshop", "mall", "codex", "feedback", "logs"}

type legacyFeatureMetadata struct {
	Order       map[string][]string `json:"order"`
	AdminBypass bool                `json:"adminBypass"`
}

func legacyFeatureMetadataRead(ctx context.Context, a *API) legacyFeatureMetadata {
	var metadata legacyFeatureMetadata
	_ = a.legacyAdminSetting(ctx, "features", &metadata)
	if metadata.Order == nil {
		metadata.Order = map[string][]string{}
	}
	return metadata
}

func legacyFeatureIDs() map[string]bool {
	ids := map[string]bool{"adminBypass": true}
	for _, id := range legacyFeatureMenuIDs {
		ids[id] = true
	}
	for _, group := range legacyFeatureGroups {
		ids[group["id"].(string)] = true
		for _, child := range group["children"].([]map[string]any) {
			ids[child["id"].(string)] = true
		}
	}
	return ids
}

func legacyFeatureOrderValid(order map[string][]string) bool {
	validMenu := func(values []string, allowed []string) bool {
		if len(values) != len(allowed) {
			return false
		}
		seen := map[string]bool{}
		for _, value := range values {
			found := false
			for _, candidate := range allowed {
				if value == candidate {
					found = true
					break
				}
			}
			if !found || seen[value] {
				return false
			}
			seen[value] = true
		}
		return true
	}
	for key, values := range order {
		if key == "menu" {
			if !validMenu(values, legacyFeatureMenuIDs) {
				return false
			}
			continue
		}
		var allowed []string
		for _, group := range legacyFeatureGroups {
			if group["id"] != key {
				continue
			}
			for _, child := range group["children"].([]map[string]any) {
				allowed = append(allowed, child["id"].(string))
			}
		}
		if len(allowed) == 0 || !validMenu(values, allowed) {
			return false
		}
	}
	return true
}

func legacyFeatureOrder(metadata legacyFeatureMetadata) map[string][]string {
	out := map[string][]string{"menu": append([]string(nil), legacyFeatureMenuIDs...)}
	if values := metadata.Order["menu"]; legacyFeatureOrderValid(map[string][]string{"menu": values}) {
		out["menu"] = append([]string(nil), values...)
	} else if len(values) > 0 {
		// Adding a menu entry must preserve the operator's existing ordering.
		known, seen := map[string]bool{}, map[string]bool{}
		for _, id := range legacyFeatureMenuIDs {
			known[id] = true
		}
		merged := []string{}
		for _, id := range values {
			if known[id] && !seen[id] {
				merged = append(merged, id)
				seen[id] = true
			}
		}
		for _, id := range legacyFeatureMenuIDs {
			if !seen[id] {
				merged = append(merged, id)
			}
		}
		out["menu"] = merged
	}
	for _, group := range legacyFeatureGroups {
		id := group["id"].(string)
		var defaults []string
		for _, child := range group["children"].([]map[string]any) {
			defaults = append(defaults, child["id"].(string))
		}
		if len(defaults) == 0 {
			continue
		}
		out[id] = defaults
		if values := metadata.Order[id]; legacyFeatureOrderValid(map[string][]string{id: values}) {
			out[id] = append([]string(nil), values...)
		}
	}
	return out
}

func (a *API) legacyFeatureView(ctx context.Context) (map[string]any, error) {
	current, err := operations.New(a.pool).Features(ctx)
	if err != nil {
		return nil, err
	}
	metadata := legacyFeatureMetadataRead(ctx, a)
	features := legacyAdminFeatureFlags(current.Flags)
	features["adminBypass"] = metadata.AdminBypass
	return map[string]any{"features": features, "featureOrder": legacyFeatureOrder(metadata), "groups": legacyFeatureGroups}, nil
}

func (a *API) legacyAdminFeatures(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	ctx := r.Context()
	if r.Method == http.MethodGet {
		view, err := a.legacyFeatureView(ctx)
		if err != nil {
			failure(w, err)
			return
		}
		write(w, 200, view)
		return
	}
	var in struct {
		Token        string              `json:"token"`
		Features     map[string]bool     `json:"features"`
		FeatureOrder map[string][]string `json:"featureOrder"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Features == nil {
		in.Features = map[string]bool{}
	}
	ids := legacyFeatureIDs()
	for id := range in.Features {
		if !ids[id] {
			legacyTradeError(w, 400, "未知功能或开关值不是布尔值")
			return
		}
	}
	if menu, exists := in.FeatureOrder["menu"]; exists && len(menu) == len(legacyFeatureMenuIDs)-1 {
		// Older open consoles predate the mail entry. Append only this new ID;
		// the ordinary validator still rejects other omissions and duplicates.
		in.FeatureOrder["menu"] = append(append([]string{}, menu...), "mail")
	}
	if in.FeatureOrder != nil && !legacyFeatureOrderValid(in.FeatureOrder) {
		legacyTradeError(w, 400, "菜单排序包含未知、重复或缺失项")
		return
	}
	current, err := operations.New(a.pool).Features(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	flags := map[string]bool{}
	for key, value := range current.Flags {
		flags[key] = value
	}
	// A fresh database has no feature release yet; the legacy server treats
	// every known native gate as enabled until an operator publishes one.
	for _, key := range []string{"market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends"} {
		if _, ok := flags[key]; !ok {
			flags[key] = true
		}
	}
	metadata := legacyFeatureMetadataRead(ctx, a)
	for key, value := range in.Features {
		if key == "adminBypass" {
			metadata.AdminBypass = value
			continue
		}
		flags[key] = value
	}
	// Root legacy switches map to the corresponding native gate as well, so
	// closing a page has an immediate effect on the implemented Go commands.
	for key, value := range in.Features {
		for _, native := range legacyNativeForRoot(key) {
			flags[native] = value
		}
	}
	if in.FeatureOrder != nil {
		metadata.Order = in.FeatureOrder
	}
	now := time.Now().UnixNano()
	key := "legacy-admin-features-" + actor.Username + "-" + stringInt64(now)
	adminBypass := metadata.AdminBypass
	assetCtx := assets.WithSession(ctx, actor.AccountID, actor.Hash, true)
	result, err := operations.New(a.pool).Publish(assetCtx, operations.Publish{
		ActorID: actor.AccountID, RequestKey: key, ExpectedRevision: current.Revision,
		Flags: flags, LegacyOrder: metadata.Order, LegacyAdminBypass: &adminBypass,
		LegacyAuditAction: "features/update", LegacyAuditDetail: featureAuditDetail(in.Features, metadata.Order),
	})
	if err != nil {
		assetResponse(w, result, err)
		return
	}
	if result.Status != "published" {
		assetResponse(w, result, assets.Rejection(result.Status))
		return
	}
	view, err := a.legacyFeatureView(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	view["ok"] = true
	write(w, 200, view)
}

func legacyNativeForRoot(key string) []string {
	switch key {
	case "fishing":
		return []string{"fishing"}
	case "sea":
		return []string{"sea"}
	case "ground":
		return []string{"trade", "party"}
	case "workshop":
		return []string{"workshop", "chest"}
	case "mall":
		return []string{"mall", "sell", "autosell", "market"}
	}
	return nil
}

func stringInt64(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}

func featureAuditDetail(changes map[string]bool, order map[string][]string) string {
	return "features=" + stringInt64(int64(len(changes))) + " order=" + stringInt64(int64(len(order)))
}
