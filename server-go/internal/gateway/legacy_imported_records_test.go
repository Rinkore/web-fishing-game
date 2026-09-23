package gateway

import (
	"context"
	"testing"
	"time"
)

func TestIntegrationImportedRecordsMergeAndModeration(t *testing.T) {
	f := newRecordAdminFixture(t)
	_, owner := f.register("imported_ranker", "Current player")
	now := recordTestTime()
	f.catch(owner, "crucian", 100, now)
	old := map[string]any{"size": 120, "who": "Historical display", "t": now.Add(-time.Hour).UnixMilli()}
	known := map[string]any{"size": 90, "who": "Previous display", "playerId": "imported_ranker", "t": now.Add(-2 * time.Hour).UnixMilli()}
	state := map[string]any{"bigRecords": map[string]any{"crucian": map[string]any{"id": "crucian", "name": "鲫鱼", "size": 120, "who": "Historical display", "t": old["t"]}}, "smallRecords": map[string]any{}, "topCatches": map[string]any{"crucian": []any{old, known}}, "topSmall": map[string]any{}, "rank": map[string]any{}}
	if _, err := f.db.Admin.Exec(context.Background(), `INSERT INTO fishing.operator_settings(key,value) VALUES($1,$2)`, importedRecordsSetting, []byte(jsonString(state))); err != nil {
		t.Fatal(err)
	}
	if got := f.records()["records"].(map[string]any)["crucian"].(map[string]any)["size"]; got != float64(120) {
		t.Fatal("historical extrema lost")
	}
	top := f.top("crucian", "all", "big")
	if len(top) != 2 || top[0].(map[string]any)["size"] != float64(120) || top[1].(map[string]any)["size"] != float64(100) {
		t.Fatal("source/native rank merge or identity deduplication failed")
	}
	before := f.authority()
	body := recordDeleteBody("crucian", "all", "big", 0, top[0].(map[string]any))
	body["purge"] = true
	code, response := f.admin("POST", "/api/admin/records/delone", jsonString(body))
	f.expect(code, response, 200, "")
	if before != f.authority() {
		t.Fatal("historical moderation changed immutable catches or assets")
	}
	top = f.top("crucian", "all", "big")
	if len(top) != 1 || top[0].(map[string]any)["size"] != float64(100) {
		t.Fatal("historical rank was not removed")
	}
	if got := f.records()["records"].(map[string]any)["crucian"].(map[string]any)["size"]; got != float64(100) {
		t.Fatal("historic title remained after purge")
	}
	// The selected native entry uses a numeric playerId, while the source used
	// a username and an older display name. Removing it must also hide the
	// inferior imported candidate for that same account on this board.
	code, response = f.admin("POST", "/api/admin/records/delone", jsonString(recordDeleteBody("crucian", "all", "big", 0, top[0].(map[string]any))))
	f.expect(code, response, 200, "")
	if len(f.top("crucian", "all", "big")) != 0 {
		t.Fatal("inferior source candidate reappeared after native moderation")
	}
	code, response = f.admin("POST", "/api/admin/records/delete", jsonString(map[string]any{"id": "crucian"}))
	f.expect(code, response, 200, "")
	if len(f.top("crucian", "all", "big")) != 0 {
		t.Fatal("full clear did not cover both sources")
	}
}

func TestImportedRankUsesLocalCalendar(t *testing.T) {
	loc := time.FixedZone("UTC+8", 8*3600)
	now := time.Date(2026, 9, 20, 20, 0, 0, 0, time.UTC)
	entry := legacyTopEntry{Size: 3, Who: "Synthetic"}
	state := importedRecordState{Rank: map[string]map[string]map[string]importedRankPair{"day": {"2026-09-21": {"crucian": {Big: []legacyTopEntry{entry}}}}, "week": {"2026-09-21": {"crucian": {Small: []legacyTopEntry{entry}}}}}}
	if len(importedRankSlice(state, "crucian", false, "day", loc, now)) != 1 || len(importedRankSlice(state, "crucian", true, "week", loc, now)) != 1 {
		t.Fatal("source rank used UTC day instead of configured timezone")
	}
}
