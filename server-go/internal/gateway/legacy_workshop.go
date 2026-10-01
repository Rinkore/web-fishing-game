package gateway

import (
	"strings"

	"fishing.local/server/internal/rules"
)

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
