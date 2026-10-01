package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/mall"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

const (
	legacyRecordsSetting = "legacy:records"
	legacyRecordsRuntime = "legacy:records_runtime"
	legacySettingsKey    = "legacy:settings"
)

func (a *API) legacyStoredConfig(ctx context.Context) (map[string]any, string) {
	// Gameplay settings live in the immutable catalog release. Only display
	// metadata remains in operator_settings; stale gameplay rows are ignored.
	keys := []string{legacyRecordsSetting, legacySettingsKey}
	values := map[string]any{}
	joined := make([]byte, 0, 256)
	for _, key := range keys {
		raw, err := a.legacySettingRaw(ctx, key)
		if err != nil || len(raw) == 0 {
			continue
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		if key == legacySettingsKey {
			settings, ok := value.(map[string]any)
			if !ok {
				continue
			}
			display := map[string]any{}
			for _, key := range []string{"notifyLevel", "autoNotify"} {
				if value, exists := settings[key]; exists {
					display[key] = value
				}
			}
			value = display
		}
		values[key] = value
		joined = append(joined, key...)
		projected, _ := json.Marshal(value)
		joined = append(joined, projected...)
	}
	digest := sha256.Sum256(joined)
	return values, hex.EncodeToString(digest[:])
}

func applyLegacyStoredConfig(fields map[string]any, values map[string]any) {
	if value, ok := values[legacyRecordsSetting]; ok {
		fields["recordsCfg"] = value
	}
	if settings, ok := values[legacySettingsKey].(map[string]any); ok {
		for _, key := range []string{"notifyLevel", "autoNotify"} {
			if value, exists := settings[key]; exists {
				fields[key] = value
			}
		}
	}
}

func legacyStoredConfigFrames(values map[string]any) []map[string]any {
	frames := []map[string]any{}
	if value, ok := values[legacyRecordsSetting]; ok {
		frames = append(frames, map[string]any{"type": "recordscfg", "recordsCfg": value})
	}
	if settings, ok := values[legacySettingsKey].(map[string]any); ok {
		if value, exists := settings["notifyLevel"]; exists {
			frames = append(frames, map[string]any{"type": "notifycfg", "notifyLevel": value})
		}
	}
	return frames
}

func (a *API) legacySettingRaw(ctx context.Context, key string) ([]byte, error) {
	var raw []byte
	err := a.pool.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return raw, err
}

func legacyNumber(raw json.RawMessage, min, max float64) (float64, bool) {
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		var s string
		if json.Unmarshal(raw, &s) != nil || strings.TrimSpace(s) == "" {
			return 0, false
		}
		n = rules.Number(s)
	}
	if string(raw) == "null" || math.IsNaN(n) || math.IsInf(n, 0) || n < min || n > max {
		return 0, false
	}
	return n, true
}

func legacyConfigRequestKey(route string, actor identity.Session, revision int64, value any, displayPatch map[string]json.RawMessage) string {
	raw, _ := json.Marshal(struct {
		Actor        int64
		Catalog      any
		DisplayPatch map[string]json.RawMessage
	}{actor.AccountID, value, displayPatch})
	hash := sha256.Sum256(append([]byte(route+":"+stringInt64(revision)+":"), raw...))
	return "legacy:config:" + hex.EncodeToString(hash[:])
}

func legacyCatalogDefault(c *rules.Catalog, name string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if c.Defaults == nil {
		c.Defaults = map[string]json.RawMessage{}
	}
	c.Defaults[name] = raw
	return nil
}

func (a *API) legacyPublishCatalog(r *http.Request, actor identity.Session, route, detail string, c *rules.Catalog, revision int64, displayPatch map[string]json.RawMessage) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return identity.ErrInvalid
	}
	var patchRaw json.RawMessage
	if len(displayPatch) > 0 {
		patchRaw, err = json.Marshal(displayPatch)
		if err != nil {
			return identity.ErrInvalid
		}
	}
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	auditAction := strings.TrimPrefix(route, "/api/admin/")
	if auditAction == "settings" {
		auditAction = "settings/update"
	}
	result, err := catalog.PublishConfig(ctx, a.pool, catalog.Publish{
		ActorID: actor.AccountID, RequestKey: legacyConfigRequestKey(route, actor, revision, c, displayPatch),
		ExpectedRevision: revision, Catalog: raw, LegacySettingsPatch: patchRaw,
		AuditAction: auditAction, AuditName: actor.Name,
		AuditDetail: detail,
	})
	if err == nil && result.Status != "published" {
		return assets.Rejection(result.Status)
	}
	return err
}

