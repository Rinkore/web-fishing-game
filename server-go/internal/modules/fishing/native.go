package fishing

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NativeService implements catalog-default fishing through trusted internal
// commands. Runtime overrides and the legacy transport are separate work.
type NativeService struct {
	pool    *pgxpool.Pool
	assets  *assets.Service
	catalog *rules.Catalog
}

func NewNative(pool *pgxpool.Pool, catalog *rules.Catalog) *NativeService {
	return &NativeService{pool, assets.New(pool), catalog}
}
func (s *NativeService) version() string {
	return "catch-v1:" + s.catalog.Version + ":" + s.catalog.SourceSHA256
}

type NativeStart struct {
	ActorID                      int64
	RequestKey, GroundID, SpotID string
	ConnectionGeneration         int64
}

func (s *NativeService) spot(ground, spot string) (rules.FishingSpot, error) {
	g, p, ok := s.catalog.FishingSpot(ground, spot)
	if !ok {
		return p, assets.Rejection("unknown_spot")
	}
	if g.Locked || p.Locked {
		return p, assets.Rejection("spot_locked")
	}
	// Do not grant ocean or ship-gated access before sea events, experience and
	// membership validation are part of the same settlement.
	if g.Type == "ocean" || g.ID == "ocean" || p.Map == "voyage" || p.MinShip > 0 {
		return p, assets.Rejection("sea_fishing_pending")
	}
	return p, nil
}

func (s *NativeService) loadout(ctx context.Context, t *assets.Transaction, owner int64, spot rules.FishingSpot) (rules.Effects, rules.CastInfo, error) {
	rows, err := t.SQL().Query(ctx, `SELECT c.part,e.definition_id,e.attributes FROM fishing.rod_loadouts r JOIN fishing.rod_components c USING(owner_id,slot) JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE r.owner_id=$1 AND r.active ORDER BY c.part`, owner)
	if err != nil {
		return nil, rules.CastInfo{}, err
	}
	defer rows.Close()
	bd := map[string]struct {
		CompID string `json:"compId"`
	}{}
	for rows.Next() {
		var part, definition string
		var data []byte
		if err := rows.Scan(&part, &definition, &data); err != nil {
			return nil, rules.CastInfo{}, err
		}
		var a struct {
			Signature string `json:"signature"`
		}
		if json.Unmarshal(data, &a) != nil {
			return nil, rules.CastInfo{}, errors.New("invalid equipped attributes")
		}
		base, _, _, ok := s.catalog.Instance(a.Signature)
		if !ok || base.ID != definition || base.Part != part {
			return nil, rules.CastInfo{}, errors.New("invalid equipped signature")
		}
		bd[part] = struct {
			CompID string `json:"compId"`
		}{a.Signature}
	}
	if err := rows.Err(); err != nil {
		return nil, rules.CastInfo{}, err
	}
	rod := s.catalog.RodEffects(bd)
	eff, _ := rules.MergeEffects(rod, spot.Spot)
	return eff, s.catalog.CastRules(nil).Info(rod, spot.Spot), nil
}

func (s *NativeService) Start(ctx context.Context, r NativeStart) (assets.Result, error) {
	if r.ActorID <= 0 || r.ConnectionGeneration <= 0 || len(r.GroundID) > 128 || len(r.SpotID) > 128 {
		return assets.Result{}, assets.ErrInvalid
	}
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return assets.Result{}, assets.ErrUnavailable
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "fishing_start", RuleVersion: s.version(), Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if err := t.RequireFeature(ctx, "fishing"); err != nil {
			return assets.Result{}, err
		}
		spot, err := s.spot(r.GroundID, r.SpotID)
		if err != nil {
			return assets.Result{}, err
		}
		var online bool
		if err = t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.fishing_connections c WHERE owner_id=$1 AND generation=$2 AND expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM fishing.identities WHERE account_id=$1 AND banned)`, r.ActorID, r.ConnectionGeneration).Scan(&online); err != nil {
			return assets.Result{}, err
		}
		if !online {
			return assets.Result{}, assets.Rejection("connection_expired")
		}
		_, info, err := s.loadout(ctx, t, r.ActorID, spot)
		if err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.fishing_sessions SET state='paused',generation=generation+1 WHERE owner_id=$1 AND state='active'`, r.ActorID); err != nil {
			return assets.Result{}, err
		}
		var id, generation int64
		err = t.SQL().QueryRow(ctx, `INSERT INTO fishing.native_fishing_sessions(owner_id,generation,connection_generation,state,ground_id,spot_id,rule_version,private_seed,loadout_rev,due_at)
 SELECT account_id,1,$2,'active',$3,$4,$5,$6,loadout_rev,clock_timestamp()+($7::double precision*interval '1 millisecond') FROM fishing.player_state WHERE account_id=$1
 ON CONFLICT(owner_id) DO UPDATE SET generation=fishing.native_fishing_sessions.generation+1,next_seq=1,connection_generation=EXCLUDED.connection_generation,state='active',ground_id=EXCLUDED.ground_id,spot_id=EXCLUDED.spot_id,rule_version=EXCLUDED.rule_version,private_seed=EXCLUDED.private_seed,loadout_rev=EXCLUDED.loadout_rev,due_at=EXCLUDED.due_at RETURNING id,generation`, r.ActorID, r.ConnectionGeneration, r.GroundID, r.SpotID, s.version(), seed[:], info.Interval).Scan(&id, &generation)
		return assets.Result{Status: "started", ResourceID: strconv.FormatInt(id, 10), Generation: generation, Sequence: 1}, err
	})
}

