package rules

import (
	"encoding/json"
	"sync"
)

// builtinSections caches the constant and default names the embedded catalog
// ships. Only the names are cached so the completeness check stays a map lookup
// sweep: a release that already carries every section (the normal case) never
// decodes the built-in snapshot just to learn there is nothing to fill.
var builtinSections = struct {
	once      sync.Once
	constants []string
	defaults  []string
}{}

func builtinSectionNames() ([]string, []string) {
	builtinSections.once.Do(func() {
		base, err := Default()
		if err != nil {
			return
		}
		for name := range base.Constants {
			builtinSections.constants = append(builtinSections.constants, name)
		}
		for name := range base.Defaults {
			builtinSections.defaults = append(builtinSections.defaults, name)
		}
	})
	return builtinSections.constants, builtinSections.defaults
}

// FillMissingDefaults overlays the built-in value for every constant and
// default the release does not carry.
//
// A publication always writes the complete snapshot (ValidateCatalog rejects
// anything shorter), but a release published by an *older* binary cannot carry
// a section that did not exist yet: production kept serving the v0.23.4 release
// after v0.24.0 added HUT, so HutConfig() reported a zero value — every hut
// upgrade was rejected and the console projection panicked on the empty level
// curve. Filling exactly the absent names keeps such a release playable without
// asking an operator to republish first.
//
// Names the release does carry always win, so operator overrides and pinned
// retries keep their published snapshot. This is a read-time rescue, never a
// relaxation of publication validation.
func (c *Catalog) FillMissingDefaults() error {
	constants, defaults := builtinSectionNames()
	if !c.missingSection(constants, defaults) {
		return nil
	}
	base, err := Default()
	if err != nil {
		return err
	}
	if c.Constants == nil {
		c.Constants = map[string]json.RawMessage{}
	}
	if c.Defaults == nil {
		c.Defaults = map[string]json.RawMessage{}
	}
	for name, raw := range base.Constants {
		if len(c.Constants[name]) == 0 {
			c.Constants[name] = append(json.RawMessage(nil), raw...)
		}
	}
	for name, raw := range base.Defaults {
		if len(c.Defaults[name]) == 0 {
			c.Defaults[name] = append(json.RawMessage(nil), raw...)
		}
	}
	return nil
}

// missingSection reports whether the release lacks any built-in section.
func (c *Catalog) missingSection(constants, defaults []string) bool {
	for _, name := range constants {
		if len(c.Constants[name]) == 0 {
			return true
		}
	}
	for _, name := range defaults {
		if len(c.Defaults[name]) == 0 {
			return true
		}
	}
	return false
}
