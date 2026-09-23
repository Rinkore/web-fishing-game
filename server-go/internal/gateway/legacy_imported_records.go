package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const importedRecordsSetting = "migration:records"

type importedRankPair struct {
	Big   []legacyTopEntry `json:"big"`
	Small []legacyTopEntry `json:"small"`
}
type importedRecordState struct {
	Big      map[string]legacyRecordEntry                      `json:"bigRecords"`
	Small    map[string]legacyRecordEntry                      `json:"smallRecords"`
	Top      map[string][]legacyTopEntry                       `json:"topCatches"`
	TopSmall map[string][]legacyTopEntry                       `json:"topSmall"`
	Rank     map[string]map[string]map[string]importedRankPair `json:"rank"`
}

func importedRecords(ctx context.Context, q legacyRecordQueryer) (importedRecordState, error) {
	var state importedRecordState
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1`, importedRecordsSetting).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(raw, &state)
	return state, err
}
func mergeImportedRecordExtrema(ctx context.Context, q legacyRecordQueryer, big, small map[string]legacyRecordEntry) error {
	state, err := importedRecords(ctx, q)
	if err != nil {
		return err
	}
	for id, e := range state.Big {
		if old, ok := big[id]; !ok || e.Size > old.Size || e.Size == old.Size && e.T < old.T {
			big[id] = e
		}
	}
	for id, e := range state.Small {
		if old, ok := small[id]; !ok || e.Size < old.Size || e.Size == old.Size && e.T < old.T {
			small[id] = e
		}
	}
	return nil
}
func importedRankSlice(state importedRecordState, id string, small bool, scope string, loc *time.Location, now time.Time) []legacyTopEntry {
	if scope == "all" {
		if small {
			return state.TopSmall[id]
		}
		return state.Top[id]
	}
	if loc == nil {
		loc = time.Local
	}
	period := now.In(loc).Format("2006-01-02")
	if scope == "week" {
		period = mondayOf(now.In(loc)).Format("2006-01-02")
	}
	pair := state.Rank[scope][period][id]
	if small {
		return pair.Small
	}
	return pair.Big
}
func legacyRankIdentity(e legacyTopEntry) string {
	if e.OwnerID > 0 {
		return "account:" + strconv.FormatInt(e.OwnerID, 10)
	}
	if e.PlayerID != "" {
		return "source:" + e.PlayerID
	}
	return "name:" + e.Who
}
func mergeImportedRank(ctx context.Context, q legacyRecordQueryer, id string, small bool, scope string, loc *time.Location, now time.Time, native []legacyTopEntry) ([]legacyTopEntry, error) {
	state, err := importedRecords(ctx, q)
	if err != nil {
		return nil, err
	}
	old := importedRankSlice(state, id, small, scope, loc, now)
	if len(old) == 0 {
		return native, nil
	}
	rows, err := q.Query(ctx, `SELECT username,account_id FROM fishing.identities`)
	if err != nil {
		return nil, err
	}
	ids := map[string]int64{}
	for rows.Next() {
		var name string
		var owner int64
		if err = rows.Scan(&name, &owner); err != nil {
			rows.Close()
			return nil, err
		}
		ids[strings.ToLower(name)] = owner
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	all := append([]legacyTopEntry{}, native...)
	for _, e := range old {
		if e.PlayerID != "" {
			e.OwnerID = ids[strings.ToLower(e.PlayerID)]
		}
		all = append(all, e)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Size != all[j].Size {
			if small {
				return all[i].Size < all[j].Size
			}
			return all[i].Size > all[j].Size
		}
		return all[i].T < all[j].T
	})
	seen := map[string]bool{}
	out := []legacyTopEntry{}
	for _, e := range all {
		key := legacyRankIdentity(e)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
		if len(out) == 10 {
			break
		}
	}
	return out, nil
}

// Imported boards are source projections, not fabricated catch rows. Their
// moderation uses the same guarded transaction as new catch-record hides.
func removeImportedRecords(ctx context.Context, q legacyRecordQueryer, id string, selected *legacyTopEntry, scope, kind string, purge bool, loc *time.Location, now time.Time) error {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1 FOR UPDATE`, importedRecordsSetting).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	object := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	selectedUsername := ""
	if selected != nil && selected.OwnerID > 0 {
		if err := q.QueryRow(ctx, `SELECT username FROM fishing.identities WHERE account_id=$1`, selected.OwnerID).Scan(&selectedUsername); err != nil {
			return err
		}
	}
	selectedMatch := func(v any, allCandidates bool) bool {
		if selected == nil {
			return true
		}
		r := object(v)
		who, _ := r["who"].(string)
		player, _ := r["playerId"].(string)
		identity := who == selected.Who
		if selectedUsername != "" && player != "" {
			identity = strings.EqualFold(player, selectedUsername)
		} else if selected.PlayerID != "" && player != "" {
			identity = player == selected.PlayerID
		}
		if !identity {
			return false
		}
		if allCandidates {
			return true
		}
		size, _ := r["size"].(float64)
		return size == selected.Size
	}
	removeMap := func(m map[string]any, extrema bool, allCandidates bool) {
		for fish, v := range m {
			if id != "" && fish != id {
				continue
			}
			if extrema {
				if selectedMatch(v, false) {
					delete(m, fish)
				}
				continue
			}
			rows, _ := v.([]any)
			keep := []any{}
			for _, row := range rows {
				if !selectedMatch(row, allCandidates) {
					keep = append(keep, row)
				}
			}
			m[fish] = keep
		}
	}
	if selected == nil || purge {
		removeMap(object(doc["bigRecords"]), true, false)
		removeMap(object(doc["smallRecords"]), true, false)
	}
	if selected == nil || purge || scope == "all" {
		if selected == nil || purge || kind == "big" {
			removeMap(object(doc["topCatches"]), false, scope == "all" && !purge)
		}
		if selected == nil || purge || kind == "small" {
			removeMap(object(doc["topSmall"]), false, scope == "all" && !purge)
		}
	}
	if loc == nil {
		loc = time.Local
	}
	for board, periods := range object(doc["rank"]) {
		if selected != nil && !purge && board != scope {
			continue
		}
		period := now.In(loc).Format("2006-01-02")
		if board == "week" {
			period = mondayOf(now.In(loc)).Format("2006-01-02")
		}
		for date, fishValue := range object(periods) {
			if selected != nil && !purge && date != period {
				continue
			}
			for fish, pairValue := range object(fishValue) {
				if id != "" && fish != id {
					continue
				}
				pair := object(pairValue)
				for boardKind, v := range pair {
					if selected != nil && !purge && boardKind != kind {
						continue
					}
					holder := map[string]any{fish: v}
					removeMap(holder, false, !purge)
					pair[boardKind] = holder[fish]
				}
			}
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `UPDATE fishing.operator_settings SET value=$2,updated_at=clock_timestamp() WHERE key=$1`, importedRecordsSetting, encoded)
	return err
}