func (s *NativeService) Stop(ctx context.Context, r Stop) (assets.Result, error) {
	if r.ActorID <= 0 || r.Generation <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "fishing_stop", RuleVersion: s.version(), Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var id, generation int64
		err := t.SQL().QueryRow(ctx, `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1 WHERE owner_id=$1 AND generation=$2 RETURNING id,generation`, r.ActorID, r.Generation).Scan(&id, &generation)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("stale_session")
		}
		return assets.Result{Status: "stopped", ResourceID: strconv.FormatInt(id, 10), Generation: generation}, err
	})
}

func nativeKey(c Candidate) string {
	return fmt.Sprintf("fishing:native-settle:%d:%d:%d", c.SessionID, c.Generation, c.Sequence)
}

func (s *NativeService) Settle(ctx context.Context, c Candidate) (assets.Result, error) {
	if c.OwnerID <= 0 || c.SessionID <= 0 || c.Generation <= 0 || c.Sequence <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: c.OwnerID, RequestKey: nativeKey(c), Kind: "fishing_settle", RuleVersion: s.version(), Players: []int64{c.OwnerID}, Input: c}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if err := t.RequireFeature(ctx, "fishing"); err != nil {
			if err == assets.Rejection("feature_disabled") {
				return assets.Result{}, assets.ErrDeferred
			}
			return assets.Result{}, err
		}
		var gen, seq, connection, loadout, current int64
		var state, version, ground, spotID string
		var seed []byte
		var due, now time.Time
		err := t.SQL().QueryRow(ctx, `SELECT generation,next_seq,connection_generation,state,rule_version,private_seed,loadout_rev,due_at,ground_id,spot_id FROM fishing.native_fishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`, c.SessionID, c.OwnerID).Scan(&gen, &seq, &connection, &state, &version, &seed, &loadout, &due, &ground, &spotID)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (state != "active" || gen != c.Generation || seq != c.Sequence) {
			return assets.Result{}, assets.Rejection("stale_cycle")
		}
		if err != nil {
			return assets.Result{}, err
		}
		if version != s.version() {
			return assets.Result{}, assets.ErrDeferred
		}
		var online bool
		if err = t.SQL().QueryRow(ctx, `SELECT clock_timestamp(),loadout_rev,EXISTS(SELECT 1 FROM fishing.fishing_connections WHERE owner_id=$1 AND generation=$2 AND expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM fishing.identities WHERE account_id=$1 AND banned) FROM fishing.player_state WHERE account_id=$1`, c.OwnerID, connection).Scan(&now, &current, &online); err != nil {
			return assets.Result{}, err
		}
		r := assets.Result{ResourceID: strconv.FormatInt(c.SessionID, 10), Generation: gen, Sequence: seq}
		if !online {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='paused',generation=generation+1 WHERE id=$1`, c.SessionID)
			r.Status = "paused"
			r.Generation++
			return r, err
		}
		spot, err := s.spot(ground, spotID)
		if err != nil {
			return assets.Result{}, assets.ErrDeferred
		}
		eff, info, err := s.loadout(ctx, t, c.OwnerID, spot)
		if err != nil {
			return assets.Result{}, err
		}
		if current != loadout {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET generation=generation+1,next_seq=1,loadout_rev=$2,due_at=$3 WHERE id=$1`, c.SessionID, current, now.Add(time.Duration(info.Interval*float64(time.Millisecond))))
			r.Status = "rescheduled"
			r.Generation++
			r.Sequence = 1
			return r, err
		}
		if now.Before(due) {
			return assets.Result{}, assets.ErrDeferred
		}
		pool, err := s.catalog.BoostPool(spot.Pool, nil, eff, s.catalog.DefaultLootConfig())
		if err != nil {
			return assets.Result{}, err
		}
		var draws uint64
		rng := rules.StreamAt(seed, nativeKey(c), &draws)
		catches := []rules.Catch{}
		// CastInfo rounds bite for display. The actual legacy tick uses the raw
		// probability; do not substitute the rounded UI value here.
		bite := s.catalog.CastRules(nil).Bite(eff, info.Interval, spot.Spot)
		if rng()*100 < bite {
			walk := rules.NewCatchWalk()
			for !walk.Done() {
				_, err = walk.Advance(ctx, 256, eff["double"], 0, rng, rules.CatchHooks{Enter: func() (bool, error) {
					v, ok := s.catalog.ResolveCatch(pool, eff, rng)
					if ok {
						catches = append(catches, v)
					}
					return ok, nil
				}, Leave: func() error { return nil }})
				if err != nil {
					return assets.Result{}, err
				}
			}
		}
		if err = s.award(ctx, t, c.OwnerID, ground, spotID, now, catches); err != nil {
			var rejected assets.Rejection
			if errors.As(err, &rejected) {
				return assets.Result{}, assets.ErrDeferred
			}
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.native_fishing_settlements(session_id,generation,seq,operation_id,rule_version,draws,caught,due_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c.SessionID, gen, seq, t.OperationID(), version, int64(draws), len(catches), due, now); err != nil {
			return assets.Result{}, err
		}
		// No downtime catch-up. Begin the next interval after this transaction's
		// work, rather than at its start (a long recursive cycle may take time).
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET next_seq=next_seq+1,due_at=clock_timestamp()+($2::double precision*interval '1 millisecond') WHERE id=$1`, c.SessionID, info.Interval); err != nil {
			return assets.Result{}, err
		}
		r.Status = "settled"
		r.Details, _ = json.Marshal(map[string]any{"caught": len(catches)})
		return r, nil
	})
}
