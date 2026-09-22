package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/platform/httpserver"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Legacy fishing bridge. The original frontend starts/stops fishing over the
// legacy HTTP routes and receives catch/codexAdd/assets events on /events.

func (a *API) legacyFishingStart(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		GroundID string `json:"groundId"`
		SpotID   string `json:"spotId"`
	}
	if !decode(w, r, &in) {
		return
	}
	gen, err := a.activeConnectionGeneration(r.Context(), session.AccountID)
	if err != nil {
		failure(w, identity.ErrInvalid)
		return
	}
	in.GroundID, err = a.legacyGroundFilter(r.Context(), in.GroundID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	svc := fishing.NewLiveNative(a.pool, a.location)
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := svc.Start(ctx, fishing.NativeStart{
		ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:start"), GroundID: in.GroundID, SpotID: in.SpotID,
		ConnectionGeneration: gen,
		KeepActive:           true,
	})
	if err != nil {
		failure(w, err)
		return
	}
	if res.Status != "started" {
		write(w, http.StatusConflict, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	var details struct {
		Interval float64        `json:"interval"`
		CastInfo rules.CastInfo `json:"castInfo"`
	}
	if err := json.Unmarshal(res.Details, &details); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "interval": details.Interval, "castInfo": details.CastInfo})
}

func (a *API) legacyFishingStop(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	status, err := fishing.NewLiveNative(a.pool, a.location).Status(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	gen, _ := status["generation"].(int64)
	if gen <= 0 {
		write(w, 200, map[string]any{"ok": true})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	if _, err := fishing.NewLiveNative(a.pool, a.location).Stop(ctx, fishing.Stop{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:stop"), Generation: gen}); err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true})
}

func (a *API) activeConnectionGeneration(ctx context.Context, owner int64) (int64, error) {
	var gen int64
	err := a.pool.QueryRow(ctx, `SELECT generation FROM fishing.fishing_connections WHERE owner_id=$1 AND expires_at>clock_timestamp()`, owner).Scan(&gen)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, identity.ErrInvalid
	}
	return gen, err
}

// legacyEvents serves the original frontend's /events stream. It establishes a
// connection lease, emits init, then projects committed player events and
// authoritative asset snapshots. Social projections have separate cursors.
func (a *API) legacyEvents(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	streamID := randomStreamID()
	svc := fishing.NewLiveNative(a.pool, a.location)
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	open, err := svc.Stream(ctx, session.AccountID, "legacy:stream:"+streamID, streamID, "open")
	if err != nil {
		failure(w, err)
		return
	}
	if open.Status != "connected" {
		write(w, http.StatusConflict, map[string]any{"error": open.Status, "code": open.Status})
		return
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		closeCtx = assets.WithSession(closeCtx, session.AccountID, session.Hash, false)
		_, _ = svc.Stream(closeCtx, session.AccountID, "legacy:stream:"+streamID+":close", streamID, "close")
	}()

	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(text string) bool {
		if controller.SetWriteDeadline(time.Now().Add(2*time.Second)) != nil {
			return false
		}
		if _, err := fmt.Fprint(w, text); err != nil {
			return false
		}
		if controller.Flush() != nil {
			return false
		}
		a.sseMsgs.Add(1)
		a.sseWrites.Add(1)
		a.sseBytes.Add(int64(len(text)))
		return true
	}
	if !send("retry: 3000\n\n") {
		return
	}
	var version string
	defer func() {
		if httpserver.IsDraining(r.Context()) {
			_ = send(legacyFrame(map[string]any{"type": "maintenance", "version": version}))
		}
	}()

	c, err := a.catalog(r.Context())
	if err != nil {
		return
	}
	_ = json.Unmarshal(c.Constants["VERSION"], &version)

	// Seed cursors before sending init. The personal assets frame and its cursor
	// come from one snapshot, so a commit racing the send remains pending.
	init := a.legacyInit(r, c, session, open.Generation)
	personal := &legacyPersonalPush{api: a, owner: session.AccountID, name: session.Name, catalog: c}
	snapshot, err := personal.init(r.Context())
	if err != nil {
		return
	}
	pushes := a.newLegacyPushes(session.AccountID, c, personal)
	for key, value := range pushes.init(r.Context()) {
		init[key] = value
	}
	if !send("data: " + jsonString(init) + "\n\n") {
		return
	}
	if !send(snapshot) {
		return
	}

	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	// The durable modules treat an expired fishing_connections lease as offline,
	// so the stream renews its own lease: the original frontend keeps /events
	// open instead of heartbeating the game API.
	presence := time.NewTicker(10 * time.Second)
	defer presence.Stop()
	tradeTick := time.NewTicker(time.Second)
	defer tradeTick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-presence.C:
			leaseCtx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
			lease, err := svc.Stream(leaseCtx, session.AccountID, "legacy:stream:"+streamID+":hb:"+randomStreamID(), streamID, "heartbeat")
			if err != nil || lease.Status != "connected" {
				// A vanished stream row (restored database, expired lease) is
				// re-opened so presence and any paused session resume.
				// Business rejections are returned as Status with a nil error.
				reopened, reopenErr := svc.Stream(leaseCtx, session.AccountID, "legacy:stream:"+streamID+":hb:"+randomStreamID(), streamID, "open")
				if reopenErr != nil || reopened.Status != "connected" {
					return
				}
			}
		case <-tradeTick.C:
			// Trade, market, friend and viewport projections each keep their own
			// durable watermark and return nothing when their domain is idle.
			for _, frame := range pushes.poll(r.Context()) {
				if !send(frame) {
					return
				}
			}
		case <-tick.C:
			entries, err := personal.poll(r.Context())
			if err != nil {
				// Retry the same page after a transient read failure.
				continue
			}
			if len(entries) == 0 {
				continue
			}
			for _, e := range entries {
				if !send(e) {
					return
				}
			}
		case <-heartbeat.C:
			if !send(legacyFrame(map[string]any{"type": "ping"})) {
				return
			}
			// Revalidate the session each heartbeat so revocation kicks the stream.
			if _, err := a.identity.Authenticate(r.Context(), token(r, false), false); err != nil {
				if r.Context().Err() == nil {
					_ = send(`data: {"type":"kicked"}` + "\n\n")
				}
				return
			}
		}
	}
}

// assetsRevision reads the participant's asset revision: the cheap wake-up
// signal for stream projections that should not hold their own per-tick scan.
func (a *API) assetsRevision(ctx context.Context, owner int64) (int64, error) {
	var revision int64
	if err := a.pool.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&revision); err != nil {
		return 0, err
	}
	return revision, nil
}

