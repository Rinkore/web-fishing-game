package gateway

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/operations"
)

// Legacy read-only records/banner/features projections. Records are derived
// directly from the immutable catch_records ledger, so the legacy shapes do
// not duplicate gameplay authority.

func (a *API) legacyFeatures(w http.ResponseWriter, r *http.Request) {
	v, err := operations.New(a.pool).Features(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"features": legacyFeatureFlags(v.Flags), "featureOrder": map[string]any{}})
}

type legacyRecordEntry struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Size float64 `json:"size"`
	Who  string  `json:"who"`
	T    int64   `json:"t"`
}

func (a *API) legacyRecords(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	big := map[string]legacyRecordEntry{}
	small := map[string]legacyRecordEntry{}
	rows, err := a.pool.Query(r.Context(), `SELECT cr.item_id,cr.size,cr.caught_at,i.display_name FROM fishing.catch_records cr JOIN fishing.identities i ON i.account_id=cr.owner_id`)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	for rows.Next() {
		var id, who string
		var size float64
		var caughtAt time.Time
		if err := rows.Scan(&id, &size, &caughtAt, &who); err != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		it, ok := c.Item(id)
		if !ok || it.Kind != "fish" {
			continue
		}
		if cur, ok := big[id]; !ok || size > cur.Size || size == cur.Size && caughtAt.Before(time.UnixMilli(cur.T)) {
			big[id] = legacyRecordEntry{ID: id, Name: it.Name, Size: size, Who: who, T: caughtAt.UnixMilli()}
		}
		if cur, ok := small[id]; !ok || size < cur.Size || size == cur.Size && caughtAt.Before(time.UnixMilli(cur.T)) {
			small[id] = legacyRecordEntry{ID: id, Name: it.Name, Size: size, Who: who, T: caughtAt.UnixMilli()}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		failure(w, identity.ErrStorage)
		return
	}
	rows.Close()

	var globalMax *legacyRecordEntry
	for _, e := range big {
		if globalMax == nil || e.Size > globalMax.Size || e.Size == globalMax.Size && e.T < globalMax.T {
			copy := e
			globalMax = &copy
		}
	}

	now := time.Now()
	write(w, 200, map[string]any{
		"records":   big,
		"small":     small,
		"globalMax": globalMax,
		"last":      nil,
		"rankLabel": map[string]string{"day": rankLabelOf("day", a.location, now), "week": rankLabelOf("week", a.location, now), "all": "总榜 · 历史前十"},
	})
}

func rankLabelOf(kind string, loc *time.Location, now time.Time) string {
	if loc == nil {
		loc = time.Local
	}
	day := now.In(loc).Format("2006-01-02")
	if kind == "day" {
		return "日榜 · " + day
	}
	monday := mondayOf(now.In(loc)).Format("2006-01-02")
	return "周榜 · " + monday + " 当周"
}

func mondayOf(t time.Time) time.Time {
	y, m, d := t.Date()
	day := time.Date(y, m, d, 0, 0, 0, 0, t.Location())
	offset := (int(day.Weekday()) + 6) % 7
	return day.AddDate(0, 0, -offset)
}

func (a *API) legacyRecordsTop(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	id := r.URL.Query().Get("id")
	it, ok := c.Item(id)
	if !ok || it.Kind != "fish" {
		write(w, 404, map[string]any{"error": "unknown_fish", "code": "unknown_fish"})
		return
	}
	small := r.URL.Query().Get("kind") == "small"
	rnge := r.URL.Query().Get("range")
	if rnge != "day" && rnge != "week" {
		rnge = "all"
	}

	var viewer int64
	if session, ok := a.authorize(w, r, false); ok {
		viewer = session.AccountID
	}

	top := a.rankList(r.Context(), id, small, rnge, a.location)
	for i := range top {
		if top[i].OwnerID == viewer && viewer > 0 {
			top[i].Self = true
		}
	}

	var personal map[string]any
	if viewer > 0 {
		var minSize, maxSize *float64
		if err := a.pool.QueryRow(r.Context(), `SELECT min_size,max_size FROM fishing.player_codex WHERE owner_id=$1 AND item_id=$2`, viewer, id).Scan(&minSize, &maxSize); err == nil {
			personal = map[string]any{"min": minSize, "max": maxSize}
		}
	}

	write(w, 200, map[string]any{
		"personal": personal,
		"id":       id,
		"name":     it.Name,
		"kind":     map[bool]string{true: "small", false: "big"}[small],
		"range":    rnge,
		"label":    rankLabelOf(rnge, a.location, time.Now()),
		"top":      top,
	})
}

type legacyTopEntry struct {
	Size     float64 `json:"size"`
	Who      string  `json:"who"`
	PlayerID string  `json:"playerId,omitempty"`
	T        int64   `json:"t"`
	Self     bool    `json:"self"`
	OwnerID  int64   `json:"-"`
}

// rankList derives top-10 per player from catch_records. Every player keeps one
// best row (largest for big, smallest for small); day/week restrict the window
// to the server-location calendar day or Monday-start week.
func (a *API) rankList(ctx context.Context, id string, small bool, rnge string, loc *time.Location) []legacyTopEntry {
	if loc == nil {
		loc = time.Local
	}
	from := time.Time{}
	until := time.Time{}
	switch rnge {
	case "day":
		now := time.Now().In(loc)
		y, m, d := now.Date()
		from = time.Date(y, m, d, 0, 0, 0, 0, loc)
		until = from.AddDate(0, 0, 1)
	case "week":
		from = mondayOf(time.Now().In(loc))
		until = from.AddDate(0, 0, 7)
	}
	direction := "DESC"
	if small {
		direction = "ASC"
	}
	query := `SELECT cr.owner_id,cr.size,cr.caught_at,i.display_name FROM fishing.catch_records cr JOIN fishing.identities i ON i.account_id=cr.owner_id WHERE cr.item_id=$1`
	args := []any{id}
	if !from.IsZero() {
		query += ` AND cr.caught_at>=$2 AND cr.caught_at<$3`
		args = append(args, from, until)
	}
	query += ` ORDER BY cr.size ` + direction + `,cr.caught_at,cr.operation_id,cr.ordinal`
	rows, err := a.pool.Query(ctx, query, args...)
	if err != nil {
		return []legacyTopEntry{}
	}
	defer rows.Close()
	best := map[int64]legacyTopEntry{}
	var order []int64
	for rows.Next() {
		var owner int64
		var size float64
		var caughtAt time.Time
		var who string
		if err := rows.Scan(&owner, &size, &caughtAt, &who); err != nil {
			return []legacyTopEntry{}
		}
		if _, seen := best[owner]; !seen {
			best[owner] = legacyTopEntry{Size: size, Who: who, PlayerID: strconv.FormatInt(owner, 10), T: caughtAt.UnixMilli(), OwnerID: owner}
			order = append(order, owner)
		}
	}
	if rows.Err() != nil {
		return []legacyTopEntry{}
	}
	if len(order) > 10 {
		order = order[:10]
	}
	out := make([]legacyTopEntry, 0, len(order))
	for _, owner := range order {
		out = append(out, best[owner])
	}
	return out
}
