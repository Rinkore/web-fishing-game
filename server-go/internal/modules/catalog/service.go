// Package catalog stores immutable complete rule snapshots and an atomic head.
package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func Version(c *rules.Catalog) string { return "catch-v1:" + c.Version + ":" + c.SourceSHA256 }

// Effective is the legacy name for the immutable catalog read. Gameplay rules
// must come from one published release so a pinned retry can reproduce the
// exact snapshot used by the original operation. Display-only operator state
// is intentionally stored separately and never overlaid here.
func Effective(ctx context.Context, q assets.SQL) (*rules.Catalog, int64, error) {
	return Current(ctx, q)
}

// ApplyLegacySettings applies a validated legacy settings patch to a catalog
// that is about to be published. It is deliberately a mutation of the
// candidate snapshot, never a read-time overlay.
func ApplyLegacySettings(c *rules.Catalog, values map[string]json.RawMessage) {
	if c == nil {
		return
	}
	mergeDefault := func(name string, raw json.RawMessage) {
		base := map[string]any{}
		patch := map[string]any{}
		if json.Unmarshal(c.Defaults[name], &base) != nil || json.Unmarshal(raw, &patch) != nil {
			return
		}
		for k, v := range patch {
			base[k] = v
		}
		if encoded, err := json.Marshal(base); err == nil {
			c.Defaults[name] = encoded
		}
	}
	if raw := values["legacy:mall"]; len(raw) > 0 {
		mergeDefault("mall", raw)
	}
	if raw := values["legacy:smelt"]; len(raw) > 0 {
		mergeDefault("smelt", raw)
	}
	if c.Runtime == nil {
		c.Runtime = map[string]any{}
	}
	mergeRuntimeMap := func(name string, patch map[string]any) {
		base, _ := c.Runtime[name].(map[string]any)
		if base == nil {
			base = map[string]any{}
		}
		for key, value := range patch {
			base[key] = value
		}
		c.Runtime[name] = base
	}
	settings := map[string]any{}
	if raw := values["legacy:settings"]; len(raw) > 0 {
		_ = json.Unmarshal(raw, &settings)
	}
	if v, ok := settings["chestCfg"].(map[string]any); ok {
		applyChestSettings(c, v)
	}
	if v, ok := settings["dropCfg"].(map[string]any); ok {
		mergeRuntimeMap("drop", v)
	}
	if n, ok := settings["rareK"].(float64); ok && finiteCatalogNumber(n) && n > 0 && n <= 100000 {
		c.Runtime["rareK"] = n
	}
	if n, ok := settings["doubleBase"].(float64); ok && finiteCatalogNumber(n) && n >= 0 && n <= 1 {
		c.Runtime["doubleBase"] = n
	}
	if v, ok := settings["priceCfg"].(map[string]any); ok {
		mergeRuntimeMap("price", v)
	}
	if v, ok := settings["autoSellCfg"].(map[string]any); ok {
		if n, ok := v["batch"].(float64); ok {
			c.Runtime["autoSellBatch"] = n
		}
	}
	cast := map[string]any{}
	for key, name := range map[string]string{"castBaseMs": "baseMs", "castMinMs": "minMs", "castSpeedBonus": "speedBonus", "castSpeedCap": "speedCap"} {
		if value, ok := settings[key]; ok {
			cast[name] = value
		}
	}
	if formula, ok := settings["castFormula"]; ok {
		cast["formula"] = formula
	}
	if len(cast) > 0 {
		mergeRuntimeMap("cast", cast)
	}
	if formula, ok := settings["biteFormula"].(string); ok && formula != "" {
		c.Runtime["biteFormula"] = formula
	}
}

func finiteCatalogNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

func applyChestSettings(c *rules.Catalog, settings map[string]any) {
	var chests []map[string]any
	if c.Constant("CHESTS", &chests) != nil {
		return
	}
	if pity, ok := settings["pityN"].(float64); ok {
		if pity <= 0 {
			delete(c.Runtime, "chestPityN")
		} else {
			c.Runtime["chestPityN"] = pity
		}
	}
	costs, hasCosts := settings["costs"].(map[string]any)
	if !hasCosts {
		return
	}
	// Like GameData.applyChestCosts, costs replaces the override map. Empty
	// or omitted entries restore the published factory recipe, not the last edit.
	var baseCosts map[string]map[string]any
	_ = c.Constant("CHEST_BASE_COSTS", &baseCosts)
	var relicPrice float64
	_ = c.Constant("RELIC_PRICE", &relicPrice)
	for _, chest := range chests {
		id, _ := chest["id"].(string)
		override, _ := costs[id].(map[string]any)
		for key := range map[string]bool{"costRelic": true, "costCoins": true} {
			if value, ok := override[key]; ok {
				chest[key] = value
			} else if value, ok := baseCosts[id][key]; ok {
				chest[key] = value
			}
		}
		coins, _ := chest["costCoins"].(float64)
		relics, _ := chest["costRelic"].(float64)
		chest["price"] = coins + relics*relicPrice
		for i := range c.Items {
			if c.Items[i].ID == id {
				c.Items[i].Price = coins + relics*relicPrice
				break
			}
		}
	}
	if raw, err := json.Marshal(chests); err == nil {
		c.Constants["CHESTS"] = raw
	}
}

