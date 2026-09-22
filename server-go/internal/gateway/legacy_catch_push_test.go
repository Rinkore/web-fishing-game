package gateway

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func TestLegacyDailyRankRequiresFullBoardForAnnouncement(t *testing.T) {
	board := map[int64]legacyBoardValue{}
	for owner := int64(1); owner <= 10; owner++ {
		_, changed := legacyDailyRank(board, legacyBoardValue{owner: owner, key: legacyCatchKey{owner, 1}, sz: float64(owner), at: time.Unix(owner, 0)}, false)
		if !changed {
			t.Fatalf("initial owner %d did not enter board", owner)
		}
	}
	if len(board) != 10 {
		t.Fatalf("board length = %d", len(board))
	}
	rank, changed := legacyDailyRank(board, legacyBoardValue{owner: 11, key: legacyCatchKey{11, 1}, sz: 11, at: time.Unix(11, 0)}, false)
	if !changed || rank != 1 {
		t.Fatalf("full-board replacement = rank %d changed %v", rank, changed)
	}
	if _, changed = legacyDailyRank(board, legacyBoardValue{owner: 12, key: legacyCatchKey{12, 1}, sz: 0, at: time.Unix(12, 0)}, true); !changed {
		t.Fatal("small board replacement was not detected")
	}
}

// Stage the same atomic ledger/event boundary as a real catch, with explicit
// commit control to exercise operations that finish in reverse ID order.
func stageSocialCatches(t *testing.T, f *legacyTradeFixture, actor, key, ground string, count int, base float64) pgx.Tx {
	t.Helper()
	tx, err := f.db.Admin.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(f.ctx) })
	owner := f.id[actor]
	var rev, op, event int64
	if err = tx.QueryRow(f.ctx, `UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=$1 RETURNING assets_rev`, owner).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,$2,decode(repeat('22',32),'hex'))`, owner, key); err != nil {
		t.Fatal(err)
	}
	if err = tx.QueryRow(f.ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,'fishing_settle','test-v1') RETURNING id`, owner, key).Scan(&op); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, `INSERT INTO fishing.catch_records(operation_id,ordinal,owner_id,item_id,size,ground_id,spot_id,caught_at)
 SELECT $1,n,$2,'crucian',$5::float8+n,$3,'dock',clock_timestamp() FROM generate_series(1,$4::int) n`, op, owner, ground, count, base); err != nil {
		t.Fatal(err)
	}
	if err = tx.QueryRow(f.ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES($1,'assets_changed','{}') RETURNING id`, op).Scan(&event); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, `INSERT INTO fishing.player_events(owner_id,revision,outbox_id) VALUES($1,$2,$3)`, owner, rev, event); err != nil {
		t.Fatal(err)
	}
	return tx
}

func socialFrames(t *testing.T, frames []string) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, frame := range frames {
		var value map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(frame, "data: "))), &value); err != nil {
			t.Fatal(err)
		}
		out[value["type"].(string)] = value
	}
	return out
}

func TestIntegrationCatchPushAfterRecordModeration(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	f.expectPost("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, "trade_a", 200, "")
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	p := &legacyCatchPush{api: &API{pool: f.db.App}, owner: f.id["trade_a"], catalog: c}
	p.init(f.ctx)
	if !p.seeded {
		t.Fatal("cursor initialization failed")
	}
	old := stageSocialCatches(t, f, "trade_b", "moderated-record", "map", 1, 500)
	if err := old.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.catch_record_hides(operation_id,ordinal,item_id,board_range,board_kind,actor_id)
 SELECT operation_id,ordinal,item_id,'record','big',$1 FROM fishing.catch_records WHERE size=501`, f.id["trade_a"]); err != nil {
		t.Fatal(err)
	}
	current := stageSocialCatches(t, f, "trade_b", "new-visible-record", "map", 1, 40)
	if err := current.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	frames := socialFrames(t, p.poll(f.ctx))
	global := frames["globalRecord"]
	if global == nil || global["record"].(map[string]any)["size"] != float64(41) {
		t.Fatalf("hidden historical maximum suppressed the new visible record: %v", frames)
	}
	feed := frames["feedBatch"]
	if feed == nil {
		t.Fatal("record moderation suppressed catch history")
	}
	list := feed["list"].([]any)
	if len(list) != 2 || list[0].(map[string]any)["size"] != float64(501) || list[1].(map[string]any)["size"] != float64(41) || frames["recordsDirty"] == nil {
		t.Fatalf("moderation changed catch feed or invalidation: %v", frames)
	}
}

