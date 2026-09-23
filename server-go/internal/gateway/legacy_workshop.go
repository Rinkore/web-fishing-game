package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Legacy workshop bridge. The durable workshop module owns the persisted random
// intent and the atomic consume/create step; this bridge maps the data.js
// component signatures onto durable equipment ids and rebuilds the flat
// instanceMeta/materials/costs payload the original workshop UI renders.
//
// The UI picker never offers the same signature as both main and sub (each
// picker excludes the other side), which is also the only shape the durable
// module rejects when mainId == subId.

func legacyAffixLabels(c *rules.Catalog) map[string]string {
	labels := map[string]string{}
	_ = c.Constant("AFFIX_LABEL", &labels)
	return labels
}

// legacyComponentMeta mirrors data.js instanceMeta for one instance signature.
func legacyComponentMeta(c *rules.Catalog, signature string) map[string]any {
	meta, ok := c.ComponentMeta(signature)
	if !ok {
		return nil
	}
	qualities := map[string]rules.QualityMeta{}
	_ = c.Constant("QUALITY", &qualities)
	quality := qualities[meta.Quality]
	pool := []map[string]any{}
	for _, entry := range meta.Pool {
		pool = append(pool, map[string]any{"type": entry.Type, "min": entry.Min, "max": entry.Max})
	}
	affixes := []map[string]any{}
	hasExtra := false
	for _, affix := range meta.Affixes {
		var source any
		explicit := false
		if affix.Src != nil {
			source = *affix.Src
			explicit = affix.SrcExplicit
		}
		if affix.Extra {
			hasExtra = true
		}
		affixes = append(affixes, map[string]any{
			"type": affix.Type, "value": affix.Value, "extra": affix.Extra,
			"src": source, "srcExplicit": explicit,
		})
	}
	adjective := ""
	if meta.Name != meta.BaseName && strings.HasSuffix(meta.Name, " "+meta.BaseName) {
		adjective = strings.TrimSuffix(meta.Name, " "+meta.BaseName)
	}
	return map[string]any{
		"id": meta.ID, "kind": "component", "baseId": meta.BaseID, "baseName": meta.BaseName,
		"part": meta.Part, "quality": meta.Quality, "qualityName": meta.QualityName, "qualityCls": quality.Cls,
		"rarity": meta.Rarity, "rarityName": meta.RarityName, "affixes": affixes, "pool": pool,
		"maxAffixes": meta.MaxAffixes, "qualityCap": quality.Cap,
		"full": meta.Full, "isFull": meta.Full, "hasExtra": hasExtra,
		"breakthrough": len(meta.Affixes) > 3, "adjective": adjective,
		"name": meta.Name, "price": meta.Price, "size": nil,
	}
}