func (a *API) legacyAdminConfigWrite(w http.ResponseWriter, r *http.Request, actor identity.Session, key, action string, value any, reset bool, target, detail string) error {
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return identity.ErrStorage
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := legacyAdminWriteGuard(ctx, tx, actor); err != nil {
		return err
	}
	if reset {
		if _, err = tx.Exec(ctx, `DELETE FROM fishing.operator_settings WHERE key=$1`, key); err != nil {
			return identity.ErrStorage
		}
	} else {
		raw, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			return identity.ErrInvalid
		}
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, raw); err != nil {
			return identity.ErrStorage
		}
	}
	if err = legacyAdminAudit(ctx, tx, actor, action, nil, target, detail); err != nil {
		return identity.ErrStorage
	}
	if err = tx.Commit(ctx); err != nil {
		return identity.ErrCommitUnknown
	}
	return nil
}

// legacyAdminSettingsWrite publishes gameplay settings into the immutable
// catalog and commits display-only metadata in the same transaction. Reading
// the previous catalog in the HTTP handler is safe because PublishConfig locks
// the head and rejects a stale revision rather than overwriting a newer edit.
func (a *API) legacyAdminSettingsWrite(r *http.Request, actor identity.Session, value any) error {
	ctx := r.Context()
	raw, err := json.Marshal(value)
	if err != nil {
		return identity.ErrInvalid
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil {
		return identity.ErrInvalid
	}
	gameplay := map[string]json.RawMessage{}
	display := map[string]json.RawMessage{}
	for key, value := range patch {
		switch key {
		case "notifyLevel", "autoNotify":
			display[key] = value
		case "chestCfg", "dropCfg", "rareK", "doubleBase", "priceCfg", "autoSellCfg",
			"castBaseMs", "castMinMs", "castSpeedBonus", "castSpeedCap", "castFormula", "biteFormula":
			gameplay[key] = value
		}
	}
	// Remove settings fields that were only accepted as legacy reset controls.
	for key := range patch {
		if strings.HasPrefix(key, "reset") {
			delete(display, key)
		}
	}
	for attempt := 0; attempt < 3; attempt++ {
		c, revision, err := catalog.Current(ctx, a.pool)
		if err != nil {
			return err
		}
		if raw, exists := patch["autoNotify"]; exists {
			previous := operations.DefaultAutoNotify()
			if stored, err := a.legacySettingRaw(ctx, legacySettingsKey); err != nil {
				return err
			} else if len(stored) > 0 {
				var settings struct {
					AutoNotify operations.AutoNotifyConfig `json:"autoNotify"`
				}
				settings.AutoNotify = previous
				if json.Unmarshal(stored, &settings) != nil {
					return identity.ErrStorage
				}
				previous = settings.AutoNotify
			}
			next, err := operations.ParseAutoNotify(raw, previous)
			if err != nil {
				return identity.ErrInvalid
			}
			display["autoNotify"], _ = json.Marshal(next)
			display["autoNotifyState"] = json.RawMessage(`{}`)
		}
		// Reset flags are actions on the candidate snapshot, not durable settings.
		if raw, exists := patch["seaCfg"]; exists {
			if err := applySeaSettings(c, raw); err != nil {
				return err
			}
		}
		if reset, _ := rawBool(patch["resetPriceCfg"]); reset {
			delete(c.Runtime, "price")
		}
		if reset, _ := rawBool(patch["resetDropCfg"]); reset {
			delete(c.Runtime, "drop")
		}
		if reset, _ := rawBool(patch["resetCastSpeed"]); reset {
			delete(c.Runtime, "cast")
		}
		if len(gameplay) > 0 {
			encoded, _ := json.Marshal(gameplay)
			catalog.ApplyLegacySettings(c, map[string]json.RawMessage{"legacy:settings": encoded})
		}
		if raw, ok := patch["priceOv"]; ok {
			if err := applyLegacyPriceOverride(c, raw, time.Now().UnixMilli()); err != nil {
				return err
			}
		}
		err = a.legacyPublishCatalog(r, actor, "/api/admin/settings", "保存运营设置", c, revision, display)
		if err == nil {
			return nil
		}
		var rejected assets.Rejection
		if errors.As(err, &rejected) {
			if string(rejected) != "catalog_revision_changed" {
				return err
			}
			continue
		}
		if !errors.Is(err, assets.ErrUnavailable) {
			return err
		}
		time.Sleep(25 * time.Millisecond)
	}
	return assets.ErrUnavailable
}

func rawBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return false, false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	return value, true
}

