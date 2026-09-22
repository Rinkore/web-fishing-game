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
	api     *API
	owner   int64
	catalog *rules.Catalog
	cursors map[int64]legacyCatchCursor
	version int64
	seeded  bool
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
	return map[string]any{"recordsVersion": p.version}
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
	type catchRow struct {
		op, ordinal, owner, revision int64
		groundID, spotID             string
		groundName, spotName         string
		item                         rules.Catch
		caughtAt                     time.Time
		key, name                    string
	}
	list := []catchRow{}
	for rows.Next() {
		var row catchRow
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
	if err != nil || len(list) == 0 {
		return nil
	}

	var activeGround string
	err = p.api.pool.QueryRow(ctx, `SELECT ground_id FROM fishing.native_fishing_sessions
 WHERE owner_id=$1 AND state='active'`, p.owner).Scan(&activeGround)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	// Read the current maximum once per page, not once per catch. Equal sizes
	// retain the first caught row and do not produce another maximum banner.
	var maxOp, maxOrd int64
	if err := p.api.pool.QueryRow(ctx, `SELECT cr.operation_id,cr.ordinal FROM fishing.catch_records cr
 WHERE NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='big')
 ORDER BY cr.size DESC,cr.caught_at,cr.operation_id,cr.ordinal LIMIT 1`).Scan(&maxOp, &maxOrd); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	feed := []map[string]any{}
	var global map[string]any
	recordsChanged := false
	for _, row := range list {
		item := legacyCatchItem(p.catalog, row.item)
		ground, spot := legacyCatchLocation(p.catalog, row.groundID, row.spotID, row.groundName, row.spotName)
		if activeGround != "" && row.groundID == activeGround {
			feed = append(feed, map[string]any{
				"t": row.caughtAt.UnixMilli(), "who": row.name,
				"item": legacySlimFeedItem(item), "ground": ground, "spot": spot, "size": row.item.Size,
			})
		}
		if row.item.Kind == "fish" && row.item.Size != nil {
			recordsChanged = true
		}
		if row.item.Kind == "fish" && row.item.Size != nil && maxOp == row.op && maxOrd == row.ordinal {
			global = map[string]any{"id": row.item.ID, "name": item["name"], "size": row.item.Size, "who": row.name,
				"key": row.key, "t": row.caughtAt.UnixMilli(), "level": 1,
				"text": fmt.Sprintf("🎉 全场最大纪录被破！%s 钓到 %s %gcm", row.name, item["name"], *row.item.Size)}
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
