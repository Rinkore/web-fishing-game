package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"strings"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/rules"
)

// PrepareRealCatalog resolves the same effective catalog as the legacy loader.
// Obsolete ground overrides remain in the source ledger but never resurrect
// removed built-in grounds, matching applyGroundCfg in the original server.
func PrepareRealCatalog(ctx context.Context, rc *RealContext) error {
	cfg, err := readObject(filepath.Join(rc.Root, "config.json"))
	if err != nil {
		return err
	}
	econ, err := readObject(filepath.Join(rc.Root, "economy.json"))
	if err != nil {
		return err
	}
	c, err := buildRealCatalog(cfg, econ)
	if err != nil {
		return err
	}
	rc.Catalog = c
	for _, it := range c.Items {
		if it.Kind == "component" && it.Part == "" {
			continue
		}
		kind, part := it.Kind, it.Part
		if kind == "component" {
			kind = "equipment"
		} else {
			part = ""
		}
		if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES($1,$2,NULLIF($3,'')) ON CONFLICT(id) DO NOTHING`, it.ID, kind, part); err != nil {
			return err
		}
		var actualKind string
		var actualPart *string
		if err := rc.Tx.QueryRow(ctx, `SELECT kind,part FROM fishing.item_definitions WHERE id=$1`, it.ID).Scan(&actualKind, &actualPart); err != nil {
			return err
		}
		if actualKind != kind || (part != "" && (actualPart == nil || *actualPart != part)) {
			return errors.New("real catalog definition conflict")
		}
	}
	return nil
}

func buildRealCatalog(cfg, economy map[string]any) (*rules.Catalog, error) {
	c, err := rules.Default()
	if err != nil {
		return nil, err
	}
	// Use ordinary JSON numbers in rule maps; readObject intentionally uses
	// json.Number to retain exact integer balances in account imports.
	var values map[string]any
	if err := json.Unmarshal(jsonBytes(cfg, nil), &values); err != nil {
		return nil, err
	}
	if c.Runtime == nil {
		c.Runtime = map[string]any{}
	}
	merge := func(base json.RawMessage, patch any) json.RawMessage {
		m := map[string]any{}
		_ = json.Unmarshal(base, &m)
		if p, ok := patch.(map[string]any); ok {
			for k, v := range p {
				m[k] = v
			}
		}
		return jsonBytes(m, []byte("{}"))
	}
	for field, key := range map[string]string{"componentCfg": "component", "fishCfg": "fish", "smeltCfg": "smelt", "mallCfg": "mall", "snapshotCfg": "snapshot"} {
		if value, ok := values[field]; ok {
			c.Defaults[key] = merge(c.Defaults[key], value)
		}
	}
	// The source ledger keeps the unmodified operator configuration. Current
	// expedition-only materials cannot be purchased, so do not publish dead
	// mall entries from an older release. Inventory and purchase counters are
	// imported independently and remain unchanged.
	mall := c.MallConfig()
	mallItems := make([]rules.MallItem, 0, len(mall.Items))
	for _, item := range mall.Items {
		definition, exists := c.Item(item.ID)
		if exists && definition.ExpeditionOnly {
			continue
		}
		mallItems = append(mallItems, item)
	}
	mall.Items = mallItems
	c.Defaults["mall"] = jsonBytes(mall, nil)
	settings := map[string]any{}
	for _, k := range []string{"chestCfg", "dropCfg", "rareK", "doubleBase", "priceCfg", "autoSellCfg", "biteFormula"} {
		if v, ok := values[k]; ok {
			settings[k] = v
		}
	}
	catalog.ApplyLegacySettings(c, map[string]json.RawMessage{"legacy:settings": jsonBytes(settings, nil)})
	if v, ok := values["castCfg"].(map[string]any); ok {
		c.Runtime["cast"] = v
	}
	if v, ok := values["lootCfg"].(map[string]any); ok {
		if groups, exists := v["groups"]; exists {
			c.Runtime["lootGroups"] = groups
		}
	}
	if sea, ok := values["seaCfg"].(map[string]any); ok {
		if err := applyRealSea(c, sea); err != nil {
			return nil, err
		}
	}
	if ground, ok := values["groundCfg"].(map[string]any); ok {
		if err := applyRealGrounds(c, ground); err != nil {
			return nil, err
		}
	}
	var overrides map[string]any
	if err := json.Unmarshal(jsonBytes(economy["priceOv"], []byte("{}")), &overrides); err != nil {
		return nil, err
	}
	if len(overrides) > 0 {
		c.Runtime["priceOverrides"] = overrides
	}
	c.SourceSHA256 = ""
	h := sha256.Sum256(jsonBytes(c, nil))
	c.SourceSHA256 = hex.EncodeToString(h[:])
	c, err = rules.DecodeCatalog(jsonBytes(c, nil))
	if err != nil {
		return nil, err
	}
	if err = rules.ValidateCatalog(c); err != nil {
		return nil, errors.New("legacy catalog is invalid")
	}
	return c, nil
}

// SEA configuration is a patch over shipped definitions, unlike the complete
// immutable catalog representation. In particular quest patches omit kind
// and submit fields, and replacing the array would silently break progression.
func applyRealSea(c *rules.Catalog, cfg map[string]any) error {
	var ship, sea map[string]any
	if err := c.Constant("SHIP", &ship); err != nil {
		return err
	}
	if err := c.Constant("SEA", &sea); err != nil {
		return err
	}
	if src, ok := cfg["ship"].(map[string]any); ok {
		for _, key := range []string{"xpNeed", "upCoins", "upScale"} {
			if values, ok := src[key].([]any); ok {
				old, _ := ship[key].([]any)
				if len(values) == len(old) {
					ship[key] = values
				}
			}
		}
		if names, ok := src["names"].([]any); ok {
			levels, _ := ship["levels"].([]any)
			if len(names) == len(levels) {
				for i, n := range names {
					if name, ok := n.(string); ok && strings.TrimSpace(name) != "" {
						value := []rune(strings.TrimSpace(name))
						if len(value) > 12 {
							value = value[:12]
						}
						if level, ok := levels[i].(map[string]any); ok {
							level["name"] = string(value)
						}
					}
				}
			}
		}
	}
	if src, ok := cfg["sea"].(map[string]any); ok {
		for _, key := range []string{"chartCost", "zoneMax", "questResetHour"} {
			if v, ok := src[key]; ok && v != nil {
				sea[key] = v
			}
		}
		if n, ok := src["zoneTtlMin"].(float64); ok {
			sea["zoneTtlMs"] = n * 60000
		}
		for _, key := range []string{"events", "anchor", "nightglow"} {
			if patch, ok := src[key].(map[string]any); ok {
				old, _ := sea[key].(map[string]any)
				if old == nil {
					old = map[string]any{}
				}
				for k, v := range patch {
					old[k] = v
				}
				sea[key] = old
			}
		}
		if patches, ok := src["quests"].([]any); ok {
			quests, _ := sea["quests"].([]any)
			for _, raw := range patches {
				patch, ok := raw.(map[string]any)
				if !ok {
					return errors.New("invalid sea quest patch")
				}
				var target map[string]any
				for _, v := range quests {
					q, _ := v.(map[string]any)
					if stringValue(q, "id") == stringValue(patch, "id") {
						target = q
						break
					}
				}
				if target == nil {
					continue
				}
				for _, k := range []string{"kind", "title", "need", "submitNeed"} {
					if v, ok := patch[k]; ok && v != nil {
						target[k] = v
					}
				}
				if kind, ok := patch["kind"].(string); ok && kind != "submit" {
					delete(target, "submit")
					delete(target, "submitNeed")
				}
				if v, ok := patch["submit"].(map[string]any); ok && stringValue(v, "id") != "" {
					target["submit"] = v
					delete(target, "submitNeed")
				}
				if stringValue(target, "kind") == "submit" {
					target["need"] = float64(1)
					if v, ok := target["submit"].(map[string]any); !ok || stringValue(v, "id") == "" {
						target["submit"] = map[string]any{"id": "deepscale", "count": float64(8)}
					}
				}
				if reward, ok := patch["reward"].(map[string]any); ok {
					old, _ := target["reward"].(map[string]any)
					if old == nil {
						old = map[string]any{}
					}
					for k, v := range reward {
						old[k] = v
					}
					target["reward"] = old
				}
			}
		}
	}
	c.Constants["SHIP"] = jsonBytes(ship, nil)
	c.Constants["SEA"] = jsonBytes(sea, nil)
	return nil
}

func applyRealGrounds(c *rules.Catalog, cfg map[string]any) error {
	var grounds []map[string]any
	if err := json.Unmarshal(c.Constants["GROUNDS"], &grounds); err != nil {
		return err
	}
	removed, _ := cfg["removed"].(map[string]any)
	removedSet := func(k string) map[string]bool {
		out := map[string]bool{}
		xs, _ := removed[k].([]any)
		for _, v := range xs {
			if s, ok := v.(string); ok {
				out[s] = true
			}
		}
		return out
	}
	rg, rs := removedSet("grounds"), removedSet("spots")
	byID := map[string]map[string]any{}
	next := []map[string]any{}
	add := func(g map[string]any, custom bool) {
		id := stringValue(g, "id")
		if id == "" || rg[id] || byID[id] != nil {
			return
		}
		g["custom"] = custom
		byID[id] = g
		next = append(next, g)
	}
	for _, g := range grounds {
		add(g, false)
	}
	custom, _ := cfg["custom"].([]any)
	for _, raw := range custom {
		if g, ok := raw.(map[string]any); ok {
			add(g, true)
		}
	}
	extra, _ := cfg["customSpots"].(map[string]any)
	spotCfg, _ := cfg["spots"].(map[string]any)
	positions, _ := cfg["spotPos"].(map[string]any)
	groundCfg, _ := cfg["grounds"].(map[string]any)
	for _, g := range next {
		gid := stringValue(g, "id")
		spots, _ := g["spots"].([]any)
		extras, _ := extra[gid].([]any)
		spots = append(spots, extras...)
		kept := []any{}
		seen := map[string]bool{}
		for _, raw := range spots {
			s, ok := raw.(map[string]any)
			if !ok {
				return errors.New("invalid legacy ground spot")
			}
			id := stringValue(s, "id")
			key := gid + ":" + id
			if rs[key] || seen[id] {
				continue
			}
			seen[id] = true
			if patch, ok := spotCfg[key].(map[string]any); ok {
				for _, k := range []string{"pool", "buffs", "biteRate", "intervalMs", "locked"} {
					if v, exists := patch[k]; exists && v != nil && v != "" {
						s[k] = v
					}
				}
			}
			if pos, ok := positions[key].([]any); ok && len(pos) == 2 {
				s["pos"] = pos
			}
			kept = append(kept, s)
		}
		g["spots"] = kept
		if patch, ok := groundCfg[gid].(map[string]any); ok {
			for _, k := range []string{"name", "desc", "type", "locked", "openFrom", "openTo"} {
				if v, exists := patch[k]; exists {
					g[k] = v
				}
			}
		}
	}
	c.Constants["GROUNDS"] = jsonBytes(next, nil)
	return nil
}

// ImportRealConfig publishes a complete immutable snapshot after identities
// exist, so all readers and asset workers pin the imported rules consistently.
func ImportRealConfig(ctx context.Context, rc *RealContext) error {
	cfg, err := readObject(filepath.Join(rc.Root, "config.json"))
	if err != nil {
		return err
	}
	var actor int64
	if err = rc.Tx.QueryRow(ctx, `SELECT account_id FROM fishing.identities ORDER BY admin DESC,account_id LIMIT 1`).Scan(&actor); err != nil {
		return err
	}
	op, err := realDomainOperation(ctx, rc, actor, "catalog", "catalog_publish")
	if err != nil {
		return err
	}
	var release int64
	if err = rc.Tx.QueryRow(ctx, `INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog) VALUES($1,$2,$3,$4,$5) RETURNING id`, op, actor, rc.Catalog.SourceSHA256, catalog.Version(rc.Catalog), jsonBytes(rc.Catalog, nil)).Scan(&release); err != nil {
		return err
	}
	if _, err = rc.Tx.Exec(ctx, `UPDATE fishing.catalog_head SET release_id=$1 WHERE singleton`, release); err != nil {
		return err
	}
	settings := map[string]any{}
	for _, k := range []string{"notifyLevel", "autoNotify", "fishingFormulaRevision", "fishingFormulaBackup", "wikiConfigRevision"} {
		if v, ok := cfg[k]; ok {
			settings[k] = v
		}
	}
	for key, v := range map[string]any{"legacy:settings": settings, "legacy:records": cfg["recordsCfg"], "feedback": cfg["feedbackCfg"], "snapshot": cfg["snapshotCfg"]} {
		if v != nil {
			if err := realSetting(ctx, rc, key, v); err != nil {
				return err
			}
		}
	}
	flags := map[string]any{}
	for _, k := range []string{"market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends"} {
		flags[k] = true
	}
	if src, ok := cfg["features"].(map[string]any); ok {
		for k, v := range src {
			flags[k] = v
		}
	}
	op, err = realDomainOperation(ctx, rc, actor, "features", "feature_publish")
	if err != nil {
		return err
	}
	fraw := jsonBytes(flags, nil)
	fh := sha256.Sum256(fraw)
	if err = rc.Tx.QueryRow(ctx, `INSERT INTO fishing.feature_releases(operation_id,actor_id,schema_version,digest,flags) VALUES($1,$2,1,$3,$4) RETURNING id`, op, actor, hex.EncodeToString(fh[:]), fraw).Scan(&release); err != nil {
		return err
	}
	if _, err = rc.Tx.Exec(ctx, `UPDATE fishing.feature_head SET release_id=$1 WHERE singleton`, release); err != nil {
		return err
	}
	if err = realSetting(ctx, rc, "features", map[string]any{"order": cfg["featureOrder"], "adminBypass": flags["adminBypass"]}); err != nil {
		return err
	}
	seq := intNumber(cfg["bannerSeq"])
	if seq < 1 {
		seq = 1
	}
	_, err = rc.Tx.Exec(ctx, `UPDATE fishing.banner_state SET next_seq=$1,banners=$2,cfg=$3 WHERE singleton`, seq, jsonBytes(cfg["banners"], []byte("[]")), jsonBytes(cfg["bannerCfg"], []byte("{}")))
	return err
}

func realSetting(ctx context.Context, rc *RealContext, key string, v any) error {
	_, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp()`, key, jsonBytes(v, nil))
	return err
}