func (a *API) legacyAdminMallConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		RefreshTime string            `json:"refreshTime"`
		Items       []json.RawMessage `json:"items"`
		Reset       bool              `json:"reset"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, revision, err := catalog.Current(r.Context(), a.pool)
	if err != nil {
		failure(w, err)
		return
	}
	if in.Reset {
		defaults, defaultErr := rules.Default()
		if defaultErr != nil {
			failure(w, identity.ErrInvalid)
			return
		}
		cfg := defaults.MallConfig()
		if err := legacyCatalogDefault(c, "mall", cfg); err != nil {
			failure(w, identity.ErrInvalid)
			return
		}
		if err := a.legacyPublishCatalog(r, actor, "/api/admin/mall/config", "恢复商城配置", c, revision, nil); err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "mallCfg": cfg})
		return
	}
	cfg := c.MallConfig()
	if strings.TrimSpace(in.RefreshTime) != "" {
		if _, _, valid := rules.ParseRefreshTime(in.RefreshTime); !valid {
			legacyTradeError(w, 400, "刷新时间格式应为 HH:MM（如 04:00）")
			return
		}
		cfg.RefreshTime = strings.TrimSpace(in.RefreshTime)
	}
	if in.Items != nil {
		if len(in.Items) > 100 {
			legacyTradeError(w, 400, "商品数量过多")
			return
		}
		items := make([]rules.MallItem, 0, len(in.Items))
		for _, raw := range in.Items {
			var item rules.MallItem
			if json.Unmarshal(raw, &item) != nil || item.ID == "" || item.Price < 0 || item.Limit < 0 || item.Limit > mall.MaxPurchaseQuantity {
				legacyTradeError(w, 400, "商品配置格式错误")
				return
			}
			if _, exists := c.Item(item.ID); !exists {
				legacyTradeError(w, 400, "未知商品："+item.ID)
				return
			}
			items = append(items, item)
		}
		cfg.Items = items
	}
	if err := legacyCatalogDefault(c, "mall", cfg); err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	if err := a.legacyPublishCatalog(r, actor, "/api/admin/mall/config", "保存商城配置", c, revision, nil); err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "mallCfg": cfg})
}

func (a *API) legacyAdminRecordsConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Scale *float64 `json:"scale"`
		X     *float64 `json:"x"`
		Y     *float64 `json:"y"`
		Reset bool     `json:"reset"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Reset {
		cfg := map[string]any{"scale": 175, "x": 0, "y": 0}
		if err := a.legacyAdminConfigWrite(w, r, actor, legacyRecordsSetting, "records/config", cfg, false, "", "恢复纪录贴图配置"); err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "recordsCfg": cfg})
		return
	}
	if in.Scale == nil || in.X == nil || in.Y == nil || *in.Scale < 50 || *in.Scale > 500 || *in.X < -400 || *in.X > 400 || *in.Y < -400 || *in.Y > 400 || math.IsNaN(*in.Scale) || math.IsNaN(*in.X) || math.IsNaN(*in.Y) {
		legacyTradeError(w, 400, "纪录贴图参数无效")
		return
	}
	cfg := map[string]any{"scale": math.Round(*in.Scale), "x": math.Round(*in.X), "y": math.Round(*in.Y)}
	if err := a.legacyAdminConfigWrite(w, r, actor, legacyRecordsSetting, "records/config", cfg, false, "", "保存纪录贴图配置"); err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "recordsCfg": cfg})
}