func (a *API) legacyInit(r *http.Request, c *rules.Catalog, session identity.Session, generation int64) map[string]any {
	profile, _ := a.legacyProfile(r, c, session)
	codex := profile["codex"]
	catchCount := int64(0)
	if v, ok := profile["catchCount"].(int64); ok {
		catchCount = v
	}
	var version string
	_ = json.Unmarshal(c.Constants["VERSION"], &version)
	playersTotal := a.onlinePlayers(r.Context())
	grounds := a.groundCounts(r.Context())
	spotCounts := a.spotCounts(r.Context())
	init := map[string]any{
		"type":           "init",
		"you":            strings.ToLower(session.Username),
		"feed":           []any{},
		"features":       profile["features"],
		"featureOrder":   profile["featureOrder"],
		"playersTotal":   playersTotal,
		"recordsVersion": 0,
		"shop":           map[string]any{},
		"marketRevision": 0,
		"marketTotal":    0,
		"grounds":        grounds,
		"spotCounts":     spotCounts,
		"trade":          nil,
		"codex":          codex,
		"catchCount":     catchCount,
		"bigfish":        profile["bigfish"],
		"version":        version,
	}
	status, err := fishing.NewLiveNative(a.pool, a.location).Status(r.Context(), session.AccountID)
	if err == nil && status["active"] == true {
		ground, _ := status["groundId"].(string)
		spot, _ := status["spotId"].(string)
		// The legacy client uses the reconnect snapshot to restore both the
		// selected spot and the exact cast display.  Returning a zero interval
		// leaves a resumed session looking idle until the next manual start,
		// while the server is already settling it with the real loadout.
		resume := map[string]any{
			"groundId": ground,
			"spotId":   spot,
			"interval": 0,
		}
		if info, ok := a.legacyResumeCastInfo(r.Context(), c, session.AccountID, ground, spot); ok {
			resume["interval"] = info.Interval
			resume["castInfo"] = info
		}
		if rewritten, ok := a.legacySeaGround(r.Context(), ground); ok {
			resume["groundId"] = rewritten
		}
		init["resumedFishing"] = resume
	}
	return init
}

