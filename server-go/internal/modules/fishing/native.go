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
	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NativeService executes bounded, durable fishing segments.
type NativeService struct {
	pool     *pgxpool.Pool
	assets   *assets.Service
	catalog  *rules.Catalog
	location *time.Location
	live     bool
}

func NewNative(pool *pgxpool.Pool, catalog *rules.Catalog, locations ...*time.Location) *NativeService {
	loc := time.Local
	if len(locations) > 0 && locations[0] != nil {
		loc = locations[0]
	}
	return &NativeService{pool: pool, assets: assets.New(pool), catalog: catalog, location: loc}
}

// NewLiveNative loads immutable publications for new cycles. A continuation
// stays on its original publication until that recursive cycle is complete.
func NewLiveNative(pool *pgxpool.Pool, location *time.Location) *NativeService {
	return &NativeService{pool: pool, assets: assets.New(pool), location: location, live: true}
}
func (s *NativeService) version() string {
	return "catch-v1:" + s.catalog.Version + ":" + s.catalog.SourceSHA256
}

type NativeStart struct {
	ActorID                      int64
	RequestKey, GroundID, SpotID string
	ConnectionGeneration         int64
	Resume                       bool
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
	if s.live {
		c, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return assets.Result{}, err
		}
		copy := *s
		copy.catalog = c
		copy.live = false
		return copy.Start(ctx, r)
	}
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
		access, err := sea.New(s.pool, s.catalog, s.location).ResolveFishing(ctx, t, r.ActorID, r.GroundID, r.SpotID)
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
		_, info, err := s.loadout(ctx, t, r.ActorID, access.Spot)
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
		if err == nil {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET resume_enabled=$2 WHERE id=$1`, id, r.Resume)
		}
		return assets.Result{Status: "started", ResourceID: strconv.FormatInt(id, 10), Generation: generation, Sequence: 1, Details: details(map[string]any{"interval": info.Interval, "castInfo": info})}, err
	})
}

func (s *NativeService) Stop(ctx context.Context, r Stop) (assets.Result, error) {
	if s.live {
		c, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return assets.Result{}, err
		}
		copy := *s
		copy.catalog = c
		copy.live = false
		return copy.Stop(ctx, r)
	}
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
	if s.live && s.catalog == nil {
		current, _, err := catalog.Current(ctx, s.pool)
		if err != nil {
			return assets.Result{}, err
		}
		var version string
		err = s.pool.QueryRow(ctx, `SELECT n.rule_version FROM fishing.native_fishing_sessions n JOIN fishing.catch_continuations c ON c.session_id=n.id AND c.generation=n.generation AND c.seq=n.next_seq WHERE n.id=$1 AND n.owner_id=$2 AND NOT c.done`, c.SessionID, c.OwnerID).Scan(&version)
		if err == nil {
			current, err = catalog.ByVersion(ctx, s.pool, version)
		} else if errors.Is(err, pgx.ErrNoRows) {
			err = nil
		}
		if err != nil {
			return assets.Result{}, err
		}
		copy := *s
		copy.catalog = current
		return copy.Settle(ctx, c)
	}
	if c.OwnerID <= 0 || c.SessionID <= 0 || c.Generation <= 0 || c.Sequence <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	// Read the expected segment before taking the command lock. Concurrent
	// workers that see the same segment replay its result, never run it twice.
	var part int64
	err := s.pool.QueryRow(ctx, `SELECT part FROM fishing.catch_continuations WHERE session_id=$1 AND generation=$2 AND seq=$3`, c.SessionID, c.Generation, c.Sequence).Scan(&part)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return assets.Result{}, assets.ErrUnavailable
	}
	key := nativeKey(c)
	if part > 0 {
		key += fmt.Sprintf(":part:%d", part)
	}
	return s.assets.Run(ctx, assets.Command{ActorID: c.OwnerID, RequestKey: key, Kind: "fishing_settle", RuleVersion: s.version(), Players: []int64{c.OwnerID}, Input: c}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
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
		var resume bool
		err := t.SQL().QueryRow(ctx, `SELECT generation,next_seq,connection_generation,state,rule_version,private_seed,loadout_rev,due_at,ground_id,spot_id,resume_enabled FROM fishing.native_fishing_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE`, c.SessionID, c.OwnerID).Scan(&gen, &seq, &connection, &state, &version, &seed, &loadout, &due, &ground, &spotID, &resume)
		if err == nil && resume && state == "paused" && gen == c.Generation && seq == c.Sequence {
			return assets.Result{}, assets.ErrDeferred
		}
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (state != "active" || gen != c.Generation || seq != c.Sequence) {
			return assets.Result{}, assets.Rejection("stale_cycle")
		}
		if err != nil {
			return assets.Result{}, err
		}
		if version != s.version() && !s.live {
			return assets.Result{}, assets.ErrDeferred
		}
		var online bool
		if err = t.SQL().QueryRow(ctx, `SELECT clock_timestamp(),loadout_rev,EXISTS(SELECT 1 FROM fishing.fishing_connections WHERE owner_id=$1 AND generation=$2 AND expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM fishing.identities WHERE account_id=$1 AND banned) FROM fishing.player_state WHERE account_id=$1`, c.OwnerID, connection).Scan(&now, &current, &online); err != nil {
			return assets.Result{}, err
		}
		r := assets.Result{ResourceID: strconv.FormatInt(c.SessionID, 10), Generation: gen, Sequence: seq}
		if !online {
			if resume {
				return assets.Result{}, assets.ErrDeferred
			}
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='paused',generation=generation+1 WHERE id=$1`, c.SessionID)
			r.Status = "paused"
			r.Generation++
			return r, err
		}
		seaService := sea.New(s.pool, s.catalog, s.location)
		access, err := seaService.ResolveFishing(ctx, t, c.OwnerID, ground, spotID)
		if err != nil {
			var rejection assets.Rejection
			if !errors.As(err, &rejection) {
				return assets.Result{}, err
			}
			if rejection == "feature_disabled" {
				return assets.Result{}, assets.ErrDeferred
			}
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET state='stopped',generation=generation+1 WHERE id=$1`, c.SessionID)
			r.Status = "stopped"
			r.Generation++
			r.Details, _ = json.Marshal(map[string]string{"reason": string(rejection)})
			return r, err
		}
		spot := access.Spot
		eff, info, err := s.loadout(ctx, t, c.OwnerID, spot)
		if err != nil {
			return assets.Result{}, err
		}
		if current != loadout || version != s.version() {
			_, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET generation=generation+1,next_seq=1,loadout_rev=$2,due_at=$3,rule_version=$4 WHERE id=$1`, c.SessionID, current, now.Add(time.Duration(info.Interval*float64(time.Millisecond))), s.version())
			r.Status = "rescheduled"
			r.Generation++
			r.Sequence = 1
			return r, err
		}
		if now.Before(due) {
			return assets.Result{}, assets.ErrDeferred
		}
		pool, err := s.catalog.BoostPool(spot.Pool, s.catalog.LootGroups(), eff, s.catalog.DefaultLootConfig())
		if err != nil {
			return assets.Result{}, err
		}
		var draws uint64
		var total int64
		walk := rules.CatchWalk{}
		if part > 0 {
			var raw []byte
			if err = t.SQL().QueryRow(ctx, `SELECT draws,caught,walk FROM fishing.catch_continuations WHERE session_id=$1 AND generation=$2 AND seq=$3 AND part=$4 AND NOT done`, c.SessionID, gen, seq, part).Scan(&draws, &total, &raw); err != nil {
				return assets.Result{}, err
			}
			if err = json.Unmarshal(raw, &walk); err != nil {
				return assets.Result{}, err
			}
		}
		rng := rules.StreamAt(seed, nativeKey(c), &draws)
		catches := []rules.Catch{}
		bonuses := []rules.Catch{}
		progress := map[string]int64{}
		notes := []string{}
		// CastInfo rounds bite for display. The actual legacy tick uses the raw
		// probability; do not substitute the rounded UI value here.
		bite := s.catalog.CastRules(nil).Bite(eff, info.Interval, spot.Spot)
		if part == 0 && rng()*100 < bite {
			walk = rules.NewCatchWalk()
		}
		if !walk.Done() {
			_, err = walk.Advance(ctx, 128, eff["double"], s.catalog.Runtime["doubleBase"], rng, rules.CatchHooks{Enter: func() (bool, error) {
				v, ok := s.catalog.ResolveCatch(pool, eff, rng)
				if ok && access.Ocean {
					e := s.catalog.SeaCatch(access.PartyCount, rng)
					if e.Event != "" {
						notes = append(notes, e.Event)
					}
					if e.Lost {
						return false, nil
					}
					progress["catch_ocean"]++
					if access.Zone {
						progress["catch_zone"]++
						if access.Mood == "deadly" {
							progress["catch_deadly"]++
						}
					}
					if v.Tier != "normal" {
						progress["catch_big_ocean"]++
					}
					if e.Event == "bounty" || e.Event == "wreck" {
						progress["sea_event"]++
					}
					for i := 0; i < e.Copies; i++ {
						bonuses = append(bonuses, v)
					}
					for id, n := range map[string]int64{"chartfrag": e.Chartfrags, "deepscale": e.Scales} {
						for i := int64(0); i < n; i++ {
							bonuses = append(bonuses, rules.Catch{ID: id, Kind: "material", Tier: "normal"})
						}
					}
				}
				if ok {
					catches = append(catches, v)
				}
				return ok, nil
			}, Leave: func() error { return nil }})
			if err != nil {
				return assets.Result{}, err
			}
		}
		if err = s.award(ctx, t, c.OwnerID, ground, spotID, now, catches, bonuses...); err != nil {
			var rejected assets.Rejection
			if errors.As(err, &rejected) {
				return assets.Result{}, assets.ErrDeferred
			}
			return assets.Result{}, err
		}
		ready, err := seaService.CatchProgress(ctx, t, c.OwnerID, progress)
		if err != nil {
			return assets.Result{}, err
		}
		if ready {
			notes = append(notes, "ship_upgrade_ready")
		}
		total += int64(len(catches))
		nextPart := part
		if !walk.Done() {
			nextPart++
		}
		raw, _ := json.Marshal(walk)
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.catch_continuations(session_id,generation,seq,part,done,draws,caught,walk) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id,generation,seq) DO UPDATE SET part=excluded.part,done=excluded.done,draws=excluded.draws,caught=excluded.caught,walk=excluded.walk`, c.SessionID, gen, seq, nextPart, walk.Done(), int64(draws), total, raw); err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.catch_segments(session_id,generation,seq,part,operation_id,caught) VALUES($1,$2,$3,$4,$5,$6)`, c.SessionID, gen, seq, part, t.OperationID(), len(catches)); err != nil {
			return assets.Result{}, err
		}
		r.Details, _ = json.Marshal(map[string]any{"caught": total, "segmentCaught": len(catches), "catches": catches, "bonuses": bonuses, "notices": notes,
			"groundId": ground, "spotId": spotID, "groundName": access.GroundName, "spotName": spot.Name, "caughtAt": now.UnixMilli()})
		if !walk.Done() {
			r.Status = "progressed"
			return r, nil
		}
		if _, err = t.SQL().Exec(ctx, `INSERT INTO fishing.native_fishing_settlements(session_id,generation,seq,operation_id,rule_version,draws,caught,due_at,settled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c.SessionID, gen, seq, t.OperationID(), version, int64(draws), total, due, now); err != nil {
			return assets.Result{}, err
		}
		// No downtime catch-up. Begin the next interval after this transaction's
		// work, rather than at its start (a long recursive cycle may take time).
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.native_fishing_sessions SET next_seq=next_seq+1,due_at=clock_timestamp()+($2::double precision*interval '1 millisecond') WHERE id=$1`, c.SessionID, info.Interval); err != nil {
			return assets.Result{}, err
		}
		r.Status = "settled"
		return r, nil
	})
}