func (a *API) legacyAdminSettings(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in map[string]json.RawMessage
	if !decode(w, r, &in) {
		return
	}
	var validateOnly bool
	if raw, exists := in["validateOnly"]; exists && json.Unmarshal(raw, &validateOnly) != nil {
		legacyTradeError(w, 400, "校验标志必须为布尔值")
		return
	}
	delete(in, "token")
	delete(in, "validateOnly")
	preview, validationErr := validateLegacySettings(in)
	if validationErr != nil {
		legacyTradeError(w, 400, validationErr.Error())
		return
	}
	if raw, exists := in["seaCfg"]; exists {
		c, err := a.catalog(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		if err = applySeaSettings(c, raw); err != nil {
			failure(w, err)
			return
		}
	}
	if len(in) == 0 {
		write(w, 200, map[string]any{"ok": true})
		return
	}
	if raw, exists := in["notifyLevel"]; exists {
		var level string
		if json.Unmarshal(raw, &level) != nil || map[string]bool{
			"all": true, "uncommon": true, "offrange": true, "records": true, "none": true,
			"rare": true, "off": true,
		}[level] == false {
			legacyTradeError(w, 400, "未知的通知等级")
			return
		}
	}
	if raw, exists := in["autoSellCfg"]; exists {
		var cfg struct {
			Batch int `json:"batch"`
		}
		if json.Unmarshal(raw, &cfg) != nil || cfg.Batch < 1 || cfg.Batch > 10000 {
			legacyTradeError(w, 400, "自动售出打包阈值需在 1 - 10000 之间")
			return
		}
	}
	if raw, exists := in["chestCfg"]; exists && json.Valid(raw) == false {
		legacyTradeError(w, 400, "宝匣配置格式错误")
		return
	}
	for key, bounds := range map[string][2]float64{"rareK": {0, 100000}, "doubleBase": {0, 1}} {
		if raw, exists := in[key]; exists {
			value, valid := legacyNumber(raw, bounds[0], bounds[1])
			if key == "rareK" && value <= 0 {
				valid = false
			}
			if !valid {
				legacyTradeError(w, 400, key+" 配置数值无效")
				return
			}
			in[key], _ = json.Marshal(value)
		}
	}
	if !validateOnly {
		if err := a.legacyAdminSettingsWrite(r, actor, in); err != nil {
			failure(w, err)
			return
		}
	}
	out := map[string]any{"ok": true}
	if validateOnly {
		for key, raw := range in {
			if key == "evalVars" {
				continue
			}
			var value any
			if json.Unmarshal(raw, &value) == nil {
				out[key] = value
			}
		}
		for key, value := range preview {
			out[key] = value
		}
	} else {
		c, err := a.catalog(r.Context())
		if err != nil {
			failure(w, err)
			return
		}
		fields, _, err := legacyCatalogProjection(c)
		if err != nil {
			failure(w, err)
			return
		}
		for key, value := range fields {
			out[key] = value
		}
		cast := c.CastRules(nil)
		out["castBaseMs"], out["castMinMs"] = cast.BaseMS, cast.MinMS
		out["castSpeedBonus"], out["castSpeedCap"], out["castFormula"] = cast.SpeedBonus, cast.SpeedCap, cast.Formula
		out["biteFormula"] = cast.BiteFormula
		out["rareK"], out["doubleBase"] = c.DefaultLootConfig().RareK, float64(0)
		if value, exists := c.Runtime["doubleBase"]; exists {
			out["doubleBase"] = value
		}
		out["seaCfg"] = c.SeaConfig()
		stored, _ := a.legacyStoredConfig(r.Context())
		applyLegacyStoredConfig(out, stored)
	}
	write(w, 200, out)
}
