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

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

const (
	legacyMallSetting    = "legacy:mall"
	legacySmeltSetting   = "legacy:smelt"
	legacyRecordsSetting = "legacy:records"
	legacySettingsKey    = "legacy:settings"
)

func (a *API) legacyStoredConfig(ctx context.Context) (map[string]any, string) {
	keys := []string{legacyMallSetting, legacySmeltSetting, legacyRecordsSetting, legacySettingsKey}
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
		values[key] = value
		joined = append(joined, key...)
		joined = append(joined, raw...)
	}
	digest := sha256.Sum256(joined)
	return values, hex.EncodeToString(digest[:])
}

func applyLegacyStoredConfig(fields map[string]any, values map[string]any) {
	if value, ok := values[legacyMallSetting]; ok {
		fields["mallCfg"] = value
	}
	if value, ok := values[legacySmeltSetting]; ok {
		fields["smeltCfg"] = value
	}
	if value, ok := values[legacyRecordsSetting]; ok {
		fields["recordsCfg"] = value
	}
	if settings, ok := values[legacySettingsKey].(map[string]any); ok {
		for _, key := range []string{"chestCfg", "autoSellCfg", "priceCfg", "dropCfg", "biteFormula", "notifyLevel", "castBaseMs", "castMinMs", "castSpeedBonus", "castSpeedCap", "castFormula"} {
			if value, exists := settings[key]; exists {
				fields[key] = value
			}
		}
	}
}

func legacyStoredConfigFrames(values map[string]any) []map[string]any {
	frames := []map[string]any{}
	if value, ok := values[legacyMallSetting]; ok {
		frames = append(frames, map[string]any{"type": "mallcfg", "mallCfg": value})
	}
	if value, ok := values[legacySmeltSetting]; ok {
		frames = append(frames, map[string]any{"type": "smeltcfg", "smeltCfg": value})
	}
	if value, ok := values[legacyRecordsSetting]; ok {
		frames = append(frames, map[string]any{"type": "recordscfg", "recordsCfg": value})
	}
	if settings, ok := values[legacySettingsKey].(map[string]any); ok {
		if value, exists := settings["chestCfg"]; exists {
			frames = append(frames, map[string]any{"type": "chestcfg", "chestCfg": value})
		}
		if value, exists := settings["autoSellCfg"]; exists {
			frames = append(frames, map[string]any{"type": "autosellcfg", "autoSellCfg": value})
		}
		castNames := map[string]string{"castBaseMs": "baseMs", "castMinMs": "minMs", "castSpeedBonus": "speedBonus", "castSpeedCap": "speedCap", "castFormula": "formula"}
		castFrame := map[string]any{"type": "castcfg"}
		castPresent := false
		for key, name := range castNames {
			if value, exists := settings[key]; exists {
				castFrame[name] = value
				castPresent = true
			}
		}
		if castPresent {
			frames = append(frames, castFrame)
		}
		if value, exists := settings["biteFormula"]; exists {
			frames = append(frames, map[string]any{"type": "bitecfg", "formula": value})
		}
		if price, priceOK := settings["priceCfg"]; priceOK {
			frame := map[string]any{"type": "pricecfg", "priceCfg": price}
			if drop, dropOK := settings["dropCfg"]; dropOK {
				frame["dropCfg"] = drop
			}
			frames = append(frames, frame)
		} else if drop, dropOK := settings["dropCfg"]; dropOK {
			frames = append(frames, map[string]any{"type": "pricecfg", "dropCfg": drop})
		}
	}
	return frames
}

