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
 ) SELECT cr.operation_id,cr.ordinal,cr.owner_id,pe.revision,cr.item_id,cr.size,
 cr.ground_id,cr.spot_id,cr.caught_at,lower(i.username),i.display_name
 FROM fishing.player_events pe
 JOIN fishing.outbox_events e ON e.id=pe.outbox_id
 JOIN fishing.catch_records cr ON cr.operation_id=e.operation_id AND cr.owner_id=pe.owner_id
 JOIN fishing.identities i ON i.account_id=cr.owner_id
 LEFT JOIN cursors c ON c.owner=pe.owner_id
 WHERE (pe.revision,cr.ordinal)>(COALESCE(c.revision,0),COALESCE(c.ordinal,0))
 ORDER BY cr.operation_id,cr.ordinal LIMIT 100`, raw)
	if err != nil {
		return nil
	}
	type catchRow struct {
		op, ordinal, owner, revision int64
		itemID, groundID, spotID     string
		size                         float64
		caughtAt                     time.Time
		key, name                    string
	}
	list := []catchRow{}
	for rows.Next() {
		var row catchRow
		if err := rows.Scan(&row.op, &row.ordinal, &row.owner, &row.revision, &row.itemID, &row.size,
			&row.groundID, &row.spotID, &row.caughtAt, &row.key, &row.name); err != nil {
			rows.Close()
			return nil
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
	if err := p.api.pool.QueryRow(ctx, `SELECT operation_id,ordinal FROM fishing.catch_records
 ORDER BY size DESC,caught_at,operation_id,ordinal LIMIT 1`).Scan(&maxOp, &maxOrd); err != nil {
		return nil
	}
	groundNames, spotNames := map[string]string{}, map[string]string{}
	for _, g := range p.catalog.Grounds() {
		groundNames[g.ID] = g.Name
		for _, s := range g.Spots {
			spotNames[g.ID+":"+s.ID] = s.Name
		}
	}
	feed := []map[string]any{}
	var global map[string]any
	for _, row := range list {
		it, ok := p.catalog.Item(row.itemID)
		if !ok {
			continue
		}
		if activeGround != "" && row.groundID == activeGround {
			feed = append(feed, map[string]any{
				"t": row.caughtAt.UnixMilli(), "who": row.name,
				"item": map[string]any{"id": row.itemID, "name": it.Name, "kind": it.Kind, "rarity": it.Rarity,
					"size": row.size, "tier": sizeTierLabel(p.catalog.SizeTier(row.itemID, row.size))},
				"ground": groundNames[row.groundID], "spot": spotNames[row.groundID+":"+row.spotID], "size": row.size,
			})
		}
		if it.Kind == "fish" && maxOp == row.op && maxOrd == row.ordinal {
			global = map[string]any{"id": row.itemID, "name": it.Name, "size": row.size, "who": row.name,
				"key": row.key, "t": row.caughtAt.UnixMilli(), "level": 1,
				"text": fmt.Sprintf("🎉 全场最大纪录被破！%s 钓到 %s %gcm", row.name, it.Name, row.size)}
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
	p.version++
	frames = append(frames, legacyFrame(map[string]any{"type": "recordsDirty", "v": p.version}))
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