func realDomainOperation(ctx context.Context, rc *RealContext, actor int64, key, kind string) (int64, error) {
	request := "migration:" + rc.RunID + ":" + key
	hash := sha256.Sum256([]byte(request))
	if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,'{"status":"imported"}')`, actor, request, hash[:]); err != nil {
		return 0, err
	}
	var op int64
	err := rc.Tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,$3,$4) RETURNING id`, actor, request, kind, ToolVersion).Scan(&op)
	return op, err
}

func ReconcileRealConfig(ctx context.Context, rc *RealContext) error {
	want, err := readObject(filepath.Join(rc.Root, "config.json"))
	if err != nil {
		return err
	}
	econ, err := readObject(filepath.Join(rc.Root, "economy.json"))
	if err != nil {
		return err
	}
	c, err := buildRealCatalog(want, econ)
	if err != nil {
		return err
	}
	rc.Catalog = c
	var equal bool
	if err = rc.Tx.QueryRow(ctx, `SELECT r.catalog=$1::jsonb FROM fishing.catalog_head h JOIN fishing.catalog_releases r ON r.id=h.release_id WHERE h.singleton`, jsonBytes(c, nil)).Scan(&equal); err != nil {
		return err
	}
	if !equal {
		return errors.New("catalog reconciliation mismatch")
	}
	checks := map[string]any{"legacy:records": want["recordsCfg"], "feedback": want["feedbackCfg"], "snapshot": want["snapshotCfg"]}
	settings := map[string]any{}
	for _, k := range []string{"notifyLevel", "autoNotify", "fishingFormulaRevision", "fishingFormulaBackup", "wikiConfigRevision"} {
		if v, ok := want[k]; ok {
			settings[k] = v
		}
	}
	checks["legacy:settings"] = settings
	flags := map[string]any{}
	for _, k := range []string{"market", "trade", "workshop", "chest", "mall", "sell", "autosell", "friends"} {
		flags[k] = true
	}
	if src, ok := want["features"].(map[string]any); ok {
		for k, v := range src {
			flags[k] = v
		}
	}
	checks["features"] = map[string]any{"order": want["featureOrder"], "adminBypass": flags["adminBypass"]}
	if err = rc.Tx.QueryRow(ctx, `SELECT r.flags=$1::jsonb FROM fishing.feature_head h JOIN fishing.feature_releases r ON r.id=h.release_id WHERE h.singleton`, jsonBytes(flags, nil)).Scan(&equal); err != nil {
		return err
	}
	if !equal {
		return errors.New("feature flags reconciliation mismatch")
	}
	seq := intNumber(want["bannerSeq"])
	if seq < 1 {
		seq = 1
	}
	if err = rc.Tx.QueryRow(ctx, `SELECT next_seq=$1 AND banners=$2::jsonb AND cfg=$3::jsonb FROM fishing.banner_state WHERE singleton`, seq, jsonBytes(want["banners"], []byte("[]")), jsonBytes(want["bannerCfg"], []byte("{}"))).Scan(&equal); err != nil {
		return err
	}
	if !equal {
		return errors.New("banner state reconciliation mismatch")
	}
	keys := make([]string, 0, len(checks))
	for k := range checks {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if checks[key] == nil {
			continue
		}
		if err = rc.Tx.QueryRow(ctx, `SELECT value=$2::jsonb FROM fishing.operator_settings WHERE key=$1`, key, jsonBytes(checks[key], nil)).Scan(&equal); err != nil {
			return err
		}
		if !equal {
			return errors.New("operator setting reconciliation mismatch: " + strings.TrimPrefix(key, "legacy:"))
		}
	}
	return nil
}
