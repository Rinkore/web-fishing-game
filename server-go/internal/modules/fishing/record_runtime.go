package fishing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

const legacyRecordsRuntimeSetting = "legacy:records_runtime"

// persistLegacyRecordRuntime stores the latest board announcement in the same
// asset transaction as the catch ledger. The gateway still recomputes the
// complete historical projection for replay, while this marker preserves the
// legacy server lastRec contract across restarts and HTTP reads.
func (s *NativeService) persistLegacyRecordRuntime(ctx context.Context, t *assets.Transaction, owner int64, catches []rules.Catch, now time.Time) error {
	if len(catches) == 0 {
		return nil
	}
	if s.location != nil {
		now = now.In(s.location)
	}
	var who string
	if err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT display_name FROM fishing.identities WHERE account_id=$1),$1::text)`, owner).Scan(&who); err != nil {
		return err
	}
	var operation int64 = t.OperationID()
	var last map[string]any
	for ordinal, item := range catches {
		if item.Kind != "fish" || item.Size == nil || *item.Size <= 0 {
			continue
		}
		id, size := item.ID, *item.Size
		level, small, err := s.legacyRecordLevel(ctx, t, operation, int64(ordinal+1), owner, id, size, now)
		if err != nil {
			return err
		}
		if level == 0 {
			continue
		}
		name := id
		if it, ok := s.catalog.Item(id); ok {
			name = it.Name
		}
		text := fmt.Sprintf("📊 %s 今日榜单更新：%s %gcm", name, who, size)
		switch level {
		case 1:
			text = fmt.Sprintf("🎉 全场最大纪录被破！%s 钓到 %s %gcm", who, name, size)
		case 2:
			if small {
				text = fmt.Sprintf("🏆 %s 全服最小纪录刷新：%s %gcm", name, who, size)
			} else {
				text = fmt.Sprintf("🏆 %s 全服最大纪录刷新：%s %gcm", name, who, size)
			}
		}
		last = map[string]any{"id": id, "name": name, "size": size, "who": who, "t": now.UnixMilli(), "level": level, "text": text, "global": level == 1}
	}
	if last == nil {
		return nil
	}
	raw, err := json.Marshal(map[string]any{"lastRec": last})
	if err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp())
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, legacyRecordsRuntimeSetting, raw)
	return err
}

func (s *NativeService) legacyRecordLevel(ctx context.Context, t *assets.Transaction, operation, ordinal, owner int64, id string, size float64, now time.Time) (int, bool, error) {
	var op, ord int64
	var small bool
	err := t.SQL().QueryRow(ctx, `SELECT operation_id,ordinal,false FROM fishing.catch_records cr
 WHERE NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='big')
	AND (cr.operation_id<$1 OR cr.operation_id=$1 AND cr.ordinal<=$2)
	 ORDER BY cr.size DESC,cr.caught_at,cr.operation_id,cr.ordinal LIMIT 1`, operation, ordinal).Scan(&op, &ord, &small)
	if err == nil && op == operation && ord == ordinal {
		return 1, false, nil
	}
	if err != nil && !isNoRows(err) {
		return 0, false, err
	}
	if err = t.SQL().QueryRow(ctx, `SELECT operation_id,ordinal,false FROM fishing.catch_records cr
 WHERE cr.item_id=$1 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='big')
	 AND (cr.operation_id<$2 OR cr.operation_id=$2 AND cr.ordinal<=$3)
	 ORDER BY cr.size DESC,cr.caught_at,cr.operation_id,cr.ordinal LIMIT 1`, id, operation, ordinal).Scan(&op, &ord, &small); err == nil && op == operation && ord == ordinal {
		return 2, false, nil
	} else if err != nil && !isNoRows(err) {
		return 0, false, err
	}
	if err = t.SQL().QueryRow(ctx, `SELECT operation_id,ordinal,true FROM fishing.catch_records cr
 WHERE cr.item_id=$1 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='record' AND h.board_kind='small')
	 AND (cr.operation_id<$2 OR cr.operation_id=$2 AND cr.ordinal<=$3)
	 ORDER BY cr.size,cr.caught_at,cr.operation_id,cr.ordinal LIMIT 1`, id, operation, ordinal).Scan(&op, &ord, &small); err == nil && op == operation && ord == ordinal {
		return 2, true, nil
	} else if err != nil && !isNoRows(err) {
		return 0, false, err
	}
	// A catch can be a daily top-ten update without being a new extreme. Count
	// the better visible catch per player and retain the first ten positions.
	var rank int
	var prior int
	if err = t.SQL().QueryRow(ctx, `SELECT count(*) FROM (SELECT owner_id FROM fishing.catch_records cr
	 WHERE item_id=$1 AND caught_at>=$2 AND caught_at<$3 AND (cr.operation_id<$4 OR cr.operation_id=$4 AND cr.ordinal<$5)
	 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='day' AND h.board_kind='big') GROUP BY owner_id) q`, id, dayStart(now), dayStart(now).AddDate(0, 0, 1), operation, ordinal).Scan(&prior); err != nil {
		return 0, false, err
	}
	err = t.SQL().QueryRow(ctx, `WITH best AS (
 SELECT owner_id,MAX(size) AS size FROM fishing.catch_records cr
 WHERE item_id=$1 AND caught_at>=$2 AND caught_at<$3
 AND (cr.operation_id<$5 OR cr.operation_id=$5 AND cr.ordinal<=$6)
 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='day' AND h.board_kind='big')
 GROUP BY owner_id
	 ) SELECT count(*)+1 FROM best WHERE size>$4`, id, dayStart(now), dayStart(now).AddDate(0, 0, 1), size, operation, ordinal).Scan(&rank)
	if err == nil && prior >= 10 && rank <= 10 {
		return 3, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if err = t.SQL().QueryRow(ctx, `SELECT count(*) FROM (SELECT owner_id FROM fishing.catch_records cr
	 WHERE item_id=$1 AND caught_at>=$2 AND caught_at<$3 AND (cr.operation_id<$4 OR cr.operation_id=$4 AND cr.ordinal<$5)
	 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='day' AND h.board_kind='small') GROUP BY owner_id) q`, id, dayStart(now), dayStart(now).AddDate(0, 0, 1), operation, ordinal).Scan(&prior); err != nil {
		return 0, false, err
	}
	err = t.SQL().QueryRow(ctx, `WITH best AS (
 SELECT owner_id,MIN(size) AS size FROM fishing.catch_records cr
 WHERE item_id=$1 AND caught_at>=$2 AND caught_at<$3
 AND (cr.operation_id<$5 OR cr.operation_id=$5 AND cr.ordinal<=$6)
 AND NOT EXISTS (SELECT 1 FROM fishing.catch_record_hides h WHERE h.operation_id=cr.operation_id AND h.ordinal=cr.ordinal AND h.board_range='day' AND h.board_kind='small')
 GROUP BY owner_id
 ) SELECT count(*)+1 FROM best WHERE size<$4`, id, dayStart(now), dayStart(now).AddDate(0, 0, 1), size, operation, ordinal).Scan(&rank)
	if err == nil && prior >= 10 && rank <= 10 {
		return 4, true, nil
	}
	if err != nil {
		return 0, false, err
	}
	return 0, false, nil
}

func dayStart(now time.Time) time.Time {
	y, m, d := now.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, now.Location())
}

func isNoRows(err error) bool {
	return err == pgx.ErrNoRows
}
