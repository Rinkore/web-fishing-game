package gateway

// The world/drop editor is deliberately implemented as a catalog editor. A
// published catalog is the only durable source of gameplay rules; keeping a
// second operator_settings copy would make the live stream, fishing workers,
// and the admin view disagree after a restart.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"math/rand"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

const (
	worldMaxBody     = 1 << 20
	worldMaxLootItem = 50
	worldBuffMin     = -100
	worldBuffMax     = 100
)

var (
	worldGroundID = regexp.MustCompile(`^[a-z][a-z0-9_]{1,23}$`)
	worldSpotID   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,23}$`)
	worldRolls    = map[string]bool{"linear": true, "normal": true, "skew": true, "custom": true}
)

type worldBody map[string]json.RawMessage

type worldGroup struct {
	ID     string            `json:"id"`
	Name   string            `json:"name"`
	Weight float64           `json:"weight"`
	Items  []rules.LootEntry `json:"items"`
}

func decodeWorldBody(w http.ResponseWriter, r *http.Request) (worldBody, bool) {
	var body worldBody
	r.Body = http.MaxBytesReader(w, r.Body, worldMaxBody)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(&body); err != nil {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	return body, true
}

func worldRaw(body worldBody, key string) (any, bool) {
	raw, ok := body[key]
	if !ok {
		return nil, false
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, true
	}
	return v, true
}

func worldString(body worldBody, key string) (string, bool) {
	v, ok := worldRaw(body, key)
	s, good := v.(string)
	return s, ok && good
}

func worldNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, finiteWorld(n)
	case json.Number:
		f, err := n.Float64()
		return f, err == nil && finiteWorld(f)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil && finiteWorld(f)
	default:
		return 0, false
	}
}

func finiteWorld(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func worldFloat(body worldBody, key string) (float64, bool) {
	v, ok := worldRaw(body, key)
	if !ok {
		return 0, false
	}
	return worldNumber(v)
}

func worldBool(body worldBody, key string) (bool, bool) {
	v, ok := worldRaw(body, key)
	b, good := v.(bool)
	return b, ok && good
}

func worldExpected(body worldBody, current int64) (int64, bool) {
	v, ok := worldRaw(body, "expectedRevision")
	if !ok {
		return current, true
	}
	n, good := worldNumber(v)
	if !good || n < 0 || math.Trunc(n) != n || n > float64(1<<63-1) {
		return 0, false
	}
	return int64(n), true
}

func worldRequestKey(body worldBody, route string) string {
	if s, ok := worldString(body, "requestKey"); ok && strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s)
	}
	data, _ := json.Marshal(body)
	h := sha256.Sum256(data)
	return "world:" + strings.ReplaceAll(strings.TrimPrefix(route, "/api/admin/"), "/", ".") + ":" + hex.EncodeToString(h[:8])
}

func worldCurrent(ctx context.Context, a *API) (*rules.Catalog, int64, error) {
	return catalog.Current(ctx, a.pool)
}

func worldPublish(a *API, w http.ResponseWriter, r *http.Request, session identity.Session, body worldBody, route, target string, c *rules.Catalog, revision int64) (*rules.Catalog, bool) {
	raw, err := json.Marshal(c)
	if err != nil {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	expected, ok := worldExpected(body, revision)
	if !ok {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	detail := route
	if target != "" {
		detail += " " + target
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, true)
	result, err := catalog.PublishConfig(ctx, a.pool, catalog.Publish{
		ActorID: session.AccountID, RequestKey: worldRequestKey(body, route),
		ExpectedRevision: expected, Catalog: raw,
		AuditAction: legacyAdminClip(strings.TrimPrefix(route, "/api/admin/"), 80), AuditName: legacyAdminClip(session.Name, 120),
		AuditTarget: legacyAdminClip(target, 120), AuditDetail: legacyAdminClip(detail, 200),
	})
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return nil, false
	}
	if result.Status != "published" {
		assetResponse(w, result, assets.Rejection(result.Status))
		return nil, false
	}
	next, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return nil, false
	}
	return next, true
}

func worldJSON(raw json.RawMessage, out any) bool { return json.Unmarshal(raw, out) == nil }

func worldGrounds(c *rules.Catalog) ([]map[string]any, error) {
	var grounds []map[string]any
	if !worldJSON(c.Constants["GROUNDS"], &grounds) || grounds == nil {
		return nil, identity.ErrInvalid
	}
	return grounds, nil
}

func setWorldGrounds(c *rules.Catalog, grounds []map[string]any) error {
	raw, err := json.Marshal(grounds)
	if err == nil {
		c.Constants["GROUNDS"] = raw
	}
	return err
}

func worldGround(grounds []map[string]any, id string) (map[string]any, int) {
	for i, g := range grounds {
		if s, _ := g["id"].(string); s == id {
			return g, i
		}
	}
	return nil, -1
}

func worldSpots(g map[string]any) []map[string]any {
	var out []map[string]any
	raw, _ := json.Marshal(g["spots"])
	_ = json.Unmarshal(raw, &out)
	return out
}

func setWorldSpots(g map[string]any, spots []map[string]any) { g["spots"] = spots }

func worldSpot(g map[string]any, id string) (map[string]any, int) {
	spots := worldSpots(g)
	for i, s := range spots {
		if sid, _ := s["id"].(string); sid == id {
			return s, i
		}
	}
	return nil, -1
}

func worldDefaultGround(id string) (map[string]any, bool) {
	c, err := rules.Default()
	if err != nil {
		return nil, false
	}
	grounds, err := worldGrounds(c)
	if err != nil {
		return nil, false
	}
	g, _ := worldGround(grounds, id)
	return g, g != nil
}

func worldDefaultSpot(groundID, spotID string) (map[string]any, bool) {
	g, ok := worldDefaultGround(groundID)
	if !ok {
		return nil, false
	}
	s, _ := worldSpot(g, spotID)
	return s, s != nil
}

func worldPool(raw any) ([]rules.LootEntry, bool) {
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	var pool []rules.LootEntry
	if json.Unmarshal(b, &pool) != nil {
		return nil, false
	}
	return pool, true
}

func worldEntry(c *rules.Catalog, pick string, weight float64) bool {
	if !finiteWorld(weight) || weight < 0 || weight > 1000000 {
		return false
	}
	kind, id, ok := strings.Cut(pick, ":")
	if !ok {
		return false
	}
	switch kind {
	case "fish":
		return c.FishTier(id) != ""
	case "material":
		it, good := c.Item(id)
		return good && it.Kind == "material"
	case "group":
		return c.LootGroups()[id] != nil
	case "component":
		return worldComponentSelector(c, id)
	default:
		return false
	}
}

func worldComponentSelector(c *rules.Catalog, selector string) bool {
	if selector == "" {
		return true
	}
	if strings.HasPrefix(selector, "base/") {
		it, ok := c.Item(strings.TrimPrefix(selector, "base/"))
		return ok && it.Kind == "component" && it.Part != ""
	}
	if strings.HasPrefix(selector, "part/") {
		part := strings.TrimPrefix(selector, "part/")
		for _, it := range c.Items {
			if it.Kind == "component" && it.Part == part {
				return true
			}
		}
	}
	return false
}

func worldValidatePool(c *rules.Catalog, value any) ([]rules.LootEntry, string) {
	items, ok := value.([]any)
	if !ok || len(items) == 0 {
		return nil, "invalid loot pool"
	}
	out := make([]rules.LootEntry, 0, len(items))
	positive := false
	for _, item := range items {
		m, good := item.(map[string]any)
		if !good {
			return nil, "invalid loot entry"
		}
		pick, _ := m["pick"].(string)
		weight, good := worldNumber(m["weight"])
		if !good || !worldEntry(c, pick, weight) {
			return nil, "invalid loot entry"
		}
		if weight > 0 {
			positive = true
		}
		out = append(out, rules.LootEntry{Pick: pick, Weight: weight})
	}
	if !positive {
		return nil, "loot pool must contain a positive entry"
	}
	return out, ""
}

func worldValidateBuffs(c *rules.Catalog, value any) ([]rules.Buff, string) {
	items, ok := value.([]any)
	if !ok {
		return nil, "invalid buffs"
	}
	labels := legacyAffixLabels(c)
	out := make([]rules.Buff, 0, len(items))
	for _, item := range items {
		m, good := item.(map[string]any)
		if !good {
			return nil, "invalid buff"
		}
		t, _ := m["type"].(string)
		v, good := worldNumber(m["value"])
		if !good || labels[t] == "" || v < worldBuffMin || v > worldBuffMax {
			return nil, "invalid buff"
		}
		out = append(out, rules.Buff{Type: t, Value: math.Round(v*10) / 10})
	}
	return out, ""
}

func worldPoolPresets(c *rules.Catalog) map[string]map[string]any {
	return map[string]map[string]any{
		"economy":  {"name": "经济浅水（新手场）", "desc": "常见鱼为主 + 少量大鱼/材料，收益平稳"},
		"big":      {"name": "大物塘", "desc": "大鱼与稀有比例高，适合作战型钓点"},
		"rare":     {"name": "稀有秘境", "desc": "稀有鱼权重最高，适合追图鉴/收藏"},
		"material": {"name": "材料工坊", "desc": "材料掉落为主，适合刷组件强化材料"},
	}
}

func worldPresetPool(c *rules.Catalog, preset string) []rules.LootEntry {
	tiers := map[string][]rules.Item{"common": {}, "big": {}, "rare": {}}
	for _, it := range c.Items {
		if it.Kind == "fish" {
			tier := c.FishTier(it.ID)
			if tier != "" {
				tiers[tier] = append(tiers[tier], it)
			}
		}
	}
	for _, list := range tiers {
		sort.SliceStable(list, func(i, j int) bool { return list[i].Price < list[j].Price })
	}
	mats := []rules.Item{}
	for _, it := range c.Items {
		if it.Kind == "material" {
			mats = append(mats, it)
		}
	}
	sort.SliceStable(mats, func(i, j int) bool { return mats[i].Price < mats[j].Price })
	out := []rules.LootEntry{}
	addFish := func(tier string, n int, weight float64) {
		for _, it := range tiers[tier][:minWorld(n, len(tiers[tier]))] {
			out = append(out, rules.LootEntry{Pick: "fish:" + it.ID, Weight: weight})
		}
	}
	addMat := func(n int, weight float64) {
		for _, it := range mats[:minWorld(n, len(mats))] {
			out = append(out, rules.LootEntry{Pick: "material:" + it.ID, Weight: weight})
		}
	}
	switch preset {
	case "big":
		addFish("common", 4, 6)
		addFish("big", 5, 8)
		addFish("rare", 2, 3)
		addMat(2, 5)
	case "rare":
		addFish("common", 3, 5)
		addFish("big", 3, 5)
		addFish("rare", 4, 6)
		addMat(2, 4)
	case "material":
		addFish("common", 4, 6)
		addFish("big", 2, 3)
		addMat(4, 12)
	default:
		addFish("common", 8, 10)
		addFish("big", 2, 3)
		addMat(2, 6)
	}
	out = append(out, rules.LootEntry{Pick: "component:", Weight: 1})
	return out
}

func minWorld(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func worldGroups(c *rules.Catalog) []worldGroup {
	groups := []worldGroup{}
	var raw map[string]json.RawMessage
	b, _ := json.Marshal(c.Runtime["lootGroups"])
	if json.Unmarshal(b, &raw) != nil {
		return groups
	}
	for id, value := range raw {
		var items []rules.LootEntry
		if json.Unmarshal(value, &items) == nil {
			groups = append(groups, worldGroup{ID: id, Weight: 1, Items: items})
			continue
		}
		var g worldGroup
		if json.Unmarshal(value, &g) == nil {
			g.ID = id
			groups = append(groups, g)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })
	return groups
}

func worldSetGroups(c *rules.Catalog, groups []worldGroup) {
	if c.Runtime == nil {
		c.Runtime = map[string]any{}
	}
	raw := map[string]any{}
	for _, g := range groups {
		raw[g.ID] = map[string]any{"id": g.ID, "name": g.Name, "weight": g.Weight, "items": g.Items}
	}
	c.Runtime["lootGroups"] = raw
}

func worldValidateGroup(c *rules.Catalog, value any) (worldGroup, string) {
	m, ok := value.(map[string]any)
	if !ok {
		return worldGroup{}, "invalid group"
	}
	id, _ := m["id"].(string)
	id = strings.TrimSpace(id)
	name, _ := m["name"].(string)
	name = strings.TrimSpace(name)
	weight, good := worldNumber(m["weight"])
	if !worldGroundID.MatchString(id) || len([]rune(name)) == 0 || len([]rune(name)) > 20 || !good || weight < 0 || weight > 1000000 {
		return worldGroup{}, "invalid group"
	}
	items, ok := m["items"].([]any)
	if !ok || len(items) == 0 || len(items) > worldMaxLootItem {
		return worldGroup{}, "invalid group items"
	}
	out := worldGroup{ID: id, Name: name, Weight: weight}
	positive := false
	for _, value := range items {
		im, good := value.(map[string]any)
		if !good {
			return worldGroup{}, "invalid group item"
		}
		pick, _ := im["pick"].(string)
		if strings.HasPrefix(pick, "group:") {
			return worldGroup{}, "nested loot groups are not allowed"
		}
		w, good := worldNumber(im["weight"])
		if !good || !worldEntry(c, pick, w) || strings.HasPrefix(pick, "group:") {
			return worldGroup{}, "invalid group item"
		}
		if w > 0 {
			positive = true
		}
		out.Items = append(out.Items, rules.LootEntry{Pick: pick, Weight: w})
	}
	if !positive {
		return worldGroup{}, "group must contain a positive entry"
	}
	return out, ""
}

func worldSpotRules(c *rules.Catalog, raw map[string]any) (rules.Spot, []rules.LootEntry, bool) {
	spot := rules.Spot{IntervalMS: raw["intervalMs"], BiteRate: raw["biteRate"]}
	if buffs, ok := raw["buffs"]; ok {
		b, _ := json.Marshal(buffs)
		_ = json.Unmarshal(b, &spot.Buffs)
	}
	pool, ok := worldPool(raw["pool"])
	return spot, pool, ok
}

func worldRound(v float64, places int) float64 {
	p := math.Pow10(places)
	return math.Round(v*p) / p
}

func worldCurrentComponent(c *rules.Catalog) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(c.Defaults["component"], &out)
	return out
}

func worldCurrentFish(c *rules.Catalog) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(c.Defaults["fish"], &out)
	if out == nil {
		out = map[string]any{}
	}
	if _, ok := out["sizeWeights"]; !ok {
		out["sizeWeights"] = []any{10, 10, 10, 10, 10, 10, 10, 10, 10, 10}
	}
	return out
}

func worldDefaults(name string) map[string]any {
	c, err := rules.Default()
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	_ = json.Unmarshal(c.Defaults[name], &out)
	return out
}

func setWorldDefault(c *rules.Catalog, name string, value any) error {
	b, err := json.Marshal(value)
	if err == nil {
		c.Defaults[name] = b
	}
	return err
}

func worldComponentSim(c *rules.Catalog, n int) map[string]any {
	if n < 1 {
		n = 1
	}
	if n > 200000 {
		n = 200000
	}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	cfg := c.ComponentConfig()
	quality := map[string]int{"common": 0, "rare": 0, "epic": 0}
	count := map[string]map[string]int{}
	for _, q := range []string{"common", "rare", "epic"} {
		count[q] = map[string]int{"1": 0, "2": 0, "3": 0}
	}
	vals := map[string]struct {
		sum      float64
		n        int
		min, max float64
	}{}
	rulesHit := map[string]map[string]any{}
	full, extra, zero := 0, 0, 0
	for i := 0; i < n; i++ {
		sig, ok := c.RollComponent("", cfg, func() float64 { return rng.Float64() })
		if !ok {
			continue
		}
		base, q, aa, ok := c.Instance(sig)
		if !ok {
			continue
		}
		quality[q]++
		if _, exists := count[q]; !exists {
			count[q] = map[string]int{}
		}
		count[q][strconv.Itoa(len(aa))]++
		cap := len(base.Pool)
		if q == "rare" && cap > 2 {
			cap = 2
		}
		if q == "epic" && cap > 3 {
			cap = 3
		}
		if q == "common" && cap > 1 {
			cap = 1
		}
		if len(aa) == cap {
			full++
		}
		poolTypes := map[string]bool{}
		for _, p := range base.Pool {
			poolTypes[p.Type] = true
		}
		net := 0.0
		noNeg := true
		for _, a := range aa {
			if a.Value == 0 {
				zero++
			}
			net += a.Value
			if a.Value < 0 {
				noNeg = false
			}
			v := vals[a.Type]
			if v.n == 0 {
				v.min, v.max = a.Value, a.Value
			}
			v.sum += a.Value
			v.n++
			if a.Value < v.min {
				v.min = a.Value
			}
			if a.Value > v.max {
				v.max = a.Value
			}
			vals[a.Type] = v
			if !poolTypes[a.Type] {
				extra++
			}
		}
		matchedRule := false
		for _, rule := range componentRules(c) {
			if !worldRuleMatch(rule, len(aa), net, noNeg, len(aa) == cap) {
				continue
			}
			matchedRule = true
			name, _ := rule["name"].(string)
			hit := rulesHit[name]
			if hit == nil {
				hit = map[string]any{"count": 0, "samples": []string{}}
				rulesHit[name] = hit
			}
			hit["count"] = hit["count"].(int) + 1
			samples := hit["samples"].([]string)
			if len(samples) < 2 {
				hit["samples"] = append(samples, base.Name+" · "+strconv.Itoa(len(aa))+"/"+strconv.Itoa(cap)+" 词条")
			}
			break
		}
		if !matchedRule {
			name := "（无修饰词）"
			hit := rulesHit[name]
			if hit == nil {
				hit = map[string]any{"count": 0, "samples": []string{}}
				rulesHit[name] = hit
			}
			hit["count"] = hit["count"].(int) + 1
			samples := hit["samples"].([]string)
			if len(samples) < 2 {
				hit["samples"] = append(samples, base.Name+" · "+strconv.Itoa(len(aa))+"/"+strconv.Itoa(cap)+" 词条")
			}
		}
	}
	affix := map[string]any{}
	for typ, v := range vals {
		if v.n > 0 {
			affix[typ] = map[string]any{"mean": worldRound(v.sum/float64(v.n), 1), "min": v.min, "max": v.max}
		}
	}
	return map[string]any{"ok": true, "n": n, "quality": quality, "count": count, "affix": affix, "zeroAffixes": zero, "rules": rulesHit, "fullCount": full, "extraCount": extra}
}

func componentRules(c *rules.Catalog) []map[string]any {
	var out []map[string]any
	var cfg map[string]any
	_ = json.Unmarshal(c.Defaults["component"], &cfg)
	_ = json.Unmarshal(mustJSON(cfg["adjectiveRules"]), &out)
	return out
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func worldRuleMatch(r map[string]any, count int, net float64, noNeg, full bool) bool {
	if v, ok := r["full"].(bool); ok && v != full {
		return false
	}
	if v, ok := r["noNeg"].(bool); ok && v && !noNeg {
		return false
	}
	if v, ok := worldNumber(r["netMin"]); ok && net < v {
		return false
	}
	if v, ok := worldNumber(r["netMax"]); ok && net > v {
		return false
	}
	if v, ok := worldNumber(r["minAffixes"]); ok && float64(count) < v {
		return false
	}
	if v, ok := worldNumber(r["maxAffixes"]); ok && float64(count) > v {
		return false
	}
	return strings.TrimSpace(asString(r["name"])) != ""
}
func asString(v any) string { s, _ := v.(string); return s }

func validSizeWeights(v any) ([]float64, bool) {
	arr, ok := v.([]any)
	if !ok || len(arr) != 10 {
		return nil, false
	}
	out := make([]float64, 10)
	sum := 0.0
	for i, x := range arr {
		n, good := worldNumber(x)
		if !good || n < 0 || n > 100 {
			return nil, false
		}
		out[i] = n
		sum += n
	}
	return out, sum > 0
}

func worldFishSim(c *rules.Catalog, body worldBody, n int) (map[string]any, string) {
	if n < 1 {
		n = 1
	}
	if n > 200000 {
		n = 200000
	}
	cfg := worldCurrentFish(c)
	current := asString(cfg["sizeModel"])
	if current == "" {
		current = "normal"
	}
	model := current
	if s, ok := worldString(body, "model"); ok {
		model = s
	}
	if !worldRolls[model] {
		return nil, "unknown size model"
	}
	weights := []float64{10, 10, 10, 10, 10, 10, 10, 10, 10, 10}
	if configured, good := validSizeWeights(cfg["sizeWeights"]); good {
		weights = configured
	}
	if raw, ok := worldRaw(body, "sizeWeights"); ok {
		var arr []any
		b, _ := json.Marshal(raw)
		_ = json.Unmarshal(b, &arr)
		w, good := validSizeWeights(arr)
		if !good {
			return nil, "invalid size weights"
		}
		weights = w
	}
	bonus := 0.0
	if v, ok := worldFloat(body, "sizeBonus"); ok {
		bonus = v
	}
	fish := []rules.Item{}
	for _, it := range c.Items {
		if it.Kind == "fish" && len(it.Size) == 2 {
			fish = append(fish, it)
		}
	}
	if len(fish) == 0 {
		return nil, "no fish with size range"
	}
	var target *rules.Item
	if id, ok := worldString(body, "fishId"); ok && id != "" {
		for i := range fish {
			if fish[i].ID == id {
				target = &fish[i]
				break
			}
		}
		if target == nil {
			return nil, "unknown fish: " + id
		}
	}
	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	buckets := make([]int, 20)
	samples := []float64{}
	use := fish
	if target != nil {
		use = []rules.Item{*target}
		samples = make([]float64, 0, n)
	}
	for i := 0; i < n; i++ {
		f := use[i%len(use)]
		size := rules.FishSize(f.Size, bonus, model, weights, func() float64 { return rng.Float64() })
		base := size
		if d := 1 + bonus/100; d != 0 {
			base = size / d
		}
		pos := 0.0
		if f.Size[1] > f.Size[0] {
			pos = (base - f.Size[0]) / (f.Size[1] - f.Size[0])
		}
		b := int(math.Floor(pos * 20))
		if b < 0 {
			b = 0
		}
		if b > 19 {
			b = 19
		}
		buckets[b]++
		if target != nil {
			samples = append(samples, size)
		}
	}
	out := map[string]any{"ok": true, "n": n, "model": model, "currentModel": current, "sizeBonus": bonus, "bucketCount": 20, "buckets": buckets}
	if target != nil {
		sort.Float64s(samples)
		at := func(q float64) float64 {
			return samples[minWorld(len(samples)-1, int(math.Floor(q*float64(len(samples)))))]
		}
		sum := 0.0
		for _, x := range samples {
			sum += x
		}
		out["fishId"] = target.ID
		out["fishName"] = target.Name
		out["range"] = target.Size
		out["stats"] = map[string]any{"min": samples[0], "p25": at(.25), "p50": at(.5), "p75": at(.75), "max": samples[len(samples)-1], "mean": worldRound(sum/float64(len(samples)), 1)}
	}
	return out, ""
}

func worldFlatten(pool []rules.LootEntry, groupNames map[string]string) []struct {
	entry            rules.LootEntry
	group, groupName string
} {
	out := []struct {
		entry            rules.LootEntry
		group, groupName string
	}{}
	var walk func([]rules.LootEntry, string, string, float64)
	walk = func(items []rules.LootEntry, group, groupName string, scale float64) {
		for _, e := range items {
			if e.Items == nil {
				out = append(out, struct {
					entry            rules.LootEntry
					group, groupName string
				}{rules.LootEntry{Pick: e.Pick, Weight: e.Weight * scale}, group, groupName})
				continue
			}
			id := strings.TrimPrefix(e.Pick, "group:")
			name := groupNames[id]
			total := 0.0
			for _, child := range e.Items {
				if child.Weight > 0 && finiteWorld(child.Weight) {
					total += child.Weight
				}
			}
			if total > 0 {
				walk(e.Items, id, name, scale*e.Weight/total)
			}
		}
	}
	walk(pool, "", "", 1)
	return out
}

func worldQuality(c *rules.Catalog, id, kind string) (string, string, bool) {
	it, ok := c.Item(id)
	if !ok {
		return id, "普通", false
	}
	labels := map[string]struct {
		Name string `json:"name"`
	}{}
	_ = c.Constant("QUALITY", &labels)
	if q := labels[it.Rarity].Name; q != "" {
		return it.Name, q, true
	}
	return it.Name, it.Rarity, true
}

func worldCommon(c *rules.Catalog, pick string) bool {
	kind, id, ok := strings.Cut(pick, ":")
	if !ok || kind == "component" {
		return false
	}
	if kind == "fish" {
		return c.FishTier(id) == "common"
	}
	it, good := c.Item(id)
	return good && it.Rarity == "common"
}

func worldLootRows(c *rules.Catalog, spot map[string]any, rare, material float64, withWeight bool) ([]map[string]any, float64, float64, error) {
	_, pool, ok := worldSpotRules(c, spot)
	if !ok {
		return nil, 0, 0, identity.ErrInvalid
	}
	groups := c.LootGroups()
	before, err := c.BoostPool(pool, groups, rules.EmptyEffects(), c.DefaultLootConfig())
	if err != nil {
		return nil, 0, 0, err
	}
	eff := rules.EmptyEffects()
	eff["rare"] = rare
	eff["material"] = material
	after, err := c.BoostPool(pool, groups, eff, c.DefaultLootConfig())
	if err != nil {
		return nil, 0, 0, err
	}
	groupNames := map[string]string{}
	for _, g := range worldGroups(c) {
		groupNames[g.ID] = g.Name
	}
	b := worldFlatten(before, groupNames)
	a := worldFlatten(after, groupNames)
	if len(b) != len(a) {
		return nil, 0, 0, identity.ErrInvalid
	}
	beforeTotal, afterTotal := 0.0, 0.0
	for _, x := range b {
		beforeTotal += x.entry.Weight
	}
	for _, x := range a {
		afterTotal += x.entry.Weight
	}
	if beforeTotal <= 0 {
		beforeTotal = 1
	}
	if afterTotal <= 0 {
		afterTotal = 1
	}
	rows := []map[string]any{}
	commonBefore, commonAfter := 0.0, 0.0
	for i, x := range b {
		kind, id, _ := strings.Cut(x.entry.Pick, ":")
		name, quality, _ := worldQuality(c, id, kind)
		if kind == "component" {
			name, quality = "组件", "随机"
		}
		row := map[string]any{"pick": x.entry.Pick, "type": kind, "id": id, "name": name, "quality": quality, "group": x.groupName, "beforePct": x.entry.Weight / beforeTotal * 100, "afterPct": a[i].entry.Weight / afterTotal * 100}
		if withWeight {
			row["common"] = a[i].entry.Weight < x.entry.Weight
			row["weight"] = worldRound(x.entry.Weight, 3)
		}
		if x.groupName != "" {
			row["group"] = x.groupName
		}
		if worldCommon(c, x.entry.Pick) {
			commonBefore += x.entry.Weight / beforeTotal * 100
			commonAfter += a[i].entry.Weight / afterTotal * 100
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if withWeight {
			return rows[i]["beforePct"].(float64) > rows[j]["beforePct"].(float64)
		}
		return rows[i]["afterPct"].(float64) > rows[j]["afterPct"].(float64)
	})
	return rows, commonBefore, commonAfter, nil
}

func worldView(c *rules.Catalog, grounds []map[string]any) map[string]any {
	fish, materials, components, chests := []map[string]any{}, []map[string]any{}, []map[string]any{}, []map[string]any{}
	for _, it := range c.Items {
		row := map[string]any{"id": it.ID, "name": it.Name, "rarity": it.Rarity, "price": it.Price, "size": it.Size, "part": it.Part}
		switch it.Kind {
		case "fish":
			fish = append(fish, row)
		case "material":
			materials = append(materials, row)
		case "component":
			// The admin editor needs the authoritative base ranges, including
			// an empty array (rather than null) for components without affixes.
			row["pool"] = append([]rules.AffixRange{}, it.Pool...)
			components = append(components, row)
		case "chest":
			chests = append(chests, row)
		}
	}
	rareK := c.DefaultLootConfig().RareK
	doubleBase, _ := worldNumber(c.Runtime["doubleBase"])
	cast := c.CastRules(nil)
	return map[string]any{"ok": true, "grounds": grounds, "catalog": map[string]any{"fish": fish, "materials": materials, "components": components, "chests": chests}, "affixTypes": legacyAffixLabels(c), "componentCfg": worldCurrentComponent(c), "componentDefaults": worldDefaults("component"), "fishCfg": worldCurrentFish(c), "fishDefaults": worldDefaults("fish"), "lootGroups": worldGroups(c), "poolPresets": worldPoolPresets(c), "rareK": rareK, "doubleBase": doubleBase, "castBaseMs": cast.BaseMS, "castMinMs": cast.MinMS, "castSpeedBonus": cast.SpeedBonus, "castSpeedCap": cast.SpeedCap, "castFormula": cast.Formula, "biteFormula": cast.BiteFormula}
}

func (a *API) adminComponentConfig(w http.ResponseWriter, r *http.Request) {
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
	cfg := worldCurrentComponent(c)
	next := map[string]any{}
	for k, v := range cfg {
		next[k] = v
	}
	if raw, exists := body["qualityWeights"]; exists {
		var in map[string]any
		if !worldJSON(raw, &in) {
			failure(w, identity.ErrInvalid)
			return
		}
		out := map[string]any{}
		for _, k := range []string{"common", "rare", "epic"} {
			if n, good := worldNumber(in[k]); good && n >= 0 {
				out[k] = n
			}
		}
		if len(out) == 0 {
			failure(w, identity.ErrInvalid)
			return
		}
		next["qualityWeights"] = out
	}
	if raw, exists := body["countWeights"]; exists {
		var in map[string]any
		if !worldJSON(raw, &in) {
			failure(w, identity.ErrInvalid)
			return
		}
		out := map[string]any{}
		for _, q := range []string{"common", "rare", "epic"} {
			if arr, good := in[q].([]any); good {
				vals := []any{}
				for _, x := range arr[:minWorld(3, len(arr))] {
					n, ok := worldNumber(x)
					if !ok || n < 0 {
						continue
					}
					vals = append(vals, n)
				}
				if len(vals) > 0 {
					out[q] = vals
				}
			}
		}
		next["countWeights"] = out
	}
	if raw, exists := body["rollModel"]; exists {
		var model string
		if !worldJSON(raw, &model) || !map[string]bool{"linear": true, "normal": true, "skew": true}[model] {
			failure(w, identity.ErrInvalid)
			return
		}
		next["rollModel"] = model
	}
	if raw, exists := body["affixRanges"]; exists {
		var in map[string]any
		if !worldJSON(raw, &in) {
			failure(w, identity.ErrInvalid)
			return
		}
		out := map[string]any{}
		for id, value := range in {
			base, good := c.Item(id)
			if !good || base.Kind != "component" {
				continue
			}
			types, good := value.(map[string]any)
			if !good {
				continue
			}
			clean := map[string]any{}
			allowed := map[string]bool{}
			for _, p := range base.Pool {
				allowed[p.Type] = true
			}
			for typ, rv := range types {
				arr, good := rv.([]any)
				if !good || len(arr) != 2 || !allowed[typ] {
					continue
				}
				lo, ok1 := worldNumber(arr[0])
				hi, ok2 := worldNumber(arr[1])
				if ok1 && ok2 && hi >= lo {
					clean[typ] = []float64{math.Round(lo), math.Round(hi)}
				}
			}
			if len(clean) > 0 {
				out[id] = clean
			}
		}
		next["affixRanges"] = out
	}
	if raw, exists := body["extraAffixRanges"]; exists {
		var in map[string]any
		if !worldJSON(raw, &in) {
			failure(w, identity.ErrInvalid)
			return
		}
		types := map[string]bool{}
		var names []string
		_ = json.Unmarshal(c.Constants["AFFIX_TYPES"], &names)
		for _, t := range names {
			types[t] = true
		}
		out := map[string]any{}
		for typ, rv := range in {
			if !types[typ] {
				continue
			}
			arr, good := rv.([]any)
			if !good || len(arr) != 2 {
				continue
			}
			lo, ok1 := worldNumber(arr[0])
			hi, ok2 := worldNumber(arr[1])
			if ok1 && ok2 && hi >= lo {
				out[typ] = []float64{math.Round(lo), math.Round(hi)}
			}
		}
		next["extraAffixRanges"] = out
	}
	if raw, exists := body["adjectiveRules"]; exists {
		var rulesIn []map[string]any
		if !worldJSON(raw, &rulesIn) {
			failure(w, identity.ErrInvalid)
			return
		}
		out := []map[string]any{}
		for _, item := range rulesIn[:minWorld(20, len(rulesIn))] {
			name := strings.TrimSpace(asString(item["name"]))
			if name == "" {
				failure(w, identity.ErrInvalid)
				return
			}
			row := map[string]any{"name": string([]rune(name)[:minWorld(12, len([]rune(name)))])}
			for _, k := range []string{"full", "noNeg"} {
				if b, ok := item[k].(bool); ok {
					row[k] = b
				}
			}
			for _, k := range []string{"netMin", "netMax", "minAffixes", "maxAffixes"} {
				if n, ok := worldNumber(item[k]); ok {
					row[k] = n
				}
			}
			out = append(out, row)
		}
		next["adjectiveRules"] = out
	}
	if err := setWorldDefault(c, "component", next); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	nextC, good := worldPublish(a, w, r, session, body, "/api/admin/component/config", "component", c, rev)
	if !good {
		return
	}
	write(w, 200, map[string]any{"ok": true, "componentCfg": worldCurrentComponent(nextC)})
}

func (a *API) adminComponentReset(w http.ResponseWriter, r *http.Request) {
	a.adminComponentResetOrFish(w, r, true)
}
func (a *API) adminFishReset(w http.ResponseWriter, r *http.Request) {
	a.adminComponentResetOrFish(w, r, false)
}
func (a *API) adminComponentResetOrFish(w http.ResponseWriter, r *http.Request, component bool) {
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
	name, route := "fish", "/api/admin/fish/reset"
	if component {
		name, route = "component", "/api/admin/component/reset"
	}
	d := worldDefaults(name)
	if err := setWorldDefault(c, name, d); err != nil {
		failure(w, err)
		return
	}
	next, good := worldPublish(a, w, r, session, body, route, name, c, rev)
	if !good {
		return
	}
	if component {
		write(w, 200, map[string]any{"ok": true, "componentCfg": worldCurrentComponent(next)})
	} else {
		write(w, 200, map[string]any{"ok": true, "fishCfg": worldCurrentFish(next)})
	}
}

func (a *API) adminComponentSimulate(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	_ = session
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	n := 20000
	if v, good := worldFloat(body, "n"); good {
		n = int(v)
	}
	write(w, 200, worldComponentSim(c, n))
}
func (a *API) adminFishConfig(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	model, exists := worldString(body, "sizeModel")
	if !exists || !worldRolls[model] {
		failure(w, identity.ErrInvalid)
		return
	}
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	cfg := worldCurrentFish(c)
	cfg["sizeModel"] = model
	if raw, exists := body["sizeWeights"]; exists {
		var arr []any
		_ = json.Unmarshal(raw, &arr)
		weights, good := validSizeWeights(arr)
		if !good {
			failure(w, identity.ErrInvalid)
			return
		}
		cfg["sizeWeights"] = weights
	}
	if err := setWorldDefault(c, "fish", cfg); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/fish/config", "fish", c, rev)
	if !good {
		return
	}
	write(w, 200, map[string]any{"ok": true, "fishCfg": worldCurrentFish(next)})
}
func (a *API) adminFishSimulate(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	_ = session
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	out, msg := worldFishSim(c, body, intOrDefault(body, "n", 20000))
	if out == nil {
		write(w, 400, map[string]any{"error": msg})
		return
	}
	write(w, 200, out)
}
func intOrDefault(body worldBody, key string, def int) int {
	if n, ok := worldFloat(body, key); ok {
		if n == 0 {
			return def
		}
		if n < 0 {
			return 1
		}
		return int(n)
	}
	return def
}

func worldFind(c *rules.Catalog, groundID, spotID string) ([]map[string]any, map[string]any, map[string]any, error) {
	grounds, err := worldGrounds(c)
	if err != nil {
		return nil, nil, nil, err
	}
	g, _ := worldGround(grounds, groundID)
	if g == nil {
		return grounds, nil, nil, nil
	}
	s, _ := worldSpot(g, spotID)
	return grounds, g, s, nil
}

func worldTime(v any) (int64, bool, bool) {
	if v == nil {
		return 0, false, true
	}
	if s, ok := v.(string); ok {
		s = strings.TrimSpace(s)
		if s == "" {
			return 0, false, true
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, s); err == nil {
				return t.UnixMilli(), true, true
			}
		}
		return 0, false, false
	}
	n, ok := worldNumber(v)
	if !ok {
		return 0, false, false
	}
	return int64(math.Round(n)), true, true
}

func worldWindow(body worldBody, fromKey, toKey string) (*int64, *int64, string) {
	fromRaw, fromSet := worldRaw(body, fromKey)
	toRaw, toSet := worldRaw(body, toKey)
	if !fromSet && !toSet {
		return nil, nil, ""
	}
	var from, to *int64
	if fromSet {
		n, set, good := worldTime(fromRaw)
		if !good {
			return nil, nil, "invalid time"
		}
		if set {
			from = &n
		}
	}
	if toSet {
		n, set, good := worldTime(toRaw)
		if !good {
			return nil, nil, "invalid time"
		}
		if set {
			to = &n
		}
	}
	if from != nil && to != nil && *from >= *to {
		return nil, nil, "start time must be before end time"
	}
	return from, to, ""
}

func worldWindowLocked(g map[string]any, now time.Time) bool {
	from, fromSet, _ := worldTime(g["openFrom"])
	to, toSet, _ := worldTime(g["openTo"])
	ms := now.UnixMilli()
	return (fromSet && ms < from) || (toSet && ms >= to)
}

func worldPos(v any) ([]float64, bool, bool) {
	if v == nil {
		return nil, true, true
	}
	arr, ok := v.([]any)
	if !ok || len(arr) != 2 {
		return nil, false, false
	}
	out := make([]float64, 2)
	for i := range arr {
		n, good := worldNumber(arr[i])
		if !good {
			return nil, false, false
		}
		out[i] = worldRound(math.Max(2, math.Min(98, n)), 1)
	}
	return out, true, true
}

func (a *API) adminSpotPool(w http.ResponseWriter, r *http.Request) {
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
	groundID, gOK := worldString(body, "groundId")
	spotID, sOK := worldString(body, "spotId")
	if !gOK || !sOK {
		failure(w, identity.ErrInvalid)
		return
	}
	grounds, g, _, err := worldFind(c, groundID, spotID)
	if err != nil {
		failure(w, err)
		return
	}
	if g == nil {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	spots := worldSpots(g)
	_, spotIndex := worldSpot(g, spotID)
	if spotIndex < 0 {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	s := spots[spotIndex]
	_, exists := body["pool"]
	if !exists {
		failure(w, identity.ErrInvalid)
		return
	}
	value, _ := worldRaw(body, "pool")
	pool, msg := worldValidatePool(c, value)
	if msg != "" {
		failure(w, identity.ErrInvalid)
		return
	}
	s["pool"] = pool
	setWorldSpots(g, spots)
	if err := setWorldGrounds(c, grounds); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/pool", groundID+":"+spotID, c, rev)
	if !good {
		return
	}
	_, _, ns, _ := worldFind(next, groundID, spotID)
	write(w, 200, map[string]any{"ok": true, "pool": ns["pool"]})
}

func (a *API) adminSpotBuffs(w http.ResponseWriter, r *http.Request) {
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
	groundID, _ := worldString(body, "groundId")
	spotID, _ := worldString(body, "spotId")
	grounds, g, _, _ := worldFind(c, groundID, spotID)
	if g == nil {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	spots := worldSpots(g)
	_, spotIndex := worldSpot(g, spotID)
	if spotIndex < 0 {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	s := spots[spotIndex]
	value, exists := worldRaw(body, "buffs")
	if !exists {
		failure(w, identity.ErrInvalid)
		return
	}
	buffs, msg := worldValidateBuffs(c, value)
	if msg != "" {
		failure(w, identity.ErrInvalid)
		return
	}
	s["buffs"] = buffs
	setWorldSpots(g, spots)
	if err := setWorldGrounds(c, grounds); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/buffs", groundID+":"+spotID, c, rev)
	if !good {
		return
	}
	_, _, ns, _ := worldFind(next, groundID, spotID)
	write(w, 200, map[string]any{"ok": true, "buffs": ns["buffs"]})
}

func (a *API) adminLootGroups(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "groups": worldGroups(c)})
}

func (a *API) adminLootSpots(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	grounds, err := worldGrounds(c)
	if err != nil {
		failure(w, err)
		return
	}
	spots := []map[string]any{}
	for _, g := range grounds {
		for _, s := range worldSpots(g) {
			pool, _ := worldPool(s["pool"])
			spots = append(spots, map[string]any{
				"key":  asString(g["id"]) + ":" + asString(s["id"]),
				"name": asString(g["name"]) + "·" + asString(s["name"]),
				"pool": len(pool),
			})
		}
	}
	write(w, 200, map[string]any{"ok": true, "spots": spots, "k": c.DefaultLootConfig().RareK})
}

func (a *API) adminLootGroup(w http.ResponseWriter, r *http.Request) {
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
	groups := worldGroups(c)
	if action, _ := worldString(body, "action"); action == "delete" {
		id, _ := worldString(body, "id")
		idx := -1
		for i, g := range groups {
			if g.ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			write(w, 404, map[string]any{"error": "loot_group_not_found"})
			return
		}
		grounds, _ := worldGrounds(c)
		for _, g := range grounds {
			for _, s := range worldSpots(g) {
				pool, _ := worldPool(s["pool"])
				has := false
				other := false
				for _, e := range pool {
					if e.Pick == "group:"+id && e.Weight > 0 {
						has = true
					}
					if e.Pick != "group:"+id && e.Weight > 0 {
						other = true
					}
				}
				if has && !other {
					failure(w, identity.ErrInvalid)
					return
				}
			}
		}
		groups = append(groups[:idx], groups[idx+1:]...)
		for _, g := range grounds {
			spots := worldSpots(g)
			for _, s := range spots {
				pool, _ := worldPool(s["pool"])
				keep := []rules.LootEntry{}
				for _, e := range pool {
					if e.Pick != "group:"+id {
						keep = append(keep, e)
					}
				}
				s["pool"] = keep
			}
			setWorldSpots(g, spots)
		}
		_ = setWorldGrounds(c, grounds)
		worldSetGroups(c, groups)
	} else {
		value, exists := worldRaw(body, "group")
		if !exists {
			failure(w, identity.ErrInvalid)
			return
		}
		group, msg := worldValidateGroup(c, value)
		if msg != "" {
			failure(w, identity.ErrInvalid)
			return
		}
		idx := -1
		for i, g := range groups {
			if g.ID == group.ID {
				idx = i
			}
			if g.Name == group.Name && g.ID != group.ID {
				failure(w, identity.ErrInvalid)
				return
			}
		}
		if idx >= 0 {
			groups[idx] = group
		} else {
			groups = append(groups, group)
		}
		worldSetGroups(c, groups)
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/loot/group", "", c, rev)
	if !good {
		return
	}
	write(w, 200, map[string]any{"ok": true, "groups": worldGroups(next)})
}

func (a *API) adminPoolPreset(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	_ = session
	c, _, err := worldCurrent(r.Context(), a)
	if err != nil {
		failure(w, err)
		return
	}
	preset, exists := worldString(body, "preset")
	if !exists || preset == "" {
		preset = "economy"
	}
	presets := worldPoolPresets(c)
	if _, ok := presets[preset]; !ok {
		failure(w, identity.ErrInvalid)
		return
	}
	write(w, 200, map[string]any{"ok": true, "preset": preset, "pool": worldPresetPool(c, preset), "presets": presets})
}

func (a *API) adminGroundAdd(w http.ResponseWriter, r *http.Request) {
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
	grounds, err := worldGrounds(c)
	if err != nil {
		failure(w, err)
		return
	}
	id, _ := worldString(body, "id")
	id = strings.ToLower(strings.TrimSpace(id))
	if !worldGroundID.MatchString(id) {
		failure(w, identity.ErrInvalid)
		return
	}
	if _, ok := worldDefaultGround(id); ok {
		failure(w, identity.ErrInvalid)
		return
	}
	if _, idx := worldGround(grounds, id); idx >= 0 {
		write(w, 409, map[string]any{"error": "ground_exists"})
		return
	}
	name, _ := worldString(body, "name")
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 20 {
		failure(w, identity.ErrInvalid)
		return
	}
	from, to, msg := worldWindow(body, "openFrom", "openTo")
	if msg != "" {
		failure(w, identity.ErrInvalid)
		return
	}
	preset, _ := worldString(body, "preset")
	if _, good := worldPoolPresets(c)[preset]; !good {
		preset = "economy"
	}
	fill := true
	if v, exists := worldBool(body, "fill"); exists {
		fill = v
	}
	spotID, _ := worldString(body, "spotId")
	if spotID == "" {
		spotID = "main"
	}
	spotID = strings.ToLower(strings.TrimSpace(spotID))
	if !worldSpotID.MatchString(spotID) {
		failure(w, identity.ErrInvalid)
		return
	}
	spotName, _ := worldString(body, "spotName")
	if strings.TrimSpace(spotName) == "" {
		spotName = "主钓点"
	}
	if len([]rune(spotName)) > 20 {
		spotName = string([]rune(spotName)[:20])
	}
	desc, _ := worldString(body, "desc")
	if len([]rune(desc)) > 80 {
		desc = string([]rune(desc)[:80])
	}
	spot := map[string]any{"id": spotID, "name": spotName, "pool": []rules.LootEntry{}, "buffs": []rules.Buff{}}
	if fill {
		spot["pool"] = worldPresetPool(c, preset)
	}
	ground := map[string]any{"id": id, "name": name, "type": "normal", "desc": desc, "locked": false, "manualLocked": false, "spots": []map[string]any{spot}}
	if typ, _ := worldString(body, "type"); typ == "event" {
		ground["type"] = "event"
	}
	if from != nil {
		ground["openFrom"] = *from
	}
	if to != nil {
		ground["openTo"] = *to
	}
	if worldWindowLocked(ground, time.Now()) {
		ground["locked"] = true
	}
	grounds = append(grounds, ground)
	if err := setWorldGrounds(c, grounds); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/ground/add", id, c, rev)
	if !good {
		return
	}
	ng, _ := worldGroundMust(next, id)
	write(w, 200, map[string]any{"ok": true, "ground": ng, "preset": preset, "filled": fill})
}

func worldGroundMust(c *rules.Catalog, id string) (map[string]any, bool) {
	g, _ := worldGround(mustGrounds(c), id)
	return g, g != nil
}
func mustGrounds(c *rules.Catalog) []map[string]any { g, _ := worldGrounds(c); return g }

func (a *API) adminSpotAdd(w http.ResponseWriter, r *http.Request) {
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
	groundID, _ := worldString(body, "groundId")
	grounds, g, _, _ := worldFind(c, groundID, "")
	if g == nil {
		write(w, 404, map[string]any{"error": "ground_not_found"})
		return
	}
	id, _ := worldString(body, "id")
	id = strings.ToLower(strings.TrimSpace(id))
	if !worldSpotID.MatchString(id) {
		failure(w, identity.ErrInvalid)
		return
	}
	if _, idx := worldSpot(g, id); idx >= 0 {
		write(w, 409, map[string]any{"error": "spot_exists"})
		return
	}
	if _, ok := worldDefaultSpot(groundID, id); ok {
		write(w, 409, map[string]any{"error": "spot_exists"})
		return
	}
	name, _ := worldString(body, "name")
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 20 {
		failure(w, identity.ErrInvalid)
		return
	}
	preset, _ := worldString(body, "preset")
	if _, good := worldPoolPresets(c)[preset]; !good {
		preset = "economy"
	}
	fill := true
	if v, exists := worldBool(body, "fill"); exists {
		fill = v
	}
	spot := map[string]any{"id": id, "name": name, "pool": []rules.LootEntry{}, "buffs": []rules.Buff{}}
	if fill {
		spot["pool"] = worldPresetPool(c, preset)
	}
	if m, _ := worldString(body, "map"); m == "voyage" {
		spot["map"] = m
	}
	if n, good := worldFloat(body, "minShip"); good && n > 0 {
		spot["minShip"] = minWorld(5, int(math.Round(n)))
	}
	spots := worldSpots(g)
	spots = append(spots, spot)
	setWorldSpots(g, spots)
	if err := setWorldGrounds(c, grounds); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/add", groundID+":"+id, c, rev)
	if !good {
		return
	}
	_, ng, ns, _ := worldFind(next, groundID, id)
	_ = ng
	write(w, 200, map[string]any{"ok": true, "groundId": groundID, "spot": ns, "preset": preset, "filled": fill})
}

func stopWorldFishing(a *API, groundID, spotID string, ground bool) {
	q := `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1 WHERE state='active' AND ground_id=$1`
	args := []any{groundID}
	if !ground {
		q += ` AND spot_id=$2`
		args = append(args, spotID)
	}
	_, _ = a.pool.Exec(context.Background(), q, args...)
}

func (a *API) adminGroundRemove(w http.ResponseWriter, r *http.Request) {
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
	id, _ := worldString(body, "groundId")
	grounds, _, idx := func() ([]map[string]any, map[string]any, int) {
		gs, _ := worldGrounds(c)
		g, i := worldGround(gs, id)
		return gs, g, i
	}()
	if idx < 0 {
		write(w, 404, map[string]any{"error": "ground_not_found"})
		return
	}
	_, builtin := worldDefaultGround(id)
	grounds = append(grounds[:idx], grounds[idx+1:]...)
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/ground/remove", id, c, rev)
	if !good {
		return
	}
	stopWorldFishing(a, id, "", true)
	_ = next
	write(w, 200, map[string]any{"ok": true, "removed": id, "restorable": builtin})
}

func (a *API) adminSpotRemove(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	sid, _ := worldString(body, "spotId")
	grounds, g, _, _ := worldFind(c, gid, sid)
	if g == nil {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	_, builtin := worldDefaultSpot(gid, sid)
	spots := worldSpots(g)
	_, idx := worldSpot(g, sid)
	if idx < 0 {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	spots = append(spots[:idx], spots[idx+1:]...)
	setWorldSpots(g, spots)
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/remove", gid+":"+sid, c, rev)
	if !good {
		return
	}
	_ = next
	stopWorldFishing(a, gid, sid, false)
	write(w, 200, map[string]any{"ok": true, "removed": gid + ":" + sid, "restorable": builtin})
}

func (a *API) adminGroundRestore(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	sid, hasSpot := worldString(body, "spotId")
	grounds, _ := worldGrounds(c)
	g, _ := worldGround(grounds, gid)
	var restored string
	if hasSpot && sid != "" {
		if g == nil {
			write(w, 404, map[string]any{"error": "spot_not_found"})
			return
		}
		if _, spotIndex := worldSpot(g, sid); spotIndex >= 0 {
			write(w, 404, map[string]any{"error": "spot_not_removed"})
			return
		}
		base, exists := worldDefaultSpot(gid, sid)
		if !exists {
			write(w, 404, map[string]any{"error": "spot_not_removed"})
			return
		}
		spots := worldSpots(g)
		spots = append(spots, base)
		setWorldSpots(g, spots)
		restored = gid + ":" + sid
	} else {
		if g != nil {
			write(w, 404, map[string]any{"error": "ground_not_removed"})
			return
		}
		base, exists := worldDefaultGround(gid)
		if !exists {
			write(w, 404, map[string]any{"error": "ground_not_removed"})
			return
		}
		grounds = append(grounds, base)
		restored = gid
	}
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/ground/restore", restored, c, rev)
	if !good {
		return
	}
	_ = next
	write(w, 200, map[string]any{"ok": true, "restored": restored})
}

func (a *API) adminGroundUpdate(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	grounds, g, _, _ := worldFind(c, gid, "")
	if g == nil {
		write(w, 404, map[string]any{"error": "ground_not_found"})
		return
	}
	if name, exists := worldString(body, "name"); exists {
		name = strings.TrimSpace(name)
		if name == "" {
			failure(w, identity.ErrInvalid)
			return
		}
		if len([]rune(name)) > 20 {
			name = string([]rune(name)[:20])
		}
		g["name"] = name
	}
	if desc, exists := worldString(body, "desc"); exists {
		if len([]rune(desc)) > 80 {
			desc = string([]rune(desc)[:80])
		}
		g["desc"] = strings.TrimSpace(desc)
	}
	if typ, exists := worldString(body, "type"); exists {
		if typ != "event" {
			typ = "normal"
		}
		g["type"] = typ
	}
	if clear, _ := worldBool(body, "clearWindow"); clear {
		delete(g, "openFrom")
		delete(g, "openTo")
	} else if _, fromSet := body["openFrom"]; fromSet || body["openTo"] != nil {
		from, to, msg := worldWindow(body, "openFrom", "openTo")
		if msg != "" {
			failure(w, identity.ErrInvalid)
			return
		}
		if from == nil {
			delete(g, "openFrom")
		} else {
			g["openFrom"] = *from
		}
		if to == nil {
			delete(g, "openTo")
		} else {
			g["openTo"] = *to
		}
	}
	manualLocked, hasManualLocked := g["manualLocked"].(bool)
	if !hasManualLocked {
		manualLocked, _ = g["locked"].(bool)
	}
	lockedSet := false
	if locked, exists := worldBool(body, "locked"); exists {
		g["locked"] = locked
		g["manualLocked"] = locked
		manualLocked = locked
		lockedSet = true
	}
	if worldWindowLocked(g, time.Now()) {
		g["locked"] = true
	} else if !lockedSet {
		g["locked"] = manualLocked
	}
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/ground/update", gid, c, rev)
	if !good {
		return
	}
	ng, _ := worldGroundMust(next, gid)
	write(w, 200, map[string]any{"ok": true, "ground": ng})
}

func (a *API) adminSpotRate(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	sid, _ := worldString(body, "spotId")
	grounds, g, _, _ := worldFind(c, gid, sid)
	if g == nil {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	spots := worldSpots(g)
	_, spotIndex := worldSpot(g, sid)
	if spotIndex < 0 {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	s := spots[spotIndex]
	for _, k := range []struct {
		name     string
		min, max float64
	}{{"biteRate", 0, 100}, {"intervalMs", 100, 60000}} {
		_, exists := body[k.name]
		if !exists {
			continue
		}
		v, _ := worldRaw(body, k.name)
		if v == nil || v == "" {
			delete(s, k.name)
			continue
		}
		n, good := worldNumber(v)
		if !good || n < k.min || n > k.max {
			failure(w, identity.ErrInvalid)
			return
		}
		s[k.name] = worldRound(n, 2)
	}
	setWorldSpots(g, spots)
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/rate", gid+":"+sid, c, rev)
	if !good {
		return
	}
	_, _, ns, _ := worldFind(next, gid, sid)
	write(w, 200, map[string]any{"ok": true, "biteRate": ns["biteRate"], "intervalMs": ns["intervalMs"]})
}

func (a *API) adminSpotPos(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	grounds, g, _, _ := worldFind(c, gid, "")
	if g == nil {
		write(w, 404, map[string]any{"error": "ground_not_found"})
		return
	}
	list, exists := worldRaw(body, "list")
	entries := []any{}
	if exists {
		if parsed, ok := list.([]any); ok {
			entries = parsed
		} else {
			sid, _ := worldString(body, "spotId")
			pos, _ := worldRaw(body, "pos")
			entries = []any{map[string]any{"spotId": sid, "pos": pos}}
		}
	} else {
		sid, _ := worldString(body, "spotId")
		pos, _ := worldRaw(body, "pos")
		entries = []any{map[string]any{"spotId": sid, "pos": pos}}
	}
	spots := worldSpots(g)
	changed := 0
	for _, value := range entries {
		m, good := value.(map[string]any)
		if !good {
			failure(w, identity.ErrInvalid)
			return
		}
		sid, _ := m["spotId"].(string)
		pos, present := m["pos"]
		if !present {
			pos = nil
		}
		normalized, valid, isNull := worldPos(pos)
		if !valid {
			failure(w, identity.ErrInvalid)
			return
		}
		_, spotIndex := worldSpot(g, sid)
		if spotIndex < 0 {
			continue
		}
		s := spots[spotIndex]
		// 可选 map 字段：钓点跨过世界地图中线时，后台会连带切换它属于哪一侧历史坐标带
		// （近岸 = 左带 / 远洋 = 右带；玩家端按该字段选投影带，所以必须与 pos 一起改）。
		if mv, present := m["map"]; present {
			ms, _ := mv.(string)
			if ms != "" && ms != "voyage" {
				failure(w, identity.ErrInvalid)
				return
			}
			oldMap, hadMap := s["map"]
			if ms == "voyage" {
				if !hadMap || oldMap != "voyage" {
					s["map"] = "voyage"
					changed++
				}
			} else if hadMap {
				delete(s, "map")
				changed++
			}
		}
		old, had := s["pos"]
		if isNull {
			if had {
				delete(s, "pos")
				changed++
			}
		} else if !had || !reflect.DeepEqual(old, normalized) {
			s["pos"] = normalized
			changed++
		}
	}
	setWorldSpots(g, spots)
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/pos", gid, c, rev)
	if !good {
		return
	}
	_, ng, _, _ := worldFind(next, gid, "")
	rows := []map[string]any{}
	for _, s := range worldSpots(ng) {
		rows = append(rows, map[string]any{"id": s["id"], "name": s["name"], "pos": s["pos"]})
	}
	write(w, 200, map[string]any{"ok": true, "changed": changed, "spots": rows})
}

func (a *API) adminGroundLock(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	grounds, g, _, _ := worldFind(c, gid, "")
	if g == nil {
		write(w, 404, map[string]any{"error": "ground_not_found"})
		return
	}
	locked, exists := worldBool(body, "locked")
	if !exists {
		failure(w, identity.ErrInvalid)
		return
	}
	g["locked"] = locked
	g["manualLocked"] = locked
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/ground/lock", gid, c, rev)
	if !good {
		return
	}
	ng, _ := worldGroundMust(next, gid)
	if locked {
		stopWorldFishing(a, gid, "", true)
	}
	write(w, 200, map[string]any{"ok": true, "groundId": gid, "locked": ng["locked"]})
}

func (a *API) adminSpotLock(w http.ResponseWriter, r *http.Request) {
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
	gid, _ := worldString(body, "groundId")
	sid, _ := worldString(body, "spotId")
	grounds, g, _, _ := worldFind(c, gid, sid)
	if g == nil {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	spots := worldSpots(g)
	_, spotIndex := worldSpot(g, sid)
	if spotIndex < 0 {
		write(w, 404, map[string]any{"error": "spot_not_found"})
		return
	}
	s := spots[spotIndex]
	locked, exists := worldBool(body, "locked")
	if !exists {
		failure(w, identity.ErrInvalid)
		return
	}
	s["locked"] = locked
	setWorldSpots(g, spots)
	_ = setWorldGrounds(c, grounds)
	next, good := worldPublish(a, w, r, session, body, "/api/admin/spot/lock", gid+":"+sid, c, rev)
	if !good {
		return
	}
	_, _, ns, _ := worldFind(next, gid, sid)
	if locked {
		stopWorldFishing(a, gid, sid, false)
	}
	write(w, 200, map[string]any{"ok": true, "spotId": sid, "locked": ns["locked"]})
}

func (a *API) adminSimulate(w http.ResponseWriter, r *http.Request) {
	_, ok := a.authorize(w, r, true)
	if !ok {
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
	totals := rules.EmptyEffects()
	if raw, exists := worldRaw(body, "totals"); exists {
		if m, good := raw.(map[string]any); good {
			for k := range totals {
				if n, ok := worldNumber(m[k]); ok {
					totals[k] = worldRound(n, 1)
				}
			}
		}
	}
	var spotRaw map[string]any
	spotKey, _ := worldString(body, "spotKey")
	var groundID, spotID string
	if spotKey != "" {
		groundID, spotID, ok = strings.Cut(spotKey, ":")
		if !ok || groundID == "" || spotID == "" {
			failure(w, identity.ErrInvalid)
			return
		}
		_, _, s, _ := worldFind(c, groundID, spotID)
		if s == nil {
			failure(w, identity.ErrInvalid)
			return
		}
		spotRaw = s
	}
	spot := rules.Spot{}
	if spotRaw != nil {
		spot, _, _ = worldSpotRules(c, spotRaw)
	}
	info := c.CastRules(nil).Info(totals, spot)
	eff, _ := rules.MergeEffects(totals, spot)
	casts := 0.0
	if info.Interval > 0 {
		casts = 3600000 / info.Interval
	}
	bite := c.CastRules(nil).Bite(eff, info.Interval, spot)
	base, _ := worldNumber(c.Runtime["doubleBase"])
	base = math.Max(0, math.Min(1, base))
	p := rules.DoubleProbability(eff["double"], base)
	per := 1 + p + p*p
	loot := []map[string]any{}
	if spotRaw != nil {
		loot, _, _, err = worldLootRows(c, spotRaw, math.Max(0, eff["rare"]), eff["material"], false)
		if err != nil {
			failure(w, err)
			return
		}
	}
	cast := map[string]any{"baseMs": info.BaseMS, "minMs": info.MinMS, "globalBonus": info.GlobalBonus, "cap": info.Cap, "affixSpeed": totals["speed"], "buffSpeed": info.BuffSpeed, "effSpeed": info.EffSpeed, "interval": info.Interval, "castsPerHour": worldRound(casts, 1)}
	write(w, 200, map[string]any{"ok": true, "spot": func() any {
		if spotRaw == nil {
			return nil
		}
		return map[string]any{"groundId": groundID, "groundName": func() string { gs, _ := worldGrounds(c); g, _ := worldGround(gs, groundID); return asString(g["name"]) }(), "spotId": spotID, "spotName": spotRaw["name"], "buffs": spotRaw["buffs"], "biteRateOverride": spotRaw["biteRate"], "intervalOverride": spotRaw["intervalMs"]}
	}(), "cast": cast, "bite": map[string]any{"rate": bite, "override": info.BiteOverride, "formula": c.CastRules(nil).BiteFormula}, "rod": totals, "merged": eff, "double": map[string]any{"A": math.Max(0, eff["double"]), "base": base, "p": p * 100, "perCast": per}, "expect": map[string]any{"castsPerHour": worldRound(casts, 1), "fishPerCast": worldRound(per, 3), "fishPerHour": worldRound(casts*bite/100*per, 1)}, "loot": loot, "affixLabel": legacyAffixLabels(c)})
}

func (a *API) adminLootTest(w http.ResponseWriter, r *http.Request) {
	_, ok := a.authorize(w, r, true)
	if !ok {
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
	key, _ := worldString(body, "spotKey")
	gid, sid, split := strings.Cut(key, ":")
	if !split || gid == "" || sid == "" {
		failure(w, identity.ErrInvalid)
		return
	}
	_, g, s, _ := worldFind(c, gid, sid)
	if g == nil || s == nil {
		failure(w, identity.ErrInvalid)
		return
	}
	rare := 0.0
	if n, good := worldFloat(body, "rare"); good {
		rare = math.Max(0, n)
	}
	rows, cb, ca, err := worldLootRows(c, s, rare, 0, true)
	if err != nil {
		failure(w, err)
		return
	}
	k := c.DefaultLootConfig().RareK
	write(w, 200, map[string]any{"ok": true, "k": k, "rare": rare, "mult": worldRound(rules.RareCommonMultiplier(rare, k), 4), "spot": map[string]any{"key": key, "name": asString(g["name"]) + "·" + asString(s["name"])}, "commonBefore": worldRound(cb, 2), "commonAfter": worldRound(ca, 2), "rows": rows})
}