// legacyResumeCastInfo is a read-only projection of the active loadout used by
// the reconnect init frame.  Start/settle remain authoritative for gameplay;
// this helper only reconstructs the same display values the legacy client
// receives from /api/fishing/start.  Sea spots are durable JSON rows rather
// than catalog entries, so resolve their spot buffs from the live zone first.
func (a *API) legacyResumeCastInfo(ctx context.Context, c *rules.Catalog, owner int64, ground, spot string) (rules.CastInfo, bool) {
	var target rules.FishingSpot
	if strings.HasPrefix(ground, "sea:") {
		parts := strings.SplitN(strings.TrimPrefix(ground, "sea:"), ":", 2)
		if len(parts) != 2 {
			return rules.CastInfo{}, false
		}
		zoneOwner, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || zoneOwner <= 0 {
			return rules.CastInfo{}, false
		}
		var raw []byte
		if err := a.pool.QueryRow(ctx, `SELECT data FROM fishing.sea_zones WHERE owner_id=$1 AND id=$2 AND expires_at>clock_timestamp()`, zoneOwner, parts[1]).Scan(&raw); err != nil {
			return rules.CastInfo{}, false
		}
		var zone rules.SeaZone
		if json.Unmarshal(raw, &zone) != nil {
			return rules.CastInfo{}, false
		}
		for _, value := range zone.Spots {
			if value.ID != spot {
				continue
			}
			target = rules.FishingSpot{ID: value.ID, Name: value.Name, Map: "voyage", MinShip: 1, Pool: value.Pool}
			for _, buff := range value.Buffs {
				target.Buffs = append(target.Buffs, rules.Buff{Type: buff.Type, Value: buff.Value})
			}
			break
		}
		if target.ID == "" {
			return rules.CastInfo{}, false
		}
	} else {
		_, value, ok := c.FishingSpot(ground, spot)
		if !ok {
			return rules.CastInfo{}, false
		}
		target = value
	}
	rows, err := a.pool.Query(ctx, `SELECT c.part,e.attributes->>'signature'
 FROM fishing.rod_loadouts r
 JOIN fishing.rod_components c USING(owner_id,slot)
 JOIN fishing.equipment_instances e ON e.id=c.equipment_id
 WHERE r.owner_id=$1 AND r.active ORDER BY c.part`, owner)
	if err != nil {
		return rules.CastInfo{}, false
	}
	defer rows.Close()
	bd := map[string]struct {
		CompID string `json:"compId"`
	}{}
	for rows.Next() {
		var part, signature string
		if err := rows.Scan(&part, &signature); err != nil {
			return rules.CastInfo{}, false
		}
		bd[part] = struct {
			CompID string `json:"compId"`
		}{CompID: signature}
	}
	if rows.Err() != nil {
		return rules.CastInfo{}, false
	}
	return c.CastRules(nil).Info(c.RodEffects(bd), target.Spot), true
}

func (a *API) onlinePlayers(ctx context.Context) int64 {
	var n int64
	_ = a.pool.QueryRow(ctx, `SELECT count(DISTINCT owner_id) FROM fishing.gateway_streams WHERE expires_at>clock_timestamp()`).Scan(&n)
	return n
}

func (a *API) groundCounts(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	rows, err := a.pool.Query(ctx, `SELECT ground_id,count(*) FROM fishing.native_fishing_sessions WHERE state='active' GROUP BY ground_id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int64
		if rows.Scan(&id, &n) == nil {
			if rewritten, ok := a.legacySeaGround(ctx, id); ok {
				id = rewritten
			}
			out[id] = n
		}
	}
	return out
}

func (a *API) spotCounts(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	rows, err := a.pool.Query(ctx, `SELECT ground_id,spot_id,count(*) FROM fishing.native_fishing_sessions WHERE state='active' GROUP BY ground_id,spot_id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var ground, spot string
		var n int64
		if rows.Scan(&ground, &spot, &n) == nil {
			if rewritten, ok := a.legacySeaGround(ctx, ground); ok {
				ground = rewritten
			}
			out[ground+":"+spot] = n
		}
	}
	return out
}

func sizeTierLabel(tier string) string {
	switch tier {
	case "large":
		return "L"
	case "giant":
		return "G"
	}
	return ""
}

func randomStreamID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