func mergeLegacyWorkshopConfig(base *rules.WorkshopConfig, raw any) {
	baseRaw, _ := json.Marshal(base)
	overrideRaw, _ := json.Marshal(raw)
	var merged map[string]json.RawMessage
	_ = json.Unmarshal(baseRaw, &merged)
	var patch map[string]json.RawMessage
	if json.Unmarshal(overrideRaw, &patch) != nil {
		return
	}
	for key, value := range patch {
		merged[key] = value
	}
	encoded, _ := json.Marshal(merged)
	_ = json.Unmarshal(encoded, base)
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
	if json.Unmarshal(raw, &n) != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < min || n > max {
		return 0, false
	}
	return n, true
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

// legacyAdminSettingsWrite merges a partial settings patch inside the same
// transaction as the audit row. Reading the previous JSON in the HTTP handler
// would let two concurrent operators overwrite each other's unrelated keys.
func (a *API) legacyAdminSettingsWrite(r *http.Request, actor identity.Session, value any) error {
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return identity.ErrStorage
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := legacyAdminWriteGuard(ctx, tx, actor); err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return identity.ErrInvalid
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=fishing.operator_settings.value || excluded.value,updated_at=excluded.updated_at`, legacySettingsKey, raw); err != nil {
		return identity.ErrStorage
	}
	if err = legacyAdminAudit(ctx, tx, actor, "settings/update", nil, "", "保存运营设置"); err != nil {
		return identity.ErrStorage
	}
	if err = tx.Commit(ctx); err != nil {
		return identity.ErrCommitUnknown
	}
	return nil
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
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if in.Reset {
		cfg := c.MallConfig()
		if err := a.legacyAdminConfigWrite(w, r, actor, legacyMallSetting, "mall/config", cfg, false, "", "恢复商城配置"); err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "mallCfg": cfg})
		return
	}
	cfg := c.MallConfig()
	if raw, readErr := a.legacySettingRaw(r.Context(), legacyMallSetting); readErr == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &cfg)
	}
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
			if json.Unmarshal(raw, &item) != nil || item.ID == "" || item.Price < 0 || item.Limit < 0 || item.Limit > 100000 {
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
	if err := a.legacyAdminConfigWrite(w, r, actor, legacyMallSetting, "mall/config", cfg, false, "", "保存商城配置"); err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "mallCfg": cfg})
}

func (a *API) legacyAdminSmeltConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in map[string]json.RawMessage
	if !decode(w, r, &in) {
		return
	}
	reset := false
	if raw, exists := in["reset"]; exists {
		_ = json.Unmarshal(raw, &reset)
		delete(in, "reset")
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if reset {
		if err := a.legacyAdminConfigWrite(w, r, actor, legacySmeltSetting, "smelt/config", c.WorkshopConfig(), false, "", "恢复熔炼配置"); err != nil {
			failure(w, err)
			return
		}
		write(w, 200, map[string]any{"ok": true, "smeltCfg": c.WorkshopConfig()})
		return
	}
	var cfg map[string]any
	if raw, err := a.legacySettingRaw(r.Context(), legacySmeltSetting); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &cfg)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	// Keep the old endpoint's numeric knobs bounded; unknown keys are rejected
	// so a typo cannot silently create an ineffective operator setting.
	limits := map[string][2]float64{"baseRate": {0, 100}, "failPerMaterial": {-50, 50}, "extraRatePerMaterial": {0, 100}, "extraRatePearl": {0, 100}, "extraRateMax": {0, 100}, "rateMin": {0, 100}, "rateMax": {0, 100}, "goldBase": {0, 1e8}, "goldPerMaterial": {0, 1e7}, "goldPearl": {0, 1e8}, "maxMaterials": {0, 99}, "maxTypes": {0, 8}, "recastPearl": {0, 999}, "recastGold": {0, 1e8}, "retainMaxRelic": {0, 99}, "addAffixCap": {1, 6}}
	for key, raw := range in {
		if key == "retainFormula" {
			var value string
			if json.Unmarshal(raw, &value) != nil || len(value) > 500 {
				legacyTradeError(w, 400, "保留概率公式无效")
				return
			}
			cfg[key] = strings.TrimSpace(value)
			continue
		}
		if bounds, exists := limits[key]; exists {
			n, valid := legacyNumber(raw, bounds[0], bounds[1])
			if !valid {
				legacyTradeError(w, 400, "熔炼配置数值无效："+key)
				return
			}
			cfg[key] = math.Round(n*10) / 10
			continue
		}
		var boolean bool
		if (key == "pearlRollTwice" || key == "subRangeFromSub" || key == "addAnyAffix" || key == "addAffixExtraRange" || key == "forgeAnyAffix") && json.Unmarshal(raw, &boolean) == nil {
			cfg[key] = boolean
			continue
		}
		if key == "catalystRatio" {
			n, valid := legacyNumber(raw, 0, 200)
			if !valid {
				legacyTradeError(w, 400, "催化区间比例无效")
				return
			}
			cfg[key] = n
			continue
		}
		legacyTradeError(w, 400, "未知熔炼配置："+key)
		return
	}
	if err := a.legacyAdminConfigWrite(w, r, actor, legacySmeltSetting, "smelt/config", cfg, false, "", "保存熔炼配置"); err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "smeltCfg": cfg})
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
	if len(in) == 0 {
		write(w, 200, map[string]any{"ok": true})
		return
	}
	if raw, exists := in["notifyLevel"]; exists {
		var level string
		if json.Unmarshal(raw, &level) != nil || map[string]bool{"all": true, "uncommon": true, "rare": true, "off": true}[level] == false {
			legacyTradeError(w, 400, "未知的通知等级")
			return
		}
	}
	if raw, exists := in["autoSellCfg"]; exists {
		var cfg struct {
			Batch int `json:"batch"`
		}
		if json.Unmarshal(raw, &cfg) != nil || cfg.Batch < 1 || cfg.Batch > 1000 {
			legacyTradeError(w, 400, "自动售出打包阈值需在 1 - 1000 之间")
			return
		}
	}
	if raw, exists := in["chestCfg"]; exists && json.Valid(raw) == false {
		legacyTradeError(w, 400, "宝匣配置格式错误")
		return
	}
	for key, bounds := range map[string][2]float64{"rareK": {0, 1000}, "doubleBase": {0, 1}} {
		if raw, exists := in[key]; exists {
			if _, valid := legacyNumber(raw, bounds[0], bounds[1]); !valid {
				legacyTradeError(w, 400, key+" 配置数值无效")
				return
			}
		}
	}
	if !validateOnly {
		if err := a.legacyAdminSettingsWrite(r, actor, in); err != nil {
			failure(w, err)
			return
		}
	}
	out := map[string]any{"ok": true}
	for key, raw := range in {
		var value any
		if json.Unmarshal(raw, &value) == nil {
			out[key] = value
		}
	}
	write(w, 200, out)
}
