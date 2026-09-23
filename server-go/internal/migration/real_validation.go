package migration

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ValidateRealDomains binds this importer to the audited source format. The
// retained migration ledger is not a substitute for a business-field mapper.
// Errors contain domain names only, never private object keys or values.
func ValidateRealDomains(root string) error {
	allowed := map[string]string{
		"config.json":      "features featureOrder groundCfg notifyLevel autoNotify biteFormula doubleBase componentCfg fishCfg bannerSeq banners bannerCfg feedbackCfg castCfg priceCfg dropCfg lootCfg chestCfg seaCfg mallCfg smeltCfg recordsCfg rareK autoSellCfg snapshotCfg fishingFormulaRevision fishingFormulaBackup wikiConfigRevision",
		"market.json":      "listingSeq listings marketSupply",
		"economy.json":     "shopSales priceLog tradeLog marketLog priceOv economyLog",
		"records.json":     "bigRecords smallRecords topCatches topSmall globalMax rank lastRec",
		"feedback.json":    "feedback feedbackMeta",
		"admin.json":       "adminLog",
		"stats.json":       "statMin statHour statPeak",
		"wiki-export.json": "format integrity foreignKeyViolations tables",
	}
	sources := map[string]map[string]any{}
	for file, fields := range allowed {
		m, err := rwRead(root, file)
		if err != nil {
			return errors.New("source_domain_unreadable")
		}
		if rvFields(m, fields) != nil {
			return fmt.Errorf("unmapped_fields_in_%s", file)
		}
		sources[file] = m
	}
	checks := []struct {
		name string
		fn   func(map[string]any) error
	}{
		{"config.json", rvConfig}, {"market.json", rvMarket}, {"economy.json", rvEconomy},
		{"feedback.json", rvFeedback}, {"admin.json", rvAdmin}, {"stats.json", rvStats}, {"records.json", rvRecords}, {"wiki-export.json", rvWiki},
	}
	for _, c := range checks {
		if err := c.fn(sources[c.name]); err != nil {
			return fmt.Errorf("invalid_or_unmapped_nested_fields_in_%s: %w", c.name, err)
		}
	}
	return nil
}

