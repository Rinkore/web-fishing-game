package migration

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"

	"fishing.local/server/internal/modules/catalog"
)

type realResumeSpot struct {
	owner        int64
	ground, spot string
}

func planRealResume(rc *RealContext, accounts []RealAccount) ([]realResumeSpot, error) {
	out := []realResumeSpot{}
	for _, a := range accounts {
		last, ok := a.Payload["lastFishing"].(map[string]any)
		if !ok || len(last) == 0 {
			continue
		}
		ground, spot := stringValue(last, "groundId"), stringValue(last, "spotId")
		g, s, exists := rc.Catalog.FishingSpot(ground, spot)
		// Removed source locations were forgotten on reconnect by the old
		// server. Their original lastFishing object remains in the source ledger.
		if !exists || g.Locked || s.Locked {
			continue
		}
		owner := rc.IDs[strings.ToLower(a.Key)]
		if owner <= 0 {
			return nil, errors.New("resume owner missing")
		}
		out = append(out, realResumeSpot{owner, ground, spot})
	}
	return out, nil
}

// ImportRealResume records an intention to resume, never an active fishing
// lease. A fresh seed and sequence ensure no historical due time can grant
// offline catches. Stream.open revalidates access and schedules a full cast.
func ImportRealResume(ctx context.Context, rc *RealContext, accounts []RealAccount) error {
	rows, err := planRealResume(rc, accounts)
	if err != nil {
		return err
	}
	for _, r := range rows {
		seed := make([]byte, 32)
		if _, err := rand.Read(seed); err != nil {
			return err
		}
		if _, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.native_fishing_sessions(owner_id,generation,next_seq,connection_generation,state,ground_id,spot_id,rule_version,private_seed,loadout_rev,due_at,resume_enabled) SELECT account_id,1,1,1,'paused',$2,$3,$4,$5,loadout_rev,$6,true FROM fishing.player_state WHERE account_id=$1`, r.owner, r.ground, r.spot, catalog.Version(rc.Catalog), seed, rc.Now); err != nil {
			return err
		}
	}
	return nil
}

func ReconcileRealResume(ctx context.Context, rc *RealContext, accounts []RealAccount) error {
	want, err := planRealResume(rc, accounts)
	if err != nil {
		return err
	}
	var total int
	if err = rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.native_fishing_sessions`).Scan(&total); err != nil {
		return err
	}
	if total != len(want) {
		return errors.New("resume session count mismatch")
	}
	for _, r := range want {
		var valid bool
		var due time.Time
		if err = rc.Tx.QueryRow(ctx, `SELECT n.state='paused' AND n.resume_enabled AND n.ground_id=$2 AND n.spot_id=$3 AND n.generation=1 AND n.next_seq=1 AND n.connection_generation=1 AND n.rule_version=$4 AND octet_length(n.private_seed)=32 AND n.loadout_rev=p.loadout_rev AND NOT EXISTS(SELECT 1 FROM fishing.fishing_connections f WHERE f.owner_id=n.owner_id) AND NOT EXISTS(SELECT 1 FROM fishing.gateway_streams g WHERE g.owner_id=n.owner_id),n.due_at FROM fishing.native_fishing_sessions n JOIN fishing.player_state p ON p.account_id=n.owner_id WHERE n.owner_id=$1`, r.owner, r.ground, r.spot, catalog.Version(rc.Catalog)).Scan(&valid, &due); err != nil {
			return err
		}
		if !valid {
			return errors.New("resume session state mismatch")
		}
	}
	if err = rc.Tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM fishing.native_fishing_settlements)+(SELECT count(*) FROM fishing.catch_continuations)`).Scan(&total); err != nil {
		return err
	}
	if total != 0 {
		return errors.New("unexpected historical fishing settlement")
	}
	return nil
}
