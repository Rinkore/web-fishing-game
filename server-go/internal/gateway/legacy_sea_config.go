package gateway

import (
	"encoding/json"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
)

// The existing console sends seaCfg in its settings payload. Publish that
// payload into the same catalog read by voyages, quests and fishing workers.
func applySeaSettings(c *rules.Catalog, raw json.RawMessage) error {
	var patch map[string]map[string]any
	if json.Unmarshal(raw, &patch) != nil || patch == nil {
		return identity.ErrInvalid
	}
	if len(patch) == 0 {
		base, err := rules.Default()
		if err != nil {
			return err
		}
		c.Constants["SEA"] = base.Constants["SEA"]
		c.Constants["SHIP"] = base.Constants["SHIP"]
		return nil
	}
	for k := range patch {
		if k != "ship" && k != "sea" {
			return identity.ErrInvalid
		}
	}
	for section, change := range patch {
		constant := "SEA"
		if section == "ship" {
			constant = "SHIP"
		}
		base := legacyConstantMap(c, constant)
		for k, v := range change {
			if section == "ship" && k == "names" {
				names, ok := v.([]any)
				levels, good := base["levels"].([]any)
				if !ok || !good || len(names) != len(levels) {
					return identity.ErrInvalid
				}
				for i, n := range names {
					if n == nil {
						continue
					}
					s, ok := n.(string)
					if !ok || len([]rune(s)) < 1 || len([]rune(s)) > 12 {
						return identity.ErrInvalid
					}
					levels[i].(map[string]any)["name"] = s
				}
				continue
			}
			if section == "sea" && k == "zoneTtlMin" {
				n, ok := v.(float64)
				if !ok || n < 5 || n > 1440 {
					return identity.ErrInvalid
				}
				base["zoneTtlMs"] = n * 60000
				continue
			}
			if _, exists := base[k]; !exists {
				return identity.ErrInvalid
			}
			if obj, ok := v.(map[string]any); ok {
				prior, good := base[k].(map[string]any)
				if !good {
					return identity.ErrInvalid
				}
				for field, val := range obj {
					prior[field] = val
				}
			} else {
				base[k] = v
			}
		}
		var err error
		c.Constants[constant], err = json.Marshal(base)
		if err != nil {
			return identity.ErrInvalid
		}
	}
	rawCatalog, _ := json.Marshal(c)
	candidate, err := rules.DecodeCatalog(rawCatalog)
	if err != nil || rules.ValidateCatalog(candidate) != nil {
		return identity.ErrInvalid
	}
	cfg := candidate.SeaConfig()
	if cfg.Anchor.Coins < 0 || cfg.Anchor.Scales < 0 || cfg.Anchor.MaxTimes < 0 || cfg.Anchor.ExtendMin < 5 || cfg.Anchor.ExtendMin > 10080 {
		return identity.ErrInvalid
	}
	for _, q := range cfg.Quests {
		if q.Reward.Coins > 1e12 {
			return identity.ErrInvalid
		}
		for id, n := range q.Reward.Items {
			it, ok := candidate.Item(id)
			if !ok || n < 1 || n > 1000000 || (it.Kind != "material" && it.Kind != "chest") {
				return identity.ErrInvalid
			}
		}
		if q.Kind == "submit" {
			if q.Submit == nil || q.Submit.Count < 1 {
				return identity.ErrInvalid
			}
			it, ok := candidate.Item(q.Submit.ID)
			if !ok || (it.Kind != "material" && it.Kind != "chest") {
				return identity.ErrInvalid
			}
		}
	}
	return nil
}