func rvOptionalFields(m map[string]any, key, allowed string) error {
	if value, exists := m[key]; exists {
		return rvFields(value, allowed)
	}
	return nil
}
func rvConfig(m map[string]any) error {
	objects := map[string]string{
		"features":             "market trade workshop chest mall sell autosell friends character feedback sea sea.anchor sea.chart sea.quest sea.upgrade sea.voyage adminBypass",
		"featureOrder":         "bd character feedback fishing ground inventory mall menu sea workshop",
		"autoNotify":           "holdCount hysteresisPct on rules",
		"componentCfg":         "adjectiveRules affixRanges countWeights extraAffixRanges qualityWeights rollModel",
		"fishCfg":              "sizeModel sizeWeights",
		"bannerCfg":            "blink blinkTitle catchLevel noticeColor",
		"feedbackCfg":          "cdHours skipCost",
		"castCfg":              "baseMs formula minMs speedBonus speedCap",
		"priceCfg":             "ceilPct floorPct historyMin riseTargetPct riseTauMin saleDivisor sampleSec tiers",
		"dropCfg":              "global common big rare material",
		"lootCfg":              "groups",
		"chestCfg":             "costs pityN",
		"seaCfg":               "sea ship",
		"mallCfg":              "items refreshTime",
		"smeltCfg":             "addAffixCap addAffixExtraRange addAnyAffix baseRate catalystRanges catalystRatio extraRateMax extraRatePearl extraRatePerMaterial failPerMaterial forgeAnyAffix goldBase goldPearl goldPerMaterial maxMaterials maxTypes pearlRollTwice rateMax rateMin recastGold recastMinValue recastPearl retainFormula retainMaxRelic subRangeFromSub",
		"recordsCfg":           "scale x y",
		"autoSellCfg":          "batch",
		"snapshotCfg":          "enabled intervalMin keep",
		"fishingFormulaBackup": "biteFormula castCfg revision",
		"groundCfg":            "custom customSpots grounds removed spotPos spots",
	}
	for key, fields := range objects {
		if err := rvOptionalFields(m, key, fields); err != nil {
			return err
		}
	}
	if notify := rwMap(m["autoNotify"]); notify != nil {
		if on, _ := notify["on"].(bool); on {
			return errors.New("active_auto_notify_requires_runtime_mapper")
		}
		if rules, ok := notify["rules"]; ok {
			if err := rvRows(rules, "level min", nil); err != nil {
				return err
			}
		}
	}
	if component := rwMap(m["componentCfg"]); component != nil {
		if rows, ok := component["adjectiveRules"]; ok {
			if err := rvRows(rows, "full name noNeg netMin", nil); err != nil {
				return err
			}
		}
	}
	if mall := rwMap(m["mallCfg"]); mall != nil {
		if rows, ok := mall["items"]; ok {
			if err := rvRows(rows, "id limit price", nil); err != nil {
				return err
			}
		}
	}
	if chests := rwMap(m["chestCfg"]); chests != nil {
		if costs, ok := chests["costs"]; ok {
			if err := rvMapValues(costs, func(r map[string]any) error { return rvFields(r, "costCoins costRelic") }); err != nil {
				return err
			}
		}
	}
	if sea := rwMap(m["seaCfg"]); sea != nil {
		if err := rvOptionalFields(sea, "ship", "names xpNeed upCoins upScale"); err != nil {
			return err
		}
		if err := rvOptionalFields(sea, "sea", "anchor chartCost events nightglow questResetHour quests zoneMax zoneTtlMin"); err != nil {
			return err
		}
		world := rwMap(sea["sea"])
		for key, fields := range map[string]string{"events": "bounty bountyDouble school storm whirlpool wreck", "anchor": "coins extendMin maxTimes scales", "nightglow": "on rare"} {
			if err := rvOptionalFields(world, key, fields); err != nil {
				return err
			}
		}
		if quests, ok := world["quests"]; ok {
			if err := rvRows(quests, "id kind need reward submit submitNeed title", func(r map[string]any) error {
				if err := rvOptionalFields(r, "submit", "id count"); err != nil {
					return err
				}
				return rvOptionalFields(r, "reward", "coins deepscale chartfrag items")
			}); err != nil {
				return err
			}
		}
	}
	if ground := rwMap(m["groundCfg"]); ground != nil {
		if rows, ok := ground["grounds"]; ok {
			if err := rvMapValues(rows, func(r map[string]any) error { return rvFields(r, "name desc locked type") }); err != nil {
				return err
			}
		}
		spotFields := "id name desc locked pool buffs intervalMs biteRate"
		if rows, ok := ground["spots"]; ok {
			if err := rvMapValues(rows, func(r map[string]any) error { return rvFields(r, spotFields) }); err != nil {
				return err
			}
		}
		if err := rvOptionalFields(ground, "removed", "grounds spots"); err != nil {
			return err
		}
		if rows, ok := ground["custom"]; ok {
			if err := rvRows(rows, "id name desc locked type spots", func(r map[string]any) error {
				if spots, ok := r["spots"]; ok {
					return rvRows(spots, spotFields, nil)
				}
				return nil
			}); err != nil {
				return err
			}
		}
		if rows, ok := ground["customSpots"]; ok {
			groups, valid := rows.(map[string]any)
			if !valid {
				return errors.New("custom_spot_map_required")
			}
			for _, spots := range groups {
				if err := rvRows(spots, spotFields, nil); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func rvMarket(m map[string]any) error {
	if rows, ok := m["listings"]; ok {
		if err := rvRows(rows, "expireAt hours id lid name price qty seller sellerName src supplyId t", nil); err != nil {
			return err
		}
	}
	if supply, ok := m["marketSupply"]; ok {
		if err := rvFields(supply, "batch created enabled error id intervalSeconds mode nextAt recipe refilling remaining remainingCounts target threshold"); err != nil {
			return err
		}
		s := rwMap(supply)
		if err := rvOptionalFields(s, "recipe", "affixMax affixMin counts hours mulMax mulMin part picks qtyMax qtyMin quality seller sellers"); err != nil {
			return err
		}
		if err := rvOptionalFields(s, "remainingCounts", "chest component fish material"); err != nil {
			return err
		}
	}
	return nil
}
func rvEconomy(m map[string]any) error {
	for key, fields := range map[string]string{"shopSales": "day lastTs m soldToday soldTotal", "priceOv": "base"} {
		if rows, ok := m[key]; ok {
			if err := rvMapValues(rows, func(r map[string]any) error { return rvFields(r, fields) }); err != nil {
				return err
			}
		}
	}
	for key, fields := range map[string]string{"priceLog": "p t", "tradeLog": "qty t unit who"} {
		if rows, ok := m[key]; ok {
			groups, valid := rows.(map[string]any)
			if !valid {
				return errors.New("economy_history_map_required")
			}
			for _, list := range groups {
				if err := rvRows(list, fields, nil); err != nil {
					return err
				}
			}
		}
	}
	for key, fields := range map[string]string{"marketLog": "buyer buyerName id name price qty seller sellerName t tax total", "economyLog": "t text who"} {
		if rows, ok := m[key]; ok {
			if err := rvRows(rows, fields, nil); err != nil {
				return err
			}
		}
	}
	return nil
}
func rvFields(value any, allowed string) error {
	m, ok := value.(map[string]any)
	if !ok {
		return errors.New("object_required")
	}
	known := map[string]bool{}
	for _, key := range strings.Fields(allowed) {
		known[key] = true
	}
	for key := range m {
		if !known[key] {
			return errors.New("unmapped_field")
		}
	}
	return nil
}
func rvRows(value any, allowed string, visit func(map[string]any) error) error {
	rows, ok := value.([]any)
	if !ok {
		return errors.New("array_required")
	}
	for i, row := range rows {
		if err := rvFields(row, allowed); err != nil {
			return fmt.Errorf("row_%d_%w", i, err)
		}
		if visit != nil {
			if err := visit(rwMap(row)); err != nil {
				return fmt.Errorf("row_%d_%w", i, err)
			}
		}
	}
	return nil
}
func rvNonnegativeFields(m map[string]any, fields string) error {
	for _, key := range strings.Fields(fields) {
		if _, err := realNonnegative(m[key], 0); err != nil {
			return errors.New("invalid_nonnegative_field")
		}
	}
	return nil
}
func rvMapValues(value any, visit func(map[string]any) error) error {
	m, ok := value.(map[string]any)
	if !ok {
		return errors.New("object_map_required")
	}
	for _, row := range m {
		r, ok := row.(map[string]any)
		if !ok {
			return errors.New("object_row_required")
		}
		if err := visit(r); err != nil {
			return err
		}
	}
	return nil
}
func rvFeedback(m map[string]any) error {
	if err := rvRows(m["feedback"], "id key name kind text version status t statusAt statusBy reward", func(r map[string]any) error {
		if reward := r["reward"]; reward != nil {
			return rvFields(reward, "coins note at by total")
		}
		return nil
	}); err != nil {
		return err
	}
	return rvMapValues(m["feedbackMeta"], func(r map[string]any) error { return rvFields(r, "lastAt nextAt") })
}
func rvAdmin(m map[string]any) error {
	return rvRows(m["adminLog"], "action detail key name t target", nil)
}
func rvStats(m map[string]any) error {
	counters := func(r map[string]any, fields string) error {
		if err := rvNonnegativeFields(r, fields); err != nil {
			return err
		}
		for _, key := range []string{"grounds", "spots", "gSum", "sSum"} {
			if raw, exists := r[key]; exists {
				counts, ok := raw.(map[string]any)
				if !ok {
					return errors.New("invalid_area_counters")
				}
				for _, value := range counts {
					if _, err := realNonnegative(value, 0); err != nil {
						return errors.New("invalid_area_counter")
					}
				}
			}
		}
		return nil
	}
	if err := rvRows(m["statMin"], "t online fishing listings trades users grounds spots", func(r map[string]any) error { return counters(r, "t online fishing listings trades users") }); err != nil {
		return err
	}
	if err := rvRows(m["statHour"], "t n oSum oMax fSum lSum trSum uLast gSum sSum", func(r map[string]any) error { return counters(r, "t n oSum oMax fSum lSum trSum uLast") }); err != nil {
		return err
	}
	if err := rvFields(m["statPeak"], "online t"); err != nil {
		return err
	}
	return rvNonnegativeFields(rwMap(m["statPeak"]), "online t")
}
func rvRecordRow(r map[string]any) error {
	if _, err := realOptionalFloat(r["size"]); err != nil || r["size"] == nil {
		return errors.New("invalid_record_size")
	}
	if _, err := realNonnegative(r["t"], 0); err != nil {
		return errors.New("invalid_record_timestamp")
	}
	if rwString(r["who"]) == "" {
		return errors.New("record_display_missing")
	}
	return nil
}
func rvRecords(m map[string]any) error {
	for _, key := range []string{"bigRecords", "smallRecords"} {
		if err := rvMapValues(m[key], func(r map[string]any) error {
			if err := rvFields(r, "id name size who t"); err != nil {
				return err
			}
			return rvRecordRow(r)
		}); err != nil {
			return err
		}
	}
	for _, key := range []string{"topCatches", "topSmall"} {
		groups, ok := m[key].(map[string]any)
		if !ok {
			return errors.New("record_map_required")
		}
		for _, rows := range groups {
			if err := rvRows(rows, "playerId size t who", rvRecordRow); err != nil {
				return err
			}
		}
	}
	if value := m["globalMax"]; value != nil {
		if err := rvFields(value, "id name size who t"); err != nil {
			return err
		}
		if err := rvRecordRow(rwMap(value)); err != nil {
			return err
		}
	}
	if value := m["lastRec"]; value != nil {
		if err := rvFields(value, "global id level name size t text who"); err != nil {
			return err
		}
	}
	if err := rvFields(m["rank"], "day week"); err != nil {
		return err
	}
	for _, periods := range rwMap(m["rank"]) {
		ps, ok := periods.(map[string]any)
		if !ok {
			return errors.New("rank_period_map_required")
		}
		for period, fish := range ps {
			if _, err := time.Parse("2006-01-02", period); err != nil {
				return errors.New("rank_period_invalid")
			}
			if err := rvMapValues(fish, func(pair map[string]any) error {
				if err := rvFields(pair, "big small"); err != nil {
					return err
				}
				for _, rows := range pair {
					if err := rvRows(rows, "playerId size t who", rvRecordRow); err != nil {
						return err
					}
				}
				return nil
			}); err != nil {
				return err
			}
		}
	}
	return nil
}
func rvWiki(m map[string]any) error {
	if rwInt(m["format"]) != 1 || rwString(m["integrity"]) != "ok" || rwInt(m["foreignKeyViolations"]) != 0 {
		return errors.New("wiki_integrity_gate_required")
	}
	if err := rvFields(m["tables"], "wiki_meta guides guide_sections updates guide_revisions"); err != nil {
		return err
	}
	tables := rwMap(m["tables"])
	if err := rvRows(tables["wiki_meta"], "key value", func(row map[string]any) error {
		switch rwString(row["key"]) {
		case "schema_version", "official_revision", "user_revision":
			return nil
		default:
			return errors.New("unknown_wiki_metadata")
		}
	}); err != nil {
		return err
	}
	stringArray := func(value any) error {
		var rows []any
		if json.Unmarshal([]byte(rwString(value)), &rows) != nil || rows == nil {
			return errors.New("wiki_string_array_required")
		}
		for _, v := range rows {
			if _, ok := v.(string); !ok {
				return errors.New("wiki_string_array_required")
			}
		}
		return nil
	}
	if err := rvRows(tables["guides"], "id kind status title category summary tags_json aliases_json author_key author_name submitted_at reviewed_at reviewed_by review_note deleted_at deleted_by delete_reason revision sort_order created_at updated_at", func(r map[string]any) error {
		if err := stringArray(r["tags_json"]); err != nil {
			return err
		}
		return stringArray(r["aliases_json"])
	}); err != nil {
		return err
	}
	if err := rvRows(tables["guide_sections"], "guide_id ord heading type text items_json", func(r map[string]any) error {
		if r["items_json"] == nil || rwString(r["items_json"]) == "null" {
			return nil
		}
		return stringArray(r["items_json"])
	}); err != nil {
		return err
	}
	if err := rvRows(tables["updates"], "id date title summary sort_order", nil); err != nil {
		return err
	}
	return rvRows(tables["guide_revisions"], "id guide_id revision action actor_key actor_name snapshot_json created_at", func(r map[string]any) error {
		var snapshot map[string]any
		if json.Unmarshal([]byte(rwString(r["snapshot_json"])), &snapshot) != nil || snapshot == nil {
			return errors.New("wiki_revision_snapshot_required")
		}
		return nil
	})
}
