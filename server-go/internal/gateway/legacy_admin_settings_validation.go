package gateway

import (
	"encoding/json"
	"errors"
	"math"
	"strings"

	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/rules"
)

func validateLegacySettings(in map[string]json.RawMessage) (map[string]any, error) {
	out := map[string]any{}
	for key, raw := range in {
		switch key {
		case "notifyLevel", "seaCfg", "rareK", "doubleBase", "autoSellCfg", "priceOv", "evalVars":
		case "chestCfg":
			var cfg map[string]json.RawMessage
			if json.Unmarshal(raw, &cfg) != nil || cfg == nil {
				return nil, errors.New("宝匣配置必须为对象")
			}
			for field, value := range cfg {
				switch field {
				case "pityN":
					var n float64
					if string(value) == "null" || json.Unmarshal(value, &n) != nil || n < 0 || n > 50 || n != math.Trunc(n) {
						return nil, errors.New("保底次数需为0~50整数")
					}
				case "costs":
					var costs map[string]json.RawMessage
					if json.Unmarshal(value, &costs) != nil || costs == nil {
						return nil, errors.New("宝匣成本必须为对象")
					}
					defaults, err := rules.Default()
					if err != nil {
						return nil, err
					}
					for id, cost := range costs {
						if _, ok := defaults.Chest(id); !ok {
							return nil, errors.New("未知宝匣")
						}
						if err := validateLegacyNumericMap(cost, map[string][2]float64{"costRelic": {0, 9999}, "costCoins": {0, 100000000}}, false); err != nil {
							return nil, errors.New("宝匣成本无效")
						}
						var numbers map[string]float64
						_ = json.Unmarshal(cost, &numbers)
						for _, n := range numbers {
							if n != math.Trunc(n) {
								return nil, errors.New("宝匣成本需为整数")
							}
						}
					}
				default:
					return nil, errors.New("未知宝匣配置")
				}
			}
		case "autoNotify":
			if _, err := operations.ParseAutoNotify(raw, operations.DefaultAutoNotify()); err != nil {
				return nil, errors.New("自动通知规则无效")
			}
		case "resetPriceCfg", "resetDropCfg", "resetCastSpeed":
			if _, ok := rawBool(raw); !ok {
				return nil, errors.New("重置标志必须为布尔值")
			}
		case "castBaseMs", "castMinMs", "castSpeedBonus", "castSpeedCap":
			bounds := map[string][2]float64{"castBaseMs": {200, 3600000}, "castMinMs": {100, 3600000}, "castSpeedBonus": {-100, 500}, "castSpeedCap": {0, 10000}}[key]
			n, ok := legacyNumber(raw, bounds[0], bounds[1])
			if !ok {
				return nil, errors.New("抛竿配置数值无效：" + key)
			}
			in[key], _ = json.Marshal(n)
		case "castFormula", "biteFormula":
			var source string
			if json.Unmarshal(raw, &source) != nil {
				return nil, errors.New("公式格式无效")
			}
			source = strings.TrimSpace(source)
			expression, err := rules.Compile(source, rules.SimulationVariables)
			if err != nil {
				return nil, errors.New("公式无效：请检查语法、函数与变量名")
			}
			in[key], _ = json.Marshal(source)
			if key == "biteFormula" && len(in["evalVars"]) > 0 {
				var input map[string]json.RawMessage
				if json.Unmarshal(in["evalVars"], &input) != nil || input == nil {
					return nil, errors.New("试算变量无效")
				}
				vars := map[string]float64{}
				for _, name := range rules.SimulationVariables {
					vars[name] = 0
					if value, exists := input[name]; exists {
						n, ok := legacyNumber(value, -1e12, 1e12)
						if !ok {
							return nil, errors.New("试算变量无效：" + name)
						}
						vars[name] = n
						delete(input, name)
					}
				}
				if len(input) > 0 {
					return nil, errors.New("试算包含未知变量")
				}
				prob := expression.Eval(vars)
				if math.IsNaN(prob) || math.IsInf(prob, 0) {
					return nil, errors.New("试算结果不是有限数字")
				}
				out["prob"] = math.Max(0, math.Min(100, prob))
			}
		case "dropCfg":
			bounds := map[string][2]float64{"global": {0, 10000}, "common": {0, 10000}, "big": {0, 10000}, "rare": {0, 10000}, "material": {0, 10000}}
			if err := validateLegacyNumericMap(raw, bounds, false); err != nil {
				return nil, errors.New("产出倍率无效：" + err.Error())
			}
		case "priceCfg":
			bounds := map[string][2]float64{"saleDivisor": {.001, .05}, "riseTauMin": {5, 1440}, "floorPct": {10, 100}, "ceilPct": {100, 500}, "riseTargetPct": {100, 300}, "sampleSec": {5, 3600}, "historyMin": {10, 10080}}
			if err := validateLegacyNumericMap(raw, bounds, true); err != nil {
				return nil, errors.New("价格参数无效：" + err.Error())
			}
		default:
			return nil, errors.New("未知运营设置：" + key)
		}
	}
	if _, exists := in["evalVars"]; exists && len(in["biteFormula"]) == 0 {
		return nil, errors.New("试算需要提供上钩公式")
	}
	return out, nil
}

