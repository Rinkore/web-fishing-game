package gateway

import (
	"encoding/json"
	"errors"
	"sync"

	"fishing.local/server/internal/rules"
)

type applicationVersionInfo struct {
	Version string
	Build   string
}

// Client reloads follow the installed application. Operator-published gameplay
// catalogs can intentionally retain an older version and must not be rewritten
// just to deploy a new binary or frontend.
var applicationVersion = sync.OnceValues(func() (applicationVersionInfo, error) {
	c, err := rules.Default()
	if err != nil {
		return applicationVersionInfo{}, err
	}
	var release applicationVersionInfo
	if err := json.Unmarshal(c.Constants["VERSION"], &release.Version); err != nil {
		return applicationVersionInfo{}, err
	}
	if release.Version == "" {
		return applicationVersionInfo{}, errors.New("missing application version")
	}
	_ = json.Unmarshal(c.Constants["BUILD"], &release.Build)
	return release, nil
})