func Current(ctx context.Context, q assets.SQL) (*rules.Catalog, int64, error) {
	var raw []byte
	var id int64
	err := q.QueryRow(ctx, `SELECT COALESCE(h.release_id,0),r.catalog FROM fishing.catalog_head h LEFT JOIN fishing.catalog_releases r ON r.id=h.release_id WHERE singleton`).Scan(&id, &raw)
	if err != nil {
		return nil, 0, assets.ErrUnavailable
	}
	if id == 0 {
		c, e := rules.Default()
		return c, 0, e
	}
	c, e := rules.DecodeCatalog(raw)
	return c, id, e
}
func ByVersion(ctx context.Context, q assets.SQL, version string) (*rules.Catalog, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT catalog FROM fishing.catalog_releases WHERE rule_version=$1 ORDER BY id DESC LIMIT 1`, version).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		c, e := rules.Default()
		if e == nil && Version(c) == version {
			return c, nil
		}
		return nil, assets.ErrDeferred
	}
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	return rules.DecodeCatalog(raw)
}

type Publish struct {
	ActorID          int64
	RequestKey       string
	ExpectedRevision int64
	Catalog          json.RawMessage
	// LegacySettingsPatch contains display-only fields that must be committed
	// with the catalog publication (currently notifyLevel). Gameplay settings
	// are encoded in Catalog itself and never stored in operator_settings.
	LegacySettingsPatch json.RawMessage
	// Audit fields are optional for the generic v1 catalog editor. World/drop
	// admin mutations populate them so the console audit is committed with the
	// immutable catalog release and head update.
	AuditAction string
	AuditName   string
	AuditTarget string
	AuditDetail string
}

func PublishConfig(ctx context.Context, pool *pgxpool.Pool, r Publish) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, r.ActorID); err != nil {
		return assets.Result{}, err
	}
	if r.ExpectedRevision < 0 || len(r.Catalog) > 1<<20 {
		return assets.Result{}, assets.ErrInvalid
	}
	c, err := rules.DecodeCatalog(r.Catalog)
	if err != nil || rules.ValidateCatalog(c) != nil {
		return assets.Result{}, assets.ErrInvalid
	}
	c.SourceSHA256 = ""
	canonical, _ := json.Marshal(c)
	hash := sha256.Sum256(canonical)
	digest := hex.EncodeToString(hash[:])
	c.SourceSHA256 = digest
	canonical, _ = json.Marshal(c)
	input := struct {
		Revision int64
		Digest   string
		Settings json.RawMessage
	}{r.ExpectedRevision, digest, r.LegacySettingsPatch}
	return assets.New(pool).Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "catalog_publish", RuleVersion: "catalog-schema-v1", Players: []int64{r.ActorID}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var current int64
		if err := t.SQL().QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton FOR UPDATE`).Scan(&current); err != nil {
			return assets.Result{}, err
		}
		if current != r.ExpectedRevision {
			return assets.Result{}, assets.Rejection("catalog_revision_changed")
		}
		// Definition identities cannot be silently deleted or change category.
		if err := t.EnsureDefinitions(ctx, c.Items); err != nil {
			return assets.Result{}, err
		}
		var id int64
		if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.catalog_releases(operation_id,actor_id,digest,rule_version,catalog) VALUES($1,$2,$3,$4,$5) RETURNING id`, t.OperationID(), r.ActorID, digest, Version(c), canonical).Scan(&id); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.catalog_head SET release_id=$1 WHERE singleton`, id); err != nil {
			return assets.Result{}, err
		}
		if len(r.LegacySettingsPatch) > 0 {
			var patch map[string]json.RawMessage
			if err := json.Unmarshal(r.LegacySettingsPatch, &patch); err != nil || len(patch) == 0 {
				return assets.Result{}, assets.ErrInvalid
			}
			encoded, err := json.Marshal(patch)
			if err != nil {
				return assets.Result{}, assets.ErrInvalid
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES('legacy:settings',$1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=fishing.operator_settings.value || excluded.value,updated_at=excluded.updated_at`, encoded); err != nil {
				return assets.Result{}, err
			}
		}
		if r.AuditAction != "" {
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,action,target,detail) VALUES($1,$2,$3,$4,$5)`,
				r.ActorID, r.AuditName, r.AuditAction, r.AuditTarget, r.AuditDetail); err != nil {
				return assets.Result{}, err
			}
		}
		return assets.Result{Status: "published", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
