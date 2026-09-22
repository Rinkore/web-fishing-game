package fishing

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
)

func TestIntegrationZoneEvictionRechecksAndRollsBack(t *testing.T) {
	f := nativeSetup(t)
	c := f.start()
	op := f.num(`SELECT max(id) FROM fishing.asset_operations`)
	z := rules.SeaZone{ID: "own", Name: "fixture", Expire: time.Now().Add(time.Hour).UnixMilli(), Spots: []rules.SeaSpot{{ID: "z1", Pool: []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}}}}
	raw, _ := json.Marshal(z)
	f.exec(`INSERT INTO fishing.sea_zones(owner_id,id,data,expires_at,created_operation) VALUES($1,'own',$2,clock_timestamp()+interval '1 hour',$3)`, f.owner, raw, op)
	f.exec(`UPDATE fishing.native_fishing_sessions SET ground_id=$2,spot_id='z1',due_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, c.SessionID, fmt.Sprintf("sea:%d:own", f.owner))
	// A stale discovery (e.g. anchor extended an expired zone) must leave the
	// command retryable, so a future real expiry cannot be hidden by a no-op.
	if _, err := f.s.EvictZoneGuest(f.ctx, c); err != assets.ErrDeferred {
		t.Fatal("valid owner evicted", err)
	}
	key := fmt.Sprintf("fishing:zone-evict:%d:%d", c.SessionID, c.Generation)
	if f.num(`SELECT count(*) FROM fishing.command_results WHERE request_key=$1`, key) != 0 {
		t.Fatal("deferred eviction cached")
	}
	for _, stop := range []func(Stop) (assets.Result, error){func(r Stop) (assets.Result, error) { return f.s.Stop(f.ctx, r) }, func(r Stop) (assets.Result, error) { return New(f.db.App).Stop(f.ctx, r) }} {
		if _, err := stop(Stop{ActorID: f.owner, RequestKey: key, Generation: c.Generation}); err != assets.ErrInvalid {
			t.Fatal("player occupied automatic key", err)
		}
	}
	if _, count, err := f.s.SweepZoneGuests(f.ctx, 0, 100); err != nil || count != 0 {
		t.Fatal("valid owner scanned", count, err)
	}
	f.exec(`UPDATE fishing.sea_zones SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, f.owner)
	f.exec(`CREATE FUNCTION fishing.fail_eviction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='fishing_stop' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_eviction BEFORE INSERT ON fishing.asset_operations FOR EACH ROW EXECUTE FUNCTION fishing.fail_eviction()`)
	if _, _, err := f.s.SweepZoneGuests(f.ctx, 0, 100); err == nil {
		t.Fatal("injected stop failure accepted")
	}
	if f.num(`SELECT count(*) FROM fishing.native_fishing_sessions WHERE id=$1 AND state='active' AND generation=$2`, c.SessionID, c.Generation) != 1 {
		t.Fatal("failed eviction partially stopped")
	}
	f.exec(`DROP TRIGGER fail_eviction ON fishing.asset_operations`)
	// Two worker instances may discover the same session. The stop and its
	// outbox event must commit once, both replies refer to that single result.
	var wg sync.WaitGroup
	var results [2]assets.Result
	var errs [2]error
	for i := range results {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errs[i] = f.s.EvictZoneGuest(f.ctx, c) }(i)
	}
	wg.Wait()
	for i := range results {
		f.want(results[i], errs[i], "stopped")
	}
	if results[0].OperationID != results[1].OperationID || f.num(`SELECT generation FROM fishing.native_fishing_sessions WHERE id=$1`, c.SessionID) != c.Generation+1 {
		t.Fatal("duplicate stop", results)
	}
	if _, count, err := f.s.SweepZoneGuests(f.ctx, 0, 100); err != nil || count != 0 {
		t.Fatal("stopped session scanned", count, err)
	}
	f.reconcile()
}
