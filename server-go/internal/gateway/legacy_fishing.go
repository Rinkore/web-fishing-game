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
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
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
	svc := fishing.NewLiveNative(a.pool, a.location)
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := svc.Start(ctx, fishing.NativeStart{
		ActorID: session.AccountID, RequestKey: "legacy:start", GroundID: in.GroundID, SpotID: in.SpotID,
		ConnectionGeneration: gen,
	})
	if err != nil {
		failure(w, err)
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
	if _, err := fishing.NewLiveNative(a.pool, a.location).Stop(ctx, fishing.Stop{ActorID: session.AccountID, RequestKey: "legacy:stop", Generation: gen}); err != nil {
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
// connection lease, emits init, then forwards settled catches as catch,
// codexAdd and assets events using catch_records as the durable replay cursor.
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

	defer func() {
		closeCtx := assets.WithSession(context.Background(), session.AccountID, session.Hash, false)
		// The request key must differ from the open command, otherwise the
		// durable asset machinery replays the cached open result and the lease
		// (and its stream row) is never released.
		_, _ = svc.Stream(closeCtx, session.AccountID, "legacy:stream:"+streamID+":close", streamID, "close")
	}()

	c, err := a.catalog(r.Context())
	if err != nil {
		_ = send(`data: {"type":"kicked"}` + "\n\n")
		return
	}

	// init carries the authoritative snapshot the legacy client needs to render.
	// Each push projection seeds its own watermark from the same snapshot, so a
	// change racing init is delivered by the next poll instead of being lost.
	init := a.legacyInit(r, c, session, open.Generation)
	pushes := a.newLegacyPushes(session.AccountID, c)
	for key, value := range pushes.init(r.Context()) {
		init[key] = value
	}
	if !send("data: " + jsonString(init) + "\n\n") {
		return
	}

	cursor := a.lastCatchOperation(r.Context(), session.AccountID)
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
			if _, err := svc.Stream(leaseCtx, session.AccountID, "legacy:stream:"+streamID+":hb:"+randomStreamID(), streamID, "heartbeat"); err != nil {
				// A vanished stream row (restored database, expired lease) is
				// re-opened so presence and any paused session resume.
				if _, reopen := svc.Stream(leaseCtx, session.AccountID, "legacy:stream:"+streamID+":hb:"+randomStreamID(), streamID, "open"); reopen != nil {
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
			next, entries, err := a.settledCatches(r.Context(), c, session.AccountID, session.Name, cursor)
			if err != nil {
				return
			}
			if len(entries) == 0 {
				continue
			}
			cursor = next
			for _, e := range entries {
				if !send("data: " + jsonString(e) + "\n\n") {
					return
				}
			}
		case <-heartbeat.C:
			if !send(": ping\n\n") {
				return
			}
			// Revalidate the session each heartbeat so revocation kicks the stream.
			if _, err := a.identity.Authenticate(r.Context(), token(r, false), false); err != nil {
				_ = send(`data: {"type":"kicked"}` + "\n\n")
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
	codex := map[string]any{}
	if v, ok := profile["codex"].(map[string]any); ok {
		codex = v
	}
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
		"you":            strconv.FormatInt(session.AccountID, 10),
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
		init["resumedFishing"] = map[string]any{
			"groundId": status["groundId"],
			"spotId":   status["spotId"],
			"interval": 0,
		}
	}
	return init
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
			out[ground+":"+spot] = n
		}
	}
	return out
}

func (a *API) lastCatchOperation(ctx context.Context, owner int64) int64 {
	var last int64
	_ = a.pool.QueryRow(ctx, `SELECT COALESCE(max(operation_id),0) FROM fishing.catch_records WHERE owner_id=$1`, owner).Scan(&last)
	return last
}

func (a *API) settledCatches(ctx context.Context, c *rules.Catalog, owner int64, name string, after int64) (int64, []map[string]any, error) {
	rows, err := a.pool.Query(ctx, `SELECT cr.operation_id,cr.item_id,cr.size,cr.ground_id,cr.spot_id,cr.caught_at,cr.ordinal
 FROM fishing.catch_records cr WHERE cr.owner_id=$1 AND cr.operation_id>$2 ORDER BY cr.operation_id,cr.ordinal LIMIT 100`, owner, after)
	if err != nil {
		return after, nil, err
	}
	defer rows.Close()
	next := after
	events := []map[string]any{}
	groundNames := map[string]string{}
	for _, g := range c.Grounds() {
		groundNames[g.ID] = g.Name
	}
	for rows.Next() {
		var op int64
		var itemID, ground, spot string
		var size float64
		var caughtAt time.Time
		var ordinal int64
		if err := rows.Scan(&op, &itemID, &size, &ground, &spot, &caughtAt, &ordinal); err != nil {
			return after, nil, err
		}
		if op > next {
			next = op
		}
		it, _ := c.Item(itemID)
		tier := c.SizeTier(itemID, size)
		entry := map[string]any{
			"t":      caughtAt.UnixMilli(),
			"who":    name,
			"item":   map[string]any{"id": itemID, "name": it.Name, "kind": it.Kind, "rarity": it.Rarity, "size": size, "tier": tier},
			"ground": groundNames[ground],
			"spot":   spot,
			"size":   size,
		}
		events = append(events, map[string]any{"type": "catch", "entry": entry})
		events = append(events, a.legacyCodexAdd(ctx, c, owner, itemID, tier))
		events = append(events, a.legacyAssetsDelta(ctx, c, owner, itemID, tier))
	}
	if err := rows.Err(); err != nil {
		return after, nil, err
	}
	return next, events, nil
}

func (a *API) legacyCodexAdd(ctx context.Context, c *rules.Catalog, owner int64, itemID, sizeTier string) map[string]any {
	var count int64
	var minSize, maxSize *float64
	var tier string
	err := a.pool.QueryRow(ctx, `SELECT count,min_size,max_size,best_tier FROM fishing.player_codex WHERE owner_id=$1 AND item_id=$2`, owner, itemID).Scan(&count, &minSize, &maxSize, &tier)
	if err != nil {
		return map[string]any{"type": "codexAdd", "id": itemID, "add": 1, "tier": sizeTierLabel(sizeTier)}
	}
	var legacyTier any
	switch tier {
	case "large":
		legacyTier = "L"
	case "giant":
		legacyTier = "G"
	}
	it, _ := c.Item(itemID)
	var catchCount int64
	_ = a.pool.QueryRow(ctx, `SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&catchCount)
	return map[string]any{
		"type": "codexAdd", "id": itemID, "name": it.Name, "add": 1,
		"mx": maxSize, "mn": minSize, "tier": legacyTier, "catchCount": catchCount,
	}
}

func (a *API) legacyAssetsDelta(ctx context.Context, c *rules.Catalog, owner int64, itemID, sizeTier string) map[string]any {
	var coins, catchCount int64
	_ = a.pool.QueryRow(ctx, `SELECT w.coins,p.catch_count FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, owner).Scan(&coins, &catchCount)
	invAdd := map[string]int64{itemID: 1}
	var bigAdd any
	if label := sizeTierLabel(sizeTier); label != "" {
		bigAdd = map[string]any{itemID: map[string]int64{label: 1}}
	}
	return map[string]any{"type": "assets", "coins": coins, "catchCount": catchCount, "invAdd": invAdd, "bigAdd": bigAdd}
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