// legacyInstanceBySignature resolves a data.js component signature to the
// lowest-id loose equipment instance, matching /api/bd/set and the market.
func (a *API) legacyInstanceBySignature(ctx context.Context, owner int64, signature string, unboundOnly ...bool) (int64, error) {
	onlyFree := len(unboundOnly) > 0 && unboundOnly[0]
	var id int64
	err := a.pool.QueryRow(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND e.attributes->>'signature'=$2
 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components rc WHERE rc.equipment_id=e.id)
 AND (NOT $3::boolean OR NOT e.reward_bound) ORDER BY e.reward_bound DESC,e.bind_outputs DESC,e.id LIMIT 1`, owner, signature, onlyFree).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, assets.Rejection("equipment_unavailable")
	}
	return id, err
}

func legacyWorkshopError(w http.ResponseWriter, message string) {
	write(w, 400, map[string]any{"error": message, "code": "invalid_input"})
}

// legacyWorkshopStatus maps durable workshop rejections onto the original
// frontend's Chinese text.
func legacyWorkshopStatus(w http.ResponseWriter, status string) {
	switch status {
	case "equipment_unavailable":
		legacyWorkshopError(w, "背包中没有该组件（可能已锁定在钓竿上）")
	case "equipment_rules_missing":
		legacyWorkshopError(w, "组件数据缺失，请联系管理员")
	case "invalid_smelt_plan":
		legacyWorkshopError(w, "熔炼方案无效（请检查主副件词条、投料与残片数量）")
	case "invalid_recast_plan":
		legacyWorkshopError(w, "只有宝匣产出的神话组件可以重铸")
	case "invalid_forge_plan":
		legacyWorkshopError(w, "锻造方案无效（请选择组件与催化剂材料）")
	case "affix_capacity":
		legacyWorkshopError(w, "该组件词条已达上限")
	case "invalid_forge_affix":
		legacyWorkshopError(w, "当前锻造不允许新增该底材的池外词条")
	case "duplicate_affix":
		legacyWorkshopError(w, "该组件已经拥有这条词条")
	case "insufficient_funds":
		legacyWorkshopError(w, "金币不足")
	case "insufficient_items":
		legacyWorkshopError(w, "材料不足（请检查催化剂材料与残片数量）")
	case "feature_disabled":
		legacyWorkshopError(w, "该功能当前已关闭")
	default:
		legacyWorkshopError(w, status)
	}
}

// legacyWorkshop serves GET /api/workshop: the merged smelt config, catalyst
// materials, recast and relic-retention parameters.
func (a *API) legacyWorkshop(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if c.GearConfig().Enabled {
		write(w, http.StatusBadRequest, map[string]any{"error": "旧装备熔炼、重铸和锻造已停用，请使用装备成长", "code": "legacy_workshop_retired"})
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	inventory, _ := profile["inventory"].(map[string]int64)
	labels := legacyAffixLabels(c)
	cfg := c.WorkshopConfig()
	if raw, ok := profile["smeltCfg"]; ok {
		if encoded, marshalErr := json.Marshal(raw); marshalErr == nil {
			if json.Valid(encoded) {
				base := cfg
				mergeLegacyWorkshopConfig(&base, raw)
				cfg = base
			}
		}
	}
	materials := []map[string]any{}
	for _, id := range rules.SmeltMaterialIDs() {
		def, ok := c.Item(id)
		if !ok {
			continue
		}
		affix := rules.MaterialAffix(id)
		materials = append(materials, map[string]any{
			"id": id, "name": def.Name, "rarity": def.Rarity,
			"affix": affix, "affixName": labels[affix],
		})
	}
	var pearlID string
	_ = c.Constant("SMELT_PEARL", &pearlID)
	pearl, _ := c.Item(pearlID)
	var quality string
	_ = c.Constant("RECAST_QUALITY", &quality)
	qualities := map[string]rules.QualityMeta{}
	_ = c.Constant("QUALITY", &qualities)
	relic, _ := c.Item("relic")
	write(w, 200, map[string]any{
		"ok": true, "cfg": cfg, "materials": materials,
		"pearl":      map[string]any{"id": pearlID, "name": pearl.Name, "rarity": pearl.Rarity},
		"affixLabel": labels, "coins": profile["coins"],
		"recast": map[string]any{
			"quality": quality, "qualityName": qualities[quality].Name,
			"pearlId": pearlID, "pearlName": pearl.Name,
			"pearlBase": cfg.RecastPearl, "pearlHave": inventory[pearlID],
			"goldPerPearl": cfg.RecastGold, "minValue": cfg.RecastMinValue != 0,
		},
		"retain": map[string]any{
			"quality": quality, "qualityName": qualities[quality].Name,
			"relicId": "relic", "relicName": relic.Name,
			"max": cfg.RetainMaxRelic, "formula": cfg.RetainFormula,
			"per": cfg.RetainPerRelic(0), "protectAffix": true, "relicHave": inventory["relic"],
		},
	})
}

// legacyWorkshopSmelt serves POST /api/workshop/smelt.
func (a *API) legacyWorkshopSmelt(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		UnboundInputs bool             `json:"unboundInputs"`
		MainID        string           `json:"mainId"`
		SubID         string           `json:"subId"`
		MainAffix     string           `json:"mainAffix"`
		SubAffix      string           `json:"subAffix"`
		Materials     []rules.Material `json:"materials"`
		Pearl         *bool            `json:"pearl"`
		Relics        *int64           `json:"relics"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Materials) > 8 {
		legacyWorkshopError(w, "投料种类过多（最多 8 项）")
		return
	}
	for _, material := range in.Materials {
		if material.Quantity < 1 || material.Quantity > 99 {
			legacyWorkshopError(w, "物品格式错误")
			return
		}
	}
	if in.MainID == in.SubID {
		legacyWorkshopError(w, "主副件不能是同一件组件（请在同部位里再选一件）")
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if c.GearConfig().Enabled {
		write(w, http.StatusBadRequest, map[string]any{"error": "旧装备熔炼、重铸和锻造已停用，请使用装备成长", "code": "legacy_workshop_retired"})
		return
	}
	mainID, err := a.legacyInstanceBySignature(r.Context(), session.AccountID, in.MainID, in.UnboundInputs)
	if err != nil {
		legacyWorkshopError(w, "背包中没有该主组件")
		return
	}
	subID, err := a.legacyInstanceBySignature(r.Context(), session.AccountID, in.SubID, in.UnboundInputs)
	if err != nil {
		legacyWorkshopError(w, "背包中没有该副组件")
		return
	}
	pearl := in.Pearl != nil && *in.Pearl
	relics := int64(0)
	if in.Relics != nil {
		relics = *in.Relics
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Apply(ctx, workshop.Command{UnboundInputs: in.UnboundInputs,
		ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:workshop:smelt"), Action: "smelt",
		MainID: mainID, SubID: subID, MainAffix: in.MainAffix, SubAffix: in.SubAffix,
		Materials: in.Materials, Pearl: pearl, Relics: relics,
	})
	if err != nil {
		a.legacyMarketWriteFailure(w, err)
		return
	}
	if res.Status != "crafted" {
		legacyWorkshopStatus(w, res.Status)
		return
	}
	var out rules.SmeltOutcome
	if err := json.Unmarshal(res.Details, &out); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	// The plan echo is a pure function of the same inputs (no extra randomness),
	// so it can be recomputed here for the result dialog's copy.
	cfg, workshopCfg := c.ComponentConfig(), c.WorkshopConfig()
	plan, planErr := c.SmeltPlan(rules.SmeltInput{
		MainID: in.MainID, SubID: in.SubID, MainAffix: in.MainAffix, SubAffix: in.SubAffix,
		Materials: in.Materials, Pearl: pearl, Relics: relics,
	}, cfg, workshopCfg)
	if planErr != nil {
		failure(w, identity.ErrStorage)
		return
	}
	breakthrough := 0
	for _, affix := range plan.ExtraAffixes {
		if affix.Source == "bt" && affix.Explicit {
			breakthrough++
		}
	}
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	response := map[string]any{
		"ok": true, "success": out.Success, "extraOk": out.ExtraOK, "retainOk": out.RetainOK,
		"retained": out.Retained, "protectAffix": out.ProtectAffix, "removedAffix": out.RemovedAffix,
		"resultId": out.ResultID, "result": nil, "mainAfterId": out.MainAfterID, "mainAfter": nil,
		"mainId": in.MainID, "subId": in.SubID, "pearl": pearl, "rollBoundary": plan.Boundary,
		"rate": plan.Rate, "extraRate": plan.ExtraRate, "gold": plan.Gold, "extraType": plan.ExtraType,
		"relics": plan.Relics, "relicId": "relic", "retainChance": plan.RetainChance,
		"breakthrough": breakthrough, "perRelic": workshopCfg.RetainPerRelic(breakthrough),
		"retainFormula": workshopCfg.RetainFormula,
	}
	if out.ResultID != nil {
		response["result"] = legacyComponentMeta(c, *out.ResultID)
	}
	if out.MainAfterID != nil {
		response["mainAfter"] = legacyComponentMeta(c, *out.MainAfterID)
	}
	for key, value := range snapshot {
		response[key] = value
	}
	write(w, 200, response)
}

// legacyWorkshopRecast serves POST /api/workshop/recast.
func (a *API) legacyWorkshopRecast(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		UnboundInputs bool   `json:"unboundInputs"`
		ID            string `json:"id"`
		AffixIndex    *int   `json:"affixIndex"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if c.GearConfig().Enabled {
		write(w, http.StatusBadRequest, map[string]any{"error": "旧装备熔炼、重铸和锻造已停用，请使用装备成长", "code": "legacy_workshop_retired"})
		return
	}
	before, ok := c.ComponentMeta(in.ID)
	if !ok {
		legacyWorkshopError(w, "请选择一件已生成的组件")
		return
	}
	target := -1
	if in.AffixIndex != nil {
		if *in.AffixIndex < 0 {
			legacyWorkshopError(w, "指定的词条无效")
			return
		}
		if *in.AffixIndex >= len(before.Affixes) {
			legacyWorkshopError(w, "指定的词条不存在（该组件只有 "+strconv.Itoa(len(before.Affixes))+" 条词条）")
			return
		}
		target = *in.AffixIndex
	}
	equipmentID, err := a.legacyInstanceBySignature(r.Context(), session.AccountID, in.ID, in.UnboundInputs)
	if err != nil {
		legacyWorkshopError(w, "背包中没有该组件（可能已锁定在钓竿上）")
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Apply(ctx, workshop.Command{UnboundInputs: in.UnboundInputs,
		ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:workshop:recast"), Action: "recast",
		MainID: equipmentID, Target: target,
	})
	if err != nil {
		a.legacyMarketWriteFailure(w, err)
		return
	}
	if res.Status != "crafted" {
		legacyWorkshopStatus(w, res.Status)
		return
	}
	var details struct {
		Signature string  `json:"signature"`
		Pearls    int     `json:"pearls"`
		Gold      float64 `json:"gold"`
		Target    int     `json:"target"`
	}
	if err := json.Unmarshal(res.Details, &details); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	workshopCfg := c.WorkshopConfig()
	var pearlID string
	_ = c.Constant("SMELT_PEARL", &pearlID)
	pearl, _ := c.Item(pearlID)
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	inventory, _ := snapshot["inventory"].(map[string]int64)
	beforeAffixes := []map[string]any{}
	for _, affix := range before.Affixes {
		beforeAffixes = append(beforeAffixes, map[string]any{"type": affix.Type, "value": affix.Value})
	}
	extra := 0
	if details.Target >= 0 {
		extra = details.Target + 1
	}
	response := map[string]any{
		"ok": true, "changed": details.Signature != in.ID, "before": beforeAffixes,
		"item": legacyComponentMeta(c, details.Signature), "id": details.Signature, "target": details.Target,
		"gold": details.Gold, "pearlBase": workshopCfg.RecastPearl, "pearlExtra": extra, "pearlNeed": details.Pearls,
		"pearlId": pearlID, "pearlName": pearl.Name,
		"materials": []map[string]any{{"id": pearlID, "name": pearl.Name, "need": details.Pearls, "have": inventory[pearlID]}},
	}
	for key, value := range snapshot {
		response[key] = value
	}
	write(w, 200, response)
}

// legacyWorkshopForge serves POST /api/workshop/forge.
func (a *API) legacyWorkshopForge(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		UnboundInputs bool   `json:"unboundInputs"`
		ID            string `json:"id"`
		MaterialID    string `json:"materialId"`
		Pearl         *bool  `json:"pearl"`
	}
	if !decode(w, r, &in) {
		return
	}
	if rules.MaterialAffix(in.MaterialID) == "" {
		legacyWorkshopError(w, "请选择一种催化剂材料")
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	if c.GearConfig().Enabled {
		write(w, http.StatusBadRequest, map[string]any{"error": "旧装备熔炼、重铸和锻造已停用，请使用装备成长", "code": "legacy_workshop_retired"})
		return
	}
	base, _, _, ok := c.Instance(in.ID)
	if !ok {
		legacyWorkshopError(w, "请选择一件已生成的组件")
		return
	}
	equipmentID, err := a.legacyInstanceBySignature(r.Context(), session.AccountID, in.ID, in.UnboundInputs)
	if err != nil {
		legacyWorkshopError(w, "背包中没有该组件（可能已锁定在钓竿上）")
		return
	}
	pearl := in.Pearl != nil && *in.Pearl
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Apply(ctx, workshop.Command{UnboundInputs: in.UnboundInputs,
		ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:workshop:forge"), Action: "forge",
		MainID: equipmentID, MaterialID: in.MaterialID, Pearl: pearl,
	})
	if err != nil {
		a.legacyMarketWriteFailure(w, err)
		return
	}
	if res.Status != "crafted" {
		legacyWorkshopStatus(w, res.Status)
		return
	}
	var details struct {
		Signature string  `json:"signature"`
		Type      string  `json:"type"`
		Value     float64 `json:"value"`
		Source    string  `json:"src"`
	}
	if err := json.Unmarshal(res.Details, &details); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	workshopCfg := c.WorkshopConfig()
	span := c.CatalystRange(c.ComponentConfig(), workshopCfg, base.Part, details.Type, pearl)
	material, _ := c.Item(in.MaterialID)
	snapshot, err := a.legacyMarketSnapshot(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	inventory, _ := snapshot["inventory"].(map[string]int64)
	labels := legacyAffixLabels(c)
	response := map[string]any{
		"ok": true, "changed": true, "id": details.Signature,
		"item":     legacyComponentMeta(c, details.Signature),
		"material": map[string]any{"id": in.MaterialID, "name": material.Name, "need": 1, "have": inventory[in.MaterialID]},
		"pearl":    pearl,
		"affix": map[string]any{
			"type": details.Type, "name": labels[details.Type], "value": details.Value,
			"min": span[0], "max": span[1], "src": details.Source,
		},
	}
	for key, value := range snapshot {
		response[key] = value
	}
	write(w, 200, response)
}
