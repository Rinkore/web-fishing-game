package sea

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

type FishingAccess struct {
	Spot        rules.FishingSpot
	GroundName  string
	Ocean, Zone bool
	Mood        string
	PartyCount  int
}

// ResolveFishing runs under the fisher's player guard. The shared topology
// lock serializes permission checks with leaving/kicking without locking a
// second player in reverse order. Zone locks serialize anchors with this cast.
func (s *Service) ResolveFishing(ctx context.Context, t *assets.Transaction, owner int64, ground, spot string) (FishingAccess, error) {
	v := FishingAccess{PartyCount: 1}
	if strings.HasPrefix(ground, "sea:") {
		parts := strings.Split(ground, ":")
		if len(parts) != 3 {
			return v, assets.Rejection("unknown_spot")
		}
		zoneOwner, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || zoneOwner <= 0 {
			return v, assets.Rejection("unknown_spot")
		}
		if _, err = t.SQL().Exec(ctx, `SELECT singleton FROM fishing.party_guard WHERE singleton FOR SHARE`); err != nil {
			return v, err
		}
		var allowed bool
		err = t.SQL().QueryRow(ctx, `SELECT $1::bigint=$2::bigint OR EXISTS(SELECT 1 FROM fishing.party_members a JOIN fishing.party_members b ON a.party_id=b.party_id JOIN fishing.parties p ON p.id=a.party_id AND p.active WHERE a.owner_id=$1 AND b.owner_id=$2)`, owner, zoneOwner).Scan(&allowed)
		if err != nil {
			return v, err
		}
		if !allowed {
			return v, assets.Rejection("sea_membership_required")
		}
		var raw []byte
		err = t.SQL().QueryRow(ctx, `SELECT data FROM fishing.sea_zones WHERE owner_id=$1 AND id=$2 AND expires_at>clock_timestamp() FOR SHARE`, zoneOwner, parts[2]).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			return v, assets.Rejection("sea_zone_expired")
		}
		if err != nil {
			return v, err
		}
		var z rules.SeaZone
		if json.Unmarshal(raw, &z) != nil {
			return v, assets.ErrUnavailable
		}
		found := false
		for _, p := range z.Spots {
			if p.ID == spot {
				v.Spot = rules.FishingSpot{ID: p.ID, Name: p.Name, Map: "voyage", MinShip: 1, Pool: p.Pool}
				for _, b := range p.Buffs {
					v.Spot.Buffs = append(v.Spot.Buffs, rules.Buff{Type: b.Type, Value: b.Value})
				}
				found = true
				break
			}
		}
		if !found {
			return v, assets.Rejection("unknown_spot")
		}
		v.Ocean, v.Zone, v.Mood, v.GroundName = true, true, z.Mood, z.Name
	} else {
		g, p, ok := s.catalog.FishingSpot(ground, spot)
		if !ok {
			return v, assets.Rejection("unknown_spot")
		}
		if g.Locked || p.Locked || groundWindowClosed(s.catalog, ground, time.Now()) {
			return v, assets.Rejection("spot_locked")
		}
		v.Spot = p
		v.GroundName = g.Name
		v.Ocean = g.Type == "ocean" || g.ID == "ocean" || p.Map == "voyage"
	}
	if v.Ocean || v.Spot.MinShip > 0 {
		if err := t.RequireFeature(ctx, "sea"); err != nil {
			return v, err
		}
		ship, err := readState(ctx, t.SQL(), owner)
		if err != nil {
			return v, err
		}
		if ship.Level < v.Spot.MinShip {
			return v, assets.Rejection("ship_level_required")
		}
	}
	if v.Ocean {
		if _, err := t.SQL().Exec(ctx, `SELECT singleton FROM fishing.party_guard WHERE singleton FOR SHARE`); err != nil {
			return v, err
		}
		err := t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.party_members a JOIN fishing.party_members b ON a.party_id=b.party_id JOIN fishing.parties p ON p.id=a.party_id AND p.active JOIN fishing.native_fishing_sessions n ON n.owner_id=b.owner_id AND n.state='active' AND n.ground_id=$2 JOIN fishing.fishing_connections c ON c.owner_id=b.owner_id AND c.generation=n.connection_generation AND c.expires_at>clock_timestamp() WHERE a.owner_id=$1`, owner, ground).Scan(&v.PartyCount)
		if err != nil {
			return v, err
		}
	}
	return v, nil
}

// Ground windows are operator data layered into the JSON catalog. The rules
// Ground type intentionally keeps only gameplay fields, so inspect the raw
// object here and evaluate openFrom/openTo at action time. This prevents a
// session from remaining usable after an activity window expires without a
// republish.
func groundWindowClosed(c *rules.Catalog, id string, now time.Time) bool {
	var grounds []map[string]any
	if c == nil || c.Constant("GROUNDS", &grounds) != nil {
		return false
	}
	for _, g := range grounds {
		if value, _ := g["id"].(string); value != id {
			continue
		}
		if raw, ok := g["openFrom"]; ok {
			if ts, ok := catalogWindowTime(raw); ok && now.UnixMilli() < ts {
				return true
			}
		}
		if raw, ok := g["openTo"]; ok {
			if ts, ok := catalogWindowTime(raw); ok && now.UnixMilli() > ts {
				return true
			}
		}
		return false
	}
	return false
}

func catalogWindowTime(raw any) (int64, bool) {
	switch value := raw.(type) {
	case float64:
		if value == float64(int64(value)) {
			return int64(value), true
		}
	case int64:
		return value, true
	case json.Number:
		v, err := value.Int64()
		return v, err == nil
	}
	return 0, false
}

// CatchProgress counts successful primary catches, never school copies or
// bonus materials. All progression participates in the catch asset transaction.
func (s *Service) CatchProgress(ctx context.Context, t *assets.Transaction, owner int64, counts map[string]int64) (bool, error) {
	n := counts["catch_ocean"]
	if n == 0 {
		return false, nil
	}
	v, err := state(ctx, t, owner)
	if err != nil {
		return false, err
	}
	if v.Experience > assets.MaxCoins-n {
		return false, assets.ErrDeferred
	}
	seed := make([]byte, 32)
	if _, err = rand.Read(seed); err != nil {
		return false, err
	}
	if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.sea_quest_roots(owner_id,private_seed) VALUES($1,$2) ON CONFLICT DO NOTHING`, owner, seed); err != nil {
		return false, err
	}
	if err = t.SQL().QueryRow(ctx, `SELECT private_seed FROM fishing.sea_quest_roots WHERE owner_id=$1`, owner).Scan(&seed); err != nil {
		return false, err
	}
	b, err := s.board(ctx, t, owner, seed)
	if err != nil {
		return false, err
	}
	for i := range b.Selected {
		q := &b.Selected[i]
		tpl := s.template(q.ID)
		if !q.Claimed {
			q.Progress = min(tpl.Need, q.Progress+counts[tpl.Kind])
		}
	}
	if err = s.saveBoard(ctx, t, owner, b); err != nil {
		return false, err
	}
	var notified bool
	if err = t.SQL().QueryRow(ctx, `SELECT xp_notified FROM fishing.sea_players WHERE owner_id=$1`, owner).Scan(&notified); err != nil {
		return false, err
	}
	var cfg ShipConfig
	_ = s.catalog.Constant("SHIP", &cfg)
	ready := v.Level < 5 && len(cfg.XPNeed) > v.Level && cfg.XPNeed[v.Level] > 0 && v.Experience+n >= cfg.XPNeed[v.Level] && !notified
	if _, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_players SET experience=experience+$2,xp_notified=xp_notified OR $3 WHERE owner_id=$1`, owner, n, ready); err != nil {
		return false, err
	}
	_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.sea_progress_entries(operation_id,owner_id,field,delta,after_value) VALUES($1,$2,'experience',$3,$4)`, t.OperationID(), owner, n, v.Experience+n)
	return ready, err
}
