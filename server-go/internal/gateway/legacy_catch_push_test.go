package gateway

import (
	"encoding/json"
	"strings"
	"testing"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

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
