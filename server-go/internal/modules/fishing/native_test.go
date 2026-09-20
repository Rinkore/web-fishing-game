package fishing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

type nativeFixture struct {
	t     *testing.T
	db    testdb.DB
	s     *NativeService
	a     *assets.Service
	ctx   context.Context
	owner int64
	key   int
}

func nativeSetup(t *testing.T) *nativeFixture {
	t.Helper()
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	f := &nativeFixture{t: t, db: db, s: NewNative(db.App, c), a: assets.New(db.App), ctx: context.Background()}
	if err = workshop.SeedDefinitions(f.ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	if err = db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&f.owner); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO fishing.player_state(account_id) VALUES($1)`, f.owner)
	f.exec(`INSERT INTO fishing.wallets(account_id) VALUES($1)`, f.owner)
	return f
}
func (f *nativeFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Admin.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}
func (f *nativeFixture) num(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func (f *nativeFixture) next() string { f.key++; return fmt.Sprintf("native-test-%d", f.key) }
func (f *nativeFixture) want(r assets.Result, err error, status string) assets.Result {
	f.t.Helper()
	if err != nil || r.Status != status {
		f.t.Fatalf("want %s, got %+v / %v", status, r, err)
	}
	return r
}
func (f *nativeFixture) connect() int64 {
	r, e := New(f.db.App).Connection(f.ctx, Connection{ActorID: f.owner, RequestKey: f.next(), Action: "connect"})
	return f.want(r, e, "connected").Generation
}
func (f *nativeFixture) start() Candidate {
	f.t.Helper()
	r, e := f.s.Start(f.ctx, NativeStart{ActorID: f.owner, RequestKey: f.next(), ConnectionGeneration: f.connect(), GroundID: "map", SpotID: "dock"})
	f.want(r, e, "started")
	id, _ := strconv.ParseInt(r.ResourceID, 10, 64)
	c := Candidate{f.owner, id, r.Generation, 1}
	f.exec(`UPDATE fishing.native_fishing_sessions SET private_seed=decode(repeat('12',32),'hex'),due_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, id)
	f.exec(`UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()+interval '1 hour' WHERE owner_id=$1`, f.owner)
	return c
}
func (f *nativeFixture) due(c Candidate) {
	f.exec(`UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, c.SessionID)
}
func (f *nativeFixture) spot(pool []rules.LootEntry, buffs []rules.Buff, bite float64) {
	// Synthetic catalog fixture, never a runtime override. Keep real item and
	// equipment rules while controlling only the pool and bite outcome.
	g := f.s.catalog.Grounds()
	g[0].Spots[0].Pool = pool
	g[0].Spots[0].Buffs = buffs
	g[0].Spots[0].BiteRate = bite
	raw, _ := json.Marshal(g)
	f.s.catalog.Constants["GROUNDS"] = raw
}
func (f *nativeFixture) expected(c Candidate) []rules.Catch {
	_, spot, _ := f.s.catalog.FishingSpot("map", "dock")
	eff, _ := rules.MergeEffects(rules.EmptyEffects(), spot.Spot)
	info := f.s.catalog.CastRules(nil).Info(rules.EmptyEffects(), spot.Spot)
	pool, err := f.s.catalog.BoostPool(spot.Pool, nil, eff, f.s.catalog.DefaultLootConfig())
	if err != nil {
		f.t.Fatal(err)
	}
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 0x12
	}
	rng := rules.Stream(seed, nativeKey(c))
	out := []rules.Catch{}
	if rng()*100 < f.s.catalog.CastRules(nil).Bite(eff, info.Interval, spot.Spot) {
		w := rules.NewCatchWalk()
		for !w.Done() {
			_, err := w.Advance(f.ctx, 128, eff["double"], 0, rng, rules.CatchHooks{Enter: func() (bool, error) {
				v, ok := f.s.catalog.ResolveCatch(pool, eff, rng)
				if ok {
					out = append(out, v)
				}
				return ok, nil
			}, Leave: func() error { return nil }})
			if err != nil {
				f.t.Fatal(err)
			}
		}
	}
	return out
}
func (f *nativeFixture) reconcile() {
	f.t.Helper()
	for _, q := range []string{
		`SELECT count(*) FROM fishing.inventory_stacks s WHERE quantity<>(SELECT COALESCE(sum(delta),0) FROM fishing.inventory_entries e WHERE e.owner_id=s.owner_id AND e.item_id=s.item_id AND e.tier=s.tier)`,
		`SELECT count(*) FROM fishing.asset_operations o WHERE NOT EXISTS(SELECT 1 FROM fishing.outbox_events e WHERE e.operation_id=o.id)`,
		`SELECT count(*) FROM fishing.player_state p WHERE catch_count<>(SELECT COALESCE(sum(caught),0) FROM fishing.native_fishing_settlements s JOIN fishing.native_fishing_sessions n ON n.id=s.session_id WHERE n.owner_id=p.account_id)`,
		`SELECT count(*) FROM fishing.command_results WHERE result IS NULL`,
		`SELECT count(*) FROM fishing.outbox_events WHERE payload::text LIKE '%private_seed%' OR payload::text LIKE '%frames%'`,
	} {
		if n := f.num(q); n != 0 {
			f.t.Fatalf("reconciliation mismatch: %d for %s", n, q)
		}
	}
}

func TestIntegrationNativeCatchReplayAndRecords(t *testing.T) {
	f := nativeSetup(t)
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, []rules.Buff{{Type: "size", Value: 300.}}, 100)
	c := f.start()
	want := f.expected(c)
	if len(want) != 1 || want[0].Tier != "giant" {
		t.Fatal("fixture", want)
	}
	var results [8]assets.Result
	var errs [8]error
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() { defer wg.Done(); results[i], errs[i] = f.s.Settle(f.ctx, c) }()
	}
	wg.Wait()
	for i, r := range results {
		f.want(r, errs[i], "settled")
		// JSONB preserves values but canonicalizes whitespace inside Details.
		var got, want any
		encoded, _ := json.Marshal(r)
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		encoded, _ = json.Marshal(results[0])
		if err := json.Unmarshal(encoded, &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatal("replay changed")
		}
	}
	if f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) != 1 || f.num(`SELECT count FROM fishing.player_codex WHERE owner_id=$1`, f.owner) != 1 || f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND tier='giant'`, f.owner) != 1 {
		t.Fatal("duplicate rewards")
	}
	for _, small := range []bool{false, true} {
		for _, owner := range []int64{0, f.owner} {
			records, err := f.s.Records(f.ctx, owner, "crucian", small, 10)
			if err != nil || len(records) != 1 || records[0].Size != *want[0].Size {
				t.Fatal("record", records, err)
			}
		}
	}
	// Selling/consuming a catch must not erase its personal or world record.
	r, e := f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.next(), Reason: "consume", RuleVersion: "test", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "giant", Quantity: -1}}})
	f.want(r, e, "applied")
	if f.num(`SELECT count(*) FROM fishing.catch_records`) != 1 {
		t.Fatal("record erased")
	}
	if _, err := f.db.App.Exec(f.ctx, `DELETE FROM fishing.catch_records`); err == nil {
		t.Fatal("runtime can erase records")
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DELETE FROM fishing.catch_records`); err == nil {
		t.Fatal("record immutability missing")
	}
	f.reconcile()
}

func TestIntegrationNativeRecursiveLootAndEquipment(t *testing.T) {
	for _, pick := range []string{"fish:crucian", "material:rope", "component:"} {
		t.Run(pick, func(t *testing.T) {
			f := nativeSetup(t)
			f.spot([]rules.LootEntry{{Pick: pick, Weight: 1}}, []rules.Buff{{Type: "double", Value: 120.}}, 100)
			c := f.start()
			maxCount := 0
			for i := 0; i < 30; i++ {
				want := f.expected(c)
				maxCount = max(maxCount, len(want))
				r, e := f.s.Settle(f.ctx, c)
				f.want(r, e, "settled")
				if f.num(`SELECT caught FROM fishing.native_fishing_settlements WHERE session_id=$1 AND seq=$2`, c.SessionID, c.Sequence) != int64(len(want)) {
					t.Fatal("lost recursive catch")
				}
				if pick == "component:" {
					rows, e := f.db.App.Query(f.ctx, `SELECT attributes->>'signature' FROM fishing.equipment_instances WHERE created_operation=$1 ORDER BY id`, r.OperationID)
					if e != nil {
						t.Fatal(e)
					}
					var actual []string
					for rows.Next() {
						var sig string
						if e = rows.Scan(&sig); e != nil {
							t.Fatal(e)
						}
						actual = append(actual, sig)
					}
					e = rows.Err()
					rows.Close()
					if e != nil {
						t.Fatal(e)
					}
					expected := []string{}
					for _, v := range want {
						expected = append(expected, v.ID)
					}
					if !reflect.DeepEqual(actual, expected) {
						t.Fatal("equipment order mismatch", actual, expected)
					}
				}
				c.Sequence++
				f.due(c)
				if maxCount > 3 {
					break
				}
			}
			if maxCount <= 3 {
				t.Fatal("no recursive sample >3")
			}
			f.reconcile()
		})
	}
}

func TestIntegrationNativeFailureRollsBackAndRetriesSameCatch(t *testing.T) {
	for _, table := range []string{"catch_records", "player_codex", "inventory_entries", "native_fishing_settlements", "outbox_events", "player_events"} {
		t.Run(table, func(t *testing.T) {
			f := nativeSetup(t)
			f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 100)
			c := f.start()
			want := f.expected(c)
			before := f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, f.owner)
			f.exec(`CREATE FUNCTION fishing.fail_native() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fail_native BEFORE INSERT ON fishing.` + table + ` FOR EACH ROW EXECUTE FUNCTION fishing.fail_native()`)
			if _, err := f.s.Settle(f.ctx, c); err == nil {
				t.Fatal("failure not exposed")
			}
			for _, q := range []string{`SELECT count(*) FROM fishing.catch_records`, `SELECT count(*) FROM fishing.player_codex`, `SELECT count(*) FROM fishing.inventory_stacks`, `SELECT count(*) FROM fishing.native_fishing_settlements`} {
				if f.num(q) != 0 {
					t.Fatal("partial state", q)
				}
			}
			if f.num(`SELECT next_seq FROM fishing.native_fishing_sessions WHERE id=$1`, c.SessionID) != 1 || f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, f.owner) != before || f.num(`SELECT count(*) FROM fishing.command_results WHERE request_key=$1`, nativeKey(c)) != 0 {
				t.Fatal("failure progressed cycle")
			}
			f.exec(`DROP TRIGGER fail_native ON fishing.` + table)
			r, e := NewNative(f.db.App, f.s.catalog).Settle(f.ctx, c)
			f.want(r, e, "settled")
			records, e := f.s.Records(f.ctx, 0, "crucian", false, 10)
			if e != nil || len(records) != 1 || records[0].Size != *want[0].Size {
				t.Fatal("retry rerolled", records, e)
			}
			f.reconcile()
		})
	}
}

func TestIntegrationNativePresenceLoadoutAndScheduler(t *testing.T) {
	f := nativeSetup(t)
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 100)
	c := f.start()
	// Real equip command advances loadout revision under the same player lock.
	r, e := f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.next(), Reason: "reward", RuleVersion: "fixture", Create: []assets.EquipmentSpec{{DefinitionID: "rod_bamboo", Part: "rod", Attributes: json.RawMessage(`{"signature":"rod_bamboo#mythic#spd+50,size+300"}`)}}})
	f.want(r, e, "applied")
	gear, _ := strconv.ParseInt(r.EquipmentIDs[0], 10, 64)
	r, e = f.a.ChangeRod(f.ctx, assets.RodCommand{ActorID: f.owner, RequestKey: f.next(), Action: "equip", Part: "rod", EquipmentID: gear})
	f.want(r, e, "rod_updated")
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "rescheduled")
	c.Generation = r.Generation
	c.Sequence = r.Sequence
	if f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) != 0 {
		t.Fatal("caught with obsolete loadout")
	}
	if _, e = f.s.Settle(f.ctx, c); !errors.Is(e, assets.ErrDeferred) {
		t.Fatal("early cycle", e)
	}
	f.due(c)
	_, batch, e := NewNative(f.db.App, f.s.catalog).Sweep(f.ctx, Cursor{}, 100, 2)
	if e != nil || batch.Settled != 1 || batch.Failed != 0 {
		t.Fatal("restart scheduler", batch, e)
	}
	if f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE tier='giant'`) != 1 {
		t.Fatal("equipped size effect omitted")
	}
	c.Sequence++
	f.due(c)
	f.exec(`UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, f.owner)
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "paused")
	if f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) != 1 {
		t.Fatal("offline catch")
	}
	c = f.start()
	old := c
	f.connect()
	r, e = f.s.Settle(f.ctx, old)
	f.want(r, e, "stale_cycle")
	f.reconcile()
}

func TestIntegrationNativeEmptyStopRaceAndLimits(t *testing.T) {
	f := nativeSetup(t)
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 0)
	c := f.start()
	r, e := f.s.Settle(f.ctx, c)
	f.want(r, e, "settled")
	if f.num(`SELECT caught FROM fishing.native_fishing_settlements`) != 0 || f.num(`SELECT next_seq FROM fishing.native_fishing_sessions`) != 2 {
		t.Fatal("empty cast did not progress")
	}
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 100)
	c.Sequence++
	f.due(c)
	var wg sync.WaitGroup
	var result assets.Result
	var settleErr error
	wg.Add(1)
	go func() { defer wg.Done(); result, settleErr = f.s.Settle(f.ctx, c) }()
	r, e = f.s.Stop(f.ctx, Stop{ActorID: f.owner, RequestKey: f.next(), Generation: c.Generation})
	f.want(r, e, "stopped")
	wg.Wait()
	if settleErr != nil || (result.Status != "settled" && result.Status != "stale_cycle") {
		t.Fatal(result, settleErr)
	}
	f.reconcile()
	connection := f.connect()
	for spot, status := range map[string]string{"ice": "spot_locked", "shore": "sea_fishing_pending", "reef": "sea_fishing_pending", "absent": "unknown_spot"} {
		r, e = f.s.Start(f.ctx, NativeStart{ActorID: f.owner, RequestKey: f.next(), ConnectionGeneration: connection, GroundID: "map", SpotID: spot})
		f.want(r, e, status)
	}
	// Cancellation may not leave random progress or a cached failure.
	c = f.start()
	ctx, cancel := context.WithCancel(f.ctx)
	cancel()
	if _, e = f.s.Settle(ctx, c); e == nil {
		t.Fatal("cancel accepted")
	}
	if f.num(`SELECT count(*) FROM fishing.command_results WHERE request_key=$1`, nativeKey(c)) != 0 {
		t.Fatal("cancellation cached")
	}
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "settled")
	// A mismatched executable version cannot silently reinterpret a session.
	c.Sequence++
	f.due(c)
	f.exec(`UPDATE fishing.native_fishing_sessions SET rule_version='other-version' WHERE id=$1`, c.SessionID)
	if _, e = f.s.Settle(f.ctx, c); !errors.Is(e, assets.ErrDeferred) {
		t.Fatal("version mismatch", e)
	}
	if f.num(`SELECT count(*) FROM fishing.command_results WHERE request_key=$1`, nativeKey(c)) != 0 {
		t.Fatal("version mismatch cached")
	}
}

func TestIntegrationNativeTimeoutHasNoPartialRewards(t *testing.T) {
	f := nativeSetup(t)
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, []rules.Buff{{Type: "double", Value: 1e20}}, 100)
	c := f.start()
	ctx, cancel := context.WithTimeout(f.ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := f.s.Settle(ctx, c); err == nil {
		t.Fatal("unbounded chain unexpectedly committed")
	}
	if f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) != 0 || f.num(`SELECT count(*) FROM fishing.inventory_stacks`) != 0 || f.num(`SELECT count(*) FROM fishing.player_codex`) != 0 || f.num(`SELECT next_seq FROM fishing.native_fishing_sessions`) != 1 {
		t.Fatal("timeout left partial state")
	}
	f.reconcile()
}

func TestIntegrationNativeCapacityAndEquipmentRollback(t *testing.T) {
	f := nativeSetup(t)
	f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 100)
	c := f.start()
	r, e := f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.next(), RuleVersion: "fixture", Reason: "reward", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "normal", Quantity: assets.MaxCoins}}})
	f.want(r, e, "applied")
	if _, e = f.s.Settle(f.ctx, c); e != assets.ErrDeferred {
		t.Fatal("capacity must defer without losing cycle", e)
	}
	if f.num(`SELECT count(*) FROM fishing.catch_records`) != 0 || f.num(`SELECT count(*) FROM fishing.player_codex`) != 0 {
		t.Fatal("capacity rejection left a record")
	}
	r, e = f.a.ApplyChange(f.ctx, assets.Change{ActorID: f.owner, RequestKey: f.next(), RuleVersion: "fixture", Reason: "consume", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "normal", Quantity: -1}}})
	f.want(r, e, "applied")
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "settled")
	f.reconcile()
	f.spot([]rules.LootEntry{{Pick: "component:", Weight: 1}}, nil, 100)
	c = f.start()
	want := f.expected(c)
	f.exec(`CREATE FUNCTION fishing.fail_gear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;CREATE TRIGGER fail_gear BEFORE INSERT ON fishing.equipment_entries FOR EACH ROW EXECUTE FUNCTION fishing.fail_gear()`)
	if _, e = f.s.Settle(f.ctx, c); e == nil {
		t.Fatal("equipment fault not exposed")
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances`) != 0 {
		t.Fatal("orphan equipment")
	}
	f.exec(`DROP TRIGGER fail_gear ON fishing.equipment_entries`)
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "settled")
	var sig string
	if e = f.db.App.QueryRow(f.ctx, `SELECT attributes->>'signature' FROM fishing.equipment_instances WHERE created_operation=$1`, r.OperationID).Scan(&sig); e != nil || len(want) != 1 || sig != want[0].ID {
		t.Fatal("equipment retry rerolled", sig, e)
	}
	f.reconcile()
}
