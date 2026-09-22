package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Player revisions serialize commits; global operation IDs do not. An ordinal
// allows a recursive settlement to span pages without skipping its tail.
type legacyCatchCursor struct {
	Owner    int64 `json:"owner"`
	Revision int64 `json:"revision"`
	Ordinal  int64 `json:"ordinal"`
}

type legacyCatchPush struct {
	api                *API
	owner              int64
	catalog            *rules.Catalog
	cursors            map[int64]legacyCatchCursor
	version            int64
	moderationRevision int64
	seeded             bool
}

func (p *legacyCatchPush) init(ctx context.Context) map[string]any {
	rows, err := p.api.pool.Query(ctx, `SELECT account_id,assets_rev FROM fishing.player_state`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	cursors := map[int64]legacyCatchCursor{}
	for rows.Next() {
		var c legacyCatchCursor
		if rows.Scan(&c.Owner, &c.Revision) != nil {
			return nil
		}
		c.Ordinal = 9223372036854775807
		cursors[c.Owner] = c
	}
	if rows.Err() != nil {
		return nil
	}
	p.cursors, p.seeded = cursors, true
	if err := p.api.pool.QueryRow(ctx, `SELECT revision FROM fishing.catch_record_moderation_guard WHERE singleton`).Scan(&p.moderationRevision); err != nil {
		return nil
	}
	fields := map[string]any{"recordsVersion": p.version}
	if history := p.history(ctx); history != nil {
		fields["feed"] = history
	}
	return fields
}

// history reconstructs the legacy in-memory feed from committed fishing
// payloads. The cursor bound is important: rows committed after init belong
// to poll and must not be replayed once more as initial history.
func (p *legacyCatchPush) history(ctx context.Context) []map[string]any {
	positions := make([]legacyCatchCursor, 0, len(p.cursors))
	for _, cursor := range p.cursors {
		positions = append(positions, cursor)
	}
	raw, err := json.Marshal(positions)
	if err != nil {
		return nil
	}
	rows, err := p.api.pool.Query(ctx, `WITH cursors AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(owner bigint,revision bigint,ordinal bigint)
 ) SELECT e.operation_id,cr.ordinal,pe.owner_id,pe.revision,cr.item,
 cr.ground_id,cr.spot_id,cr.caught_at,cr.ground_name,cr.spot_name,lower(i.username),i.display_name
 FROM fishing.player_events pe
 JOIN fishing.outbox_events e ON e.id=pe.outbox_id
 JOIN fishing.asset_operations o ON o.id=e.operation_id AND o.kind='fishing_settle'
 JOIN LATERAL (
 SELECT v.value AS item,v.ordinality AS ordinal,
 COALESCE(e.payload#>>'{result,details,groundId}','') AS ground_id,
 COALESCE(e.payload#>>'{result,details,spotId}','') AS spot_id,
 COALESCE(to_timestamp((e.payload#>>'{result,details,caughtAt}')::double precision/1000),e.created_at) AS caught_at,
 COALESCE(e.payload#>>'{result,details,groundName}','') AS ground_name,
 COALESCE(e.payload#>>'{result,details,spotName}','') AS spot_name
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>'{result,details,catches}')='array'
 THEN e.payload#>'{result,details,catches}' ELSE '[]'::jsonb END) WITH ORDINALITY v(value,ordinality)
 UNION ALL
 SELECT jsonb_build_object('id',r.item_id,'kind','fish','size',r.size),r.ordinal,r.ground_id,r.spot_id,r.caught_at,'',''
 FROM fishing.catch_records r WHERE r.operation_id=e.operation_id AND r.owner_id=pe.owner_id
 AND jsonb_typeof(e.payload#>'{result,details,catches}') IS DISTINCT FROM 'array'
 ) cr ON true
 JOIN fishing.identities i ON i.account_id=pe.owner_id
 JOIN cursors c ON c.owner=pe.owner_id AND pe.revision<=c.revision
 ORDER BY cr.caught_at DESC,e.operation_id DESC,cr.ordinal DESC LIMIT 60`, raw)
	if err != nil {
		return nil
	}
	defer rows.Close()
	mode := p.notifyLevel(ctx)
	boards, boardErr := p.catchBoards(ctx, time.Now())
	if boardErr != nil {
		return nil
	}
	entries := make([]map[string]any, 0, 60)
	for rows.Next() {
		var row legacyCatchRow
		var item []byte
		if err := rows.Scan(&row.op, &row.ordinal, &row.owner, &row.revision, &item,
			&row.groundID, &row.spotID, &row.caughtAt, &row.groundName, &row.spotName, &row.key, &row.name); err != nil {
			return nil
		}
		if json.Unmarshal(item, &row.item) != nil {
			return nil
		}
		if row.item.Kind == "fish" && row.item.Size != nil && row.item.Tier == "" {
			row.item.Tier = p.catalog.SizeTier(row.item.ID, *row.item.Size)
		}
		itemView := legacyCatchItem(p.catalog, row.item)
		level, record := legacyCatchNoticeLevel(boards, legacyCatchKey{row.op, row.ordinal})
		if !legacyFeedVisible(p.catalog, row.item, record || level > 0, mode) {
			continue
		}
		ground, spot := legacyCatchLocation(p.catalog, row.groundID, row.spotID, row.groundName, row.spotName)
		entries = append(entries, map[string]any{
			"t": row.caughtAt.UnixMilli(), "who": row.name, "item": legacySlimFeedItem(itemView),
			"ground": ground, "spot": spot, "size": row.item.Size,
		})
	}
	if rows.Err() != nil {
		return nil
	}
	// The SQL order is newest first; Node's feed is newest first as well.
	return entries
}

type legacyCatchRow struct {
	op, ordinal, owner, revision int64
	groundID, spotID             string
	groundName, spotName         string
	item                         rules.Catch
	caughtAt                     time.Time
	key, name                    string
}

type legacyCatchKey struct{ operation, ordinal int64 }

type legacyCatchBoards struct {
	global   legacyCatchKey
	big      map[legacyCatchKey]bool
	small    map[legacyCatchKey]bool
	topBig   map[legacyCatchKey]int
	topSmall map[legacyCatchKey]int
}

func (p *legacyCatchPush) notifyLevel(ctx context.Context) string {
	var raw []byte
	if err := p.api.pool.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key='legacy:settings'`).Scan(&raw); err != nil {
		return "all"
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(raw, &settings) != nil {
		return "all"
	}
	var level string
	if json.Unmarshal(settings["notifyLevel"], &level) != nil {
		return "all"
	}
	switch level {
	case "all", "uncommon", "offrange", "records", "none", "rare", "off":
		return level
	default:
		return "all"
	}
}

func legacyFeedVisible(c *rules.Catalog, item rules.Catch, record bool, mode string) bool {
	switch mode {
	case "none", "off":
		return false
	case "records":
		return record
	case "uncommon", "rare":
		it, ok := c.Item(item.ID)
		return item.Kind == "component" || (ok && item.Kind == "fish" && it.Rarity != "common")
	case "offrange":
		if item.Kind != "fish" || item.Size == nil {
			return false
		}
		r, ok := c.Item(item.ID)
		if !ok || r.Size == nil {
			return false
		}
		return *item.Size < r.Size[0] || *item.Size > r.Size[1]
	default:
		return true
	}
}

func catchKeyIsZero(k legacyCatchKey) bool { return k.operation == 0 && k.ordinal == 0 }

// catchBoards computes the same priority inputs as Node's boardAnnouncement:
// global max, per-fish max/min, then full daily top-ten boards. The immutable
// catch ledger is the source of truth, while moderation hides are projections.
func (p *legacyCatchPush) catchBoards(ctx context.Context, now time.Time) (legacyCatchBoards, error) {
	b := legacyCatchBoards{big: map[legacyCatchKey]bool{}, small: map[legacyCatchKey]bool{}, topBig: map[legacyCatchKey]int{}, topSmall: map[legacyCatchKey]int{}}
	rows, err := p.api.pool.Query(ctx, `SELECT cr.operation_id,cr.ordinal,cr.item_id,cr.size,cr.caught_at,
 NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='big'),
 NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='small')
 FROM fishing.catch_records cr ORDER BY cr.item_id,cr.size DESC,cr.caught_at,cr.operation_id,cr.ordinal`)
	if err != nil {
		return b, err
	}
	type value struct {
		key                      legacyCatchKey
		id                       string
		sz                       float64
		at                       time.Time
		bigVisible, smallVisible bool
	}
	values := []value{}
	for rows.Next() {
		var v value
		if err := rows.Scan(&v.key.operation, &v.key.ordinal, &v.id, &v.sz, &v.at, &v.bigVisible, &v.smallVisible); err != nil {
			rows.Close()
			return b, err
		}
		values = append(values, v)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return b, err
	}
	rows.Close()
	maxByID := map[string]value{}
	minByID := map[string]value{}
	for _, v := range values {
		if v.bigVisible {
			if cur, ok := maxByID[v.id]; !ok || v.sz > cur.sz || v.sz == cur.sz && v.at.Before(cur.at) {
				maxByID[v.id] = v
			}
		}
		if v.smallVisible {
			if cur, ok := minByID[v.id]; !ok || v.sz < cur.sz || v.sz == cur.sz && v.at.Before(cur.at) {
				minByID[v.id] = v
			}
		}
	}
	var global value
	for _, v := range maxByID {
		b.big[v.key] = true
		if catchKeyIsZero(b.global) || v.sz > global.sz || v.sz == global.sz && v.at.Before(global.at) {
			global = v
		}
	}
	for _, v := range minByID {
		b.small[v.key] = true
	}
	if !catchKeyIsZero(global.key) {
		b.global = global.key
	}
	ids := map[string]bool{}
	for _, v := range values {
		ids[v.id] = true
	}
	for id := range ids {
		big, err := legacyRankList(ctx, p.api.pool, id, false, "day", p.api.location, now)
		if err != nil {
			return b, err
		}
		if len(big) == 10 {
			for i, entry := range big {
				b.topBig[legacyCatchKey{entry.OperationID, entry.Ordinal}] = i + 1
			}
		}
		small, err := legacyRankList(ctx, p.api.pool, id, true, "day", p.api.location, now)
		if err != nil {
			return b, err
		}
		if len(small) == 10 {
			for i, entry := range small {
				b.topSmall[legacyCatchKey{entry.OperationID, entry.Ordinal}] = i + 1
			}
		}
	}
	return b, nil
}

func legacyCatchNoticeLevel(b legacyCatchBoards, key legacyCatchKey) (int, bool) {
	if key == b.global && !catchKeyIsZero(key) {
		return 1, true
	}
	if b.big[key] || b.small[key] {
		return 2, true
	}
	if b.topBig[key] > 0 {
		return 3, false
	}
	if b.topSmall[key] > 0 {
		return 4, false
	}
	return 0, false
}

func bannerCatchAllowedLegacy(ctx context.Context, a *API, level int) bool {
	if level == 1 {
		return true
	}
	state, err := readLegacyBanners(ctx, a.pool, false)
	if err != nil {
		return true
	}
	mode, _ := state.Cfg["catchLevel"].(string)
	if mode == "" {
		mode = "fish10"
	}
	switch mode {
	case "gmax":
		return false
	case "gmax10":
		return level == 3 || level == 4
	case "fish":
		return level == 2
	default:
		return true
	}
}

func (p *legacyCatchPush) poll(ctx context.Context) []string {
	if !p.seeded {
		p.init(ctx)
		return nil
	}
	positions := make([]legacyCatchCursor, 0, len(p.cursors))
	for _, cursor := range p.cursors {
		positions = append(positions, cursor)
	}
	raw, err := json.Marshal(positions)
	if err != nil {
		return nil
	}
	rows, err := p.api.pool.Query(ctx, `WITH cursors AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(owner bigint,revision bigint,ordinal bigint)
 ) SELECT e.operation_id,cr.ordinal,pe.owner_id,pe.revision,cr.item,
 cr.ground_id,cr.spot_id,cr.caught_at,cr.ground_name,cr.spot_name,lower(i.username),i.display_name
 FROM fishing.player_events pe
 JOIN fishing.outbox_events e ON e.id=pe.outbox_id
 JOIN fishing.asset_operations o ON o.id=e.operation_id AND o.kind='fishing_settle'
 JOIN LATERAL (
 SELECT v.value AS item,v.ordinality AS ordinal,
 COALESCE(e.payload#>>'{result,details,groundId}','') AS ground_id,
 COALESCE(e.payload#>>'{result,details,spotId}','') AS spot_id,
 COALESCE(to_timestamp((e.payload#>>'{result,details,caughtAt}')::double precision/1000),e.created_at) AS caught_at,
 COALESCE(e.payload#>>'{result,details,groundName}','') AS ground_name,
 COALESCE(e.payload#>>'{result,details,spotName}','') AS spot_name
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>'{result,details,catches}')='array'
 THEN e.payload#>'{result,details,catches}' ELSE '[]'::jsonb END) WITH ORDINALITY v(value,ordinality)
 UNION ALL
 SELECT jsonb_build_object('id',r.item_id,'kind','fish','size',r.size),r.ordinal,r.ground_id,r.spot_id,r.caught_at,'',''
 FROM fishing.catch_records r WHERE r.operation_id=e.operation_id AND r.owner_id=pe.owner_id
 AND jsonb_typeof(e.payload#>'{result,details,catches}') IS DISTINCT FROM 'array'
 ) cr ON true
 JOIN fishing.identities i ON i.account_id=pe.owner_id
 LEFT JOIN cursors c ON c.owner=pe.owner_id
 WHERE (pe.revision,cr.ordinal)>(COALESCE(c.revision,0),COALESCE(c.ordinal,0))
 ORDER BY pe.revision,cr.ordinal LIMIT 100`, raw)
	if err != nil {
		return nil
	}
	list := []legacyCatchRow{}
	for rows.Next() {
		var row legacyCatchRow
		var item []byte
		if err := rows.Scan(&row.op, &row.ordinal, &row.owner, &row.revision, &item,
			&row.groundID, &row.spotID, &row.caughtAt, &row.groundName, &row.spotName, &row.key, &row.name); err != nil {
			rows.Close()
			return nil
		}
		if json.Unmarshal(item, &row.item) != nil {
			rows.Close()
			return nil
		}
		if row.item.Kind == "fish" && row.item.Size != nil && row.item.Tier == "" {
			row.item.Tier = p.catalog.SizeTier(row.item.ID, *row.item.Size)
		}
		list = append(list, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil
	}
	// Moderation uses the same durable guard as the delete transaction. A
	// projection read failure leaves the revision pending for the next tick.
	var moderationRevision int64
	if err := p.api.pool.QueryRow(ctx, `SELECT revision FROM fishing.catch_record_moderation_guard WHERE singleton`).Scan(&moderationRevision); err != nil {
		return nil
	}
	moderationChanged := moderationRevision != p.moderationRevision
	var boards legacyCatchBoards
	if len(list) > 0 {
		boards, err = p.catchBoards(ctx, time.Now())
		if err != nil {
			return nil
		}
	}
	mode := p.notifyLevel(ctx)

	var activeGround string
	err = p.api.pool.QueryRow(ctx, `SELECT ground_id FROM fishing.native_fishing_sessions
 WHERE owner_id=$1 AND state='active'`, p.owner).Scan(&activeGround)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	feed := []map[string]any{}
	var global map[string]any
	globalLevel := 99
	recordsChanged := false
	for _, row := range list {
		item := legacyCatchItem(p.catalog, row.item)
		ground, spot := legacyCatchLocation(p.catalog, row.groundID, row.spotID, row.groundName, row.spotName)
		key := legacyCatchKey{row.op, row.ordinal}
		level, record := legacyCatchNoticeLevel(boards, key)
		visible := legacyFeedVisible(p.catalog, row.item, record, mode)
		if activeGround != "" && row.groundID == activeGround && visible {
			feed = append(feed, map[string]any{
				"t": row.caughtAt.UnixMilli(), "who": row.name,
				"item": legacySlimFeedItem(item), "ground": ground, "spot": spot, "size": row.item.Size,
			})
		}
		if row.item.Kind == "fish" && row.item.Size != nil {
			// Node invalidates the pull-based records view for every fish catch;
			// the daily/weekly board may change even when no banner is emitted.
			recordsChanged = true
		}
		if level > 0 && (len(list) < 100 || level == 1) {
			name := item["name"]
			text := fmt.Sprintf("📊 %v 今日榜单更新：%s %gcm", name, row.name, *row.item.Size)
			switch level {
			case 1:
				text = fmt.Sprintf("🎉 全场最大纪录被破！%s 钓到 %v %gcm", row.name, name, *row.item.Size)
			case 2:
				if boards.small[key] && !boards.big[key] {
					text = fmt.Sprintf("🏆 %v 全服最小纪录刷新：%s %gcm", name, row.name, *row.item.Size)
				} else {
					text = fmt.Sprintf("🏆 %v 全服最大纪录刷新：%s %gcm", name, row.name, *row.item.Size)
				}
			case 3:
				text = fmt.Sprintf("📊 %v 今日前十大更新：%s %gcm（第 %d 名）", name, row.name, *row.item.Size, boards.topBig[key])
			case 4:
				text = fmt.Sprintf("📊 %v 今日前十小更新：%s %gcm（第 %d 名）", name, row.name, *row.item.Size, boards.topSmall[key])
			}
			if bannerCatchAllowedLegacy(ctx, p.api, level) && (level < globalLevel || level == 1) {
				global = map[string]any{"id": row.item.ID, "name": name, "size": row.item.Size, "who": row.name,
					"key": row.key, "t": row.caughtAt.UnixMilli(), "level": level, "global": level == 1, "text": text}
				globalLevel = level
			}
		}
		if level == 1 && globalLevel != 1 {
			global = map[string]any{"id": row.item.ID, "name": item["name"], "size": row.item.Size, "who": row.name,
				"key": row.key, "t": row.caughtAt.UnixMilli(), "level": 1, "global": true,
				"text": fmt.Sprintf("🎉 全场最大纪录被破！%s 钓到 %v %gcm", row.name, item["name"], *row.item.Size)}
			globalLevel = 1
		}
	}
	frames := []string{}
	if len(feed) > 10 {
		feed = feed[len(feed)-10:]
	}
	if len(feed) > 0 {
		frames = append(frames, legacyFrame(map[string]any{"type": "feedBatch", "list": feed}))
	}
	// Any catch can affect personal/day/week rankings even if it is not a
	// historical extreme. This version is a stream-local invalidation token.
	if recordsChanged {
		p.version++
		frames = append(frames, legacyFrame(map[string]any{"type": "recordsDirty", "v": p.version}))
	}
	if global != nil {
		frames = append(frames, legacyFrame(map[string]any{"type": "globalRecord", "record": global}))
	}
	if moderationChanged {
		projection, projectionErr := p.api.legacyRecordsProjection(ctx, p.api.pool, p.catalog)
		if projectionErr != nil {
			return nil
		}
		p.version++
		frames = append(frames, legacyFrame(map[string]any{"type": "recordsDirty", "v": p.version}))
		frames = append(frames, legacyFrame(map[string]any{"type": "records", "records": projection["records"], "small": projection["small"], "last": projection["last"]}))
		p.moderationRevision = moderationRevision
	}
	// Failed reads leave the page pending. Reconnect starts a fresh baseline;
	// social history is not replayed into a new connection.
	for _, row := range list {
		p.cursors[row.owner] = legacyCatchCursor{row.owner, row.revision, row.ordinal}
	}
	return frames
}

// Social rows only need the same display fields as the legacy slimFeedEntry;
// full component affixes remain in the owner's catch and inventory frames.
func legacySlimFeedItem(item map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"id", "name", "kind", "rarity", "part", "quality", "size", "tier"} {
		if value, ok := item[key]; ok {
			out[key] = value
		}
	}
	return out
}
