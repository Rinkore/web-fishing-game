package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/operations"
	"github.com/jackc/pgx/v5"
)

// legacyBdSet bridges /api/bd/set. The legacy client sends a component
// signature (compId); the durable rod module consumes an equipment instance
// id, so this resolves the first free inventory instance of that signature.
func (a *API) legacyBdSet(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		Part   string `json:"part"`
		CompID string `json:"compId"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !a.legacyRodFeature(w, r.Context(), "bd.equip") {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	var equipmentID int64
	if in.CompID != "" {
		base, _, _, ok := c.Instance(in.CompID)
		if !ok || base.Part != in.Part {
			failure(w, identity.ErrInvalid)
			return
		}
		equipmentID, err = a.freeEquipmentInstance(r.Context(), session.AccountID, in.Part, in.CompID)
		if err != nil {
			failure(w, identity.ErrInvalid)
			return
		}
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := assets.New(a.pool).ChangeRod(ctx, assets.RodCommand{ActorID: session.AccountID, RequestKey: "legacy:bd:" + strconv.FormatInt(time.Now().UnixMilli(), 10), Action: "equip", Part: in.Part, EquipmentID: equipmentID})
	if err != nil {
		failure(w, err)
		return
	}
	if res.Status != "rod_updated" {
		write(w, http.StatusBadRequest, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{
		"ok":            true,
		"bd":            profile["bd"],
		"inventory":     profile["inventory"],
		"invRev":        profile["invRev"],
		"rodSlots":      profile["rodSlots"],
		"rodLocked":     profile["rodLocked"],
		"rodActiveSlot": profile["rodActiveSlot"],
	})
}

// Rod sub-actions are independently switchable in the operator console. The
// native asset command predates those legacy sub-flags, so enforce an
// explicitly published false flag at the legacy boundary while preserving the
// enabled-by-default behavior for installations without a feature release.
func (a *API) legacyRodFeature(w http.ResponseWriter, ctx context.Context, key string) bool {
	features, err := operations.New(a.pool).Features(ctx)
	if err != nil {
		failure(w, err)
		return false
	}
	if enabled, exists := features.Flags[key]; exists && !enabled {
		write(w, http.StatusForbidden, map[string]any{"error": "feature_disabled", "code": "feature_disabled"})
		return false
	}
	return true
}

func (a *API) freeEquipmentInstance(ctx context.Context, owner int64, part, signature string) (int64, error) {
	var id int64
	err := a.pool.QueryRow(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND e.attributes->>'signature'=$2 AND e.part=$3
 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components rc WHERE rc.equipment_id=e.id)
 ORDER BY e.id LIMIT 1`, owner, signature, part).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, identity.ErrInvalid
	}
	return id, err
}