func TestIntegrationCatchPushCommitOrderPagingAndScope(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	f.expectPost("/api/fishing/start", `{"groundId":"map","spotId":"dock"}`, "trade_a", 200, "")
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	p := &legacyCatchPush{api: &API{pool: f.db.App}, owner: f.id["trade_a"], catalog: c}
	p.init(f.ctx)
	if !p.seeded {
		t.Fatal("cursor initialization failed")
	}
	late := stageSocialCatches(t, f, "trade_a", "late", "map", 1, 200)
	early := stageSocialCatches(t, f, "trade_b", "early", "map", 105, 0)
	if err := early.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	first := socialFrames(t, p.poll(f.ctx))
	if len(first["feedBatch"]["list"].([]any)) != 10 || first["globalRecord"] != nil {
		t.Fatalf("first page: %v", first)
	}
	if p.cursors[f.id["trade_b"]].Ordinal != 100 {
		t.Fatal("page cursor did not stop at 100")
	}
	second := socialFrames(t, p.poll(f.ctx))
	if len(second["feedBatch"]["list"].([]any)) != 5 {
		t.Fatalf("recursive tail lost: %v", second)
	}
	if second["globalRecord"]["record"].(map[string]any)["size"] != float64(105) {
		t.Fatal("missing maximum at page tail")
	}
	if len(p.poll(f.ctx)) != 0 {
		t.Fatal("idle poll repeated catches")
	}
	if err := late.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	third := socialFrames(t, p.poll(f.ctx))
	if third["globalRecord"]["record"].(map[string]any)["size"] != float64(201) {
		t.Fatal("late lower operation lost")
	}
	if third["recordsDirty"]["v"].(float64) <= second["recordsDirty"]["v"].(float64) {
		t.Fatal("invalidation token regressed")
	}
	other := stageSocialCatches(t, f, "trade_b", "other-ground", "elsewhere", 1, 300)
	if err := other.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	fourth := socialFrames(t, p.poll(f.ctx))
	if fourth["feedBatch"] != nil || fourth["recordsDirty"] == nil || fourth["globalRecord"] == nil {
		t.Fatalf("scope: %v", fourth)
	}
	// Ties preserve the first maximum, while ordinary catches must still
	// invalidate personal and daily rankings.
	tie := stageSocialCatches(t, f, "trade_b", "tie", "map", 1, 300)
	if err := tie.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	fifth := socialFrames(t, p.poll(f.ctx))
	if fifth["globalRecord"] != nil || fifth["recordsDirty"] == nil {
		t.Fatalf("equal maximum: %v", fifth)
	}
	reconnect := &legacyCatchPush{api: p.api, owner: p.owner, catalog: c}
	reconnect.init(f.ctx)
	if len(reconnect.poll(f.ctx)) != 0 {
		t.Fatal("reconnect replayed historical social events")
	}
	// A read error after fetching the page must not acknowledge it.
	retry := stageSocialCatches(t, f, "trade_b", "retry", "map", 1, 400)
	if err := retry.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(f.ctx, "REVOKE SELECT ON fishing.native_fishing_sessions FROM "+role); err != nil {
		t.Fatal(err)
	}
	if len(p.poll(f.ctx)) != 0 {
		t.Fatal("failed read emitted partial page")
	}
	if _, err := f.db.Admin.Exec(f.ctx, "GRANT SELECT ON fishing.native_fishing_sessions TO "+role); err != nil {
		t.Fatal(err)
	}
	if got := socialFrames(t, p.poll(f.ctx)); got["globalRecord"] == nil {
		t.Fatal("failed page was not retried")
	}
}