func validateLegacyNumericMap(raw json.RawMessage, bounds map[string][2]float64, withTiers bool) error {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil || values == nil {
		return errors.New("配置必须为对象")
	}
	for key, value := range values {
		if withTiers && key == "tiers" {
			var tiers map[string]json.RawMessage
			if json.Unmarshal(value, &tiers) != nil || tiers == nil {
				return errors.New("品质覆盖必须为对象")
			}
			for tier, patch := range tiers {
				if tier != "common" && tier != "big" && tier != "rare" {
					return errors.New("未知品质")
				}
				if err := validateLegacyNumericMap(patch, map[string][2]float64{"saleDivisor": {.001, .05}, "riseTauMin": {5, 1440}}, false); err != nil {
					return err
				}
			}
			continue
		}
		limit, known := bounds[key]
		var n float64
		if !known || string(value) == "null" || json.Unmarshal(value, &n) != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < limit[0] || n > limit[1] {
			return errors.New(key)
		}
	}
	if withTiers {
		floor, ceil := 40.0, 200.0
		if raw, ok := values["floorPct"]; ok {
			_ = json.Unmarshal(raw, &floor)
		}
		if raw, ok := values["ceilPct"]; ok {
			_ = json.Unmarshal(raw, &ceil)
		}
		if floor >= ceil {
			return errors.New("价格下限必须低于上限")
		}
	}
	return nil
}

func legacyEffectivePriceConfig(c *rules.Catalog) map[string]any {
	d := c.PriceDynamicsFor("")
	out := map[string]any{"saleDivisor": d.SaleDivisor, "riseTauMin": d.RiseTauMin, "floorPct": d.Floor * 100, "ceilPct": d.Ceil * 100, "riseTargetPct": d.Target * 100, "sampleSec": 60, "historyMin": 360, "tiers": map[string]any{}}
	if raw, ok := c.Runtime["price"].(map[string]any); ok {
		for _, key := range []string{"sampleSec", "historyMin"} {
			if value, exists := raw[key]; exists {
				out[key] = value
			}
		}
		if tiers, ok := raw["tiers"].(map[string]any); ok {
			effective := map[string]any{}
			for tier := range tiers {
				for _, item := range c.Items {
					if c.FishTier(item.ID) == tier {
						dynamics := c.PriceDynamicsFor(item.ID)
						effective[tier] = map[string]any{"saleDivisor": dynamics.SaleDivisor, "riseTauMin": dynamics.RiseTauMin}
						break
					}
				}
			}
			out["tiers"] = effective
		}
	}
	return out
}
