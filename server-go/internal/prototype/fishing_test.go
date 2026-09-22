package prototype_test

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
)

func TestIntegrationCyclesAreAtomicAndIdempotent(t *testing.T) {
	f := setup(t)
	owner := f.player()
	c := f.start(owner, "caught-v1", false)
	if _, err := f.f.Settle(f.ctx, c); !errors.Is(err, assets.ErrDeferred) {
		t.Fatal("early candidate should be deferred")
	}
	if _, err := f.a.Lookup(f.ctx, owner, c.Key()); !errors.Is(err, assets.ErrNotFound) {
		t.Fatal("early candidate poisoned dedup key")
	}
	f.due(c)
	var wg sync.WaitGroup
	results := make(chan assets.Result, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.f.Settle(f.ctx, c)
			if err != nil {
				t.Error(err)
			}
			results <- r
		}()
	}
	wg.Wait()
	close(results)
	var first assets.Result
	for r := range results {
		if first.Status == "" {
			first = r
		}
		if r.Status != "settled" || !reflect.DeepEqual(r, first) {
			t.Error("duplicate did not replay exact cycle result")
		}
	}
	if f.qty(owner) != 2 || f.num(`SELECT next_seq FROM fishing.fishing_sessions WHERE id=$1`, c.SessionID) != 2 || f.num(`SELECT count(*) FROM fishing.fishing_settlements`) != 1 {
		t.Fatal("cycle duplicated or progress not advanced")
	}
	if f.num(`SELECT count(*) FROM fishing.fishing_sessions WHERE due_at>clock_timestamp()`) != 1 {
		t.Fatal("downtime catch-up scheduled")
	}
	wrong := c
	wrong.Sequence = 99
	r, err := f.f.Settle(f.ctx, wrong)
	f.want(r, err, "stale_cycle")
	// Empty casts are durable progress, not opportunities to reroll.
	e := f.start(f.player(), "empty-v1", false)
	f.due(e)
	r, err = f.f.Settle(f.ctx, e)
	f.want(r, err, "settled")
	if f.qty(e.OwnerID) != 0 || f.num(`SELECT next_seq FROM fishing.fishing_sessions WHERE id=$1`, e.SessionID) != 2 {
		t.Fatal("empty cycle failed to advance")
	}
	f.reconcile()
}

func TestIntegrationCycleFailureKeepsRandomAndProgress(t *testing.T) {
	for _, table := range []string{"fishing_settlements", "outbox_events"} {
		t.Run(table, func(t *testing.T) {
			f := setup(t)
			owner := f.player()
			c := f.start(owner, "random-v1", false)
			f.due(c)
			// Same independent PRF vector as random_test: session=1,gen=1,seq=1
			// with a zero synthetic seed catches (309391 < 500000).
			f.exec(`UPDATE fishing.fishing_sessions SET private_seed=decode(repeat('00',32),'hex') WHERE id=$1`, c.SessionID)
			beforeRev := f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, owner)
			f.exec(`CREATE FUNCTION fishing.fail_cycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_cycle BEFORE INSERT ON fishing.` + table + ` FOR EACH ROW EXECUTE FUNCTION fishing.fail_cycle()`)
			if _, err := f.f.Settle(f.ctx, c); !errors.Is(err, assets.ErrUnavailable) {
				t.Fatal("failure not exposed")
			}
			if f.qty(owner) != 0 || f.num(`SELECT next_seq FROM fishing.fishing_sessions WHERE id=$1`, c.SessionID) != 1 || f.num(`SELECT count(*) FROM fishing.fishing_settlements`) != 0 || f.num(`SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, owner) != beforeRev {
				t.Fatal("failed cycle left partial state")
			}
			if _, err := f.a.Lookup(f.ctx, owner, c.Key()); !errors.Is(err, assets.ErrNotFound) {
				t.Fatal("failed cycle persisted result")
			}
			f.exec(`DROP TRIGGER fail_cycle ON fishing.` + table + `; DROP FUNCTION fishing.fail_cycle()`)
			r, err := f.f.Settle(f.ctx, c)
			f.want(r, err, "settled")
			if f.qty(owner) != 2 {
				t.Fatal("retry changed seeded outcome")
			}
			if f.num(`SELECT count(*) FROM fishing.outbox_events WHERE payload::text LIKE '%private_seed%' OR payload::text LIKE '%randomSeed%'`) != 0 {
				t.Fatal("private random data exposed")
			}
			f.reconcile()
		})
	}
}

func TestIntegrationConnectionGenerationsStopAndLoadout(t *testing.T) {
	f := setup(t)
	owner := f.player()
	c := f.start(owner, "caught-v1", false)
	f.due(c)
	r, err := f.f.Stop(f.ctx, fishing.Stop{ActorID: owner, RequestKey: f.key(), Generation: c.Generation})
	f.want(r, err, "stopped")
	r, err = f.f.Settle(f.ctx, c)
	f.want(r, err, "stale_cycle")
	if f.qty(owner) != 0 {
		t.Fatal("stopped candidate awarded")
	}
	oldConn := f.num(`SELECT generation FROM fishing.fishing_connections WHERE owner_id=$1`, owner)
	newConn := f.connect(owner)
	r, err = f.f.Start(f.ctx, fishing.Start{ActorID: owner, RequestKey: f.key(), RuleVersion: "caught-v1", ConnectionGeneration: newConn})
	f.want(r, err, "started")
	c = fishing.Candidate{OwnerID: owner, SessionID: parse(t, r.ResourceID), Generation: r.Generation, Sequence: 1}
	f.due(c)
	r, err = f.f.Connection(f.ctx, fishing.Connection{ActorID: owner, RequestKey: f.key(), Action: "disconnect", Generation: oldConn})
	f.want(r, err, "stale_connection")
	gear := f.gear(owner)
	r, err = f.a.ChangeRod(f.ctx, assets.RodCommand{ActorID: owner, RequestKey: f.key(), Action: "equip", Part: "rod", EquipmentID: gear})
	f.want(r, err, "rod_updated")
	r, err = f.f.Settle(f.ctx, c)
	f.want(r, err, "rescheduled")
	if f.qty(owner) != 0 {
		t.Fatal("old loadout candidate awarded")
	}
	c.Generation = r.Generation
	c.Sequence = r.Sequence
	f.due(c)
	r, err = f.f.Settle(f.ctx, c)
	f.want(r, err, "settled")
	if f.qty(owner) != 2 {
		t.Fatal("rescheduled candidate failed")
	}
	c.Sequence++
	f.due(c)
	f.exec(`UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, owner)
	r, err = f.f.Connection(f.ctx, fishing.Connection{ActorID: owner, RequestKey: f.key(), Action: "heartbeat", Generation: newConn})
	f.want(r, err, "connection_expired")
	r, err = f.f.Settle(f.ctx, c)
	f.want(r, err, "paused")
	if f.qty(owner) != 2 {
		t.Fatal("offline reward")
	}
	f.reconcile()
}

func TestIntegrationStopAndSettlementRace(t *testing.T) {
	f := setup(t)
	for i := 0; i < 12; i++ {
		owner := f.player()
		c := f.start(owner, "caught-v1", false)
		f.due(c)
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var settled assets.Result
		go func() {
			defer wg.Done()
			<-start
			r, err := f.f.Settle(f.ctx, c)
			if err != nil {
				t.Error(err)
			}
			settled = r
		}()
		go func() {
			defer wg.Done()
			<-start
			r, err := f.f.Stop(f.ctx, fishing.Stop{ActorID: owner, RequestKey: fmt.Sprintf("stop-race-%d", i), Generation: c.Generation})
			if err != nil || r.Status != "stopped" {
				t.Errorf("stop: %s %v", r.Status, err)
			}
		}()
		close(start)
		wg.Wait()
		want := int64(0)
		if settled.Status == "settled" {
			want = 2
		} else if settled.Status != "stale_cycle" {
			t.Fatal(settled.Status)
		}
		if f.qty(owner) != want || f.num(`SELECT count(*) FROM fishing.fishing_sessions WHERE id=$1 AND state='stopped'`, c.SessionID) != 1 {
			t.Fatal("stop/settlement not serialized")
		}
	}
	f.reconcile()
}

func TestIntegrationSchedulerFairnessRecoveryAndAutoSell(t *testing.T) {
	f := setup(t)
	blocked := f.player()
	f.reward(blocked, 0, assets.MaxCoins)
	a := f.start(blocked, "caught-v1", false)
	f.due(a)
	b := f.start(f.player(), "caught-v1", true)
	f.due(b)
	after, stats, err := f.f.Sweep(f.ctx, fishing.Cursor{}, 1, 2)
	if err != nil || stats.Deferred != 1 {
		t.Fatalf("full bag not deferred: %+v %v", stats, err)
	}
	_, stats, err = f.f.Sweep(f.ctx, after, 1, 2)
	if err != nil || stats.Settled != 1 || f.balance(b.OwnerID) != 14 || f.qty(b.OwnerID) != 0 {
		t.Fatal("blocked oldest candidate starved later auto-sale")
	}
	// Recreating the scheduler/service loses no persisted candidate state.
	newService := fishing.New(f.db.App)
	r, err := f.a.ApplyChange(f.ctx, assets.Change{ActorID: blocked, RequestKey: f.key(), RuleVersion: "test-v1", Reason: "consume", Stacks: []assets.StackDelta{{ItemID: "fish", Tier: "normal", Quantity: -2}}})
	f.want(r, err, "applied")
	r, err = newService.Settle(f.ctx, a)
	f.want(r, err, "settled")
	if f.qty(blocked) != assets.MaxCoins {
		t.Fatal("deferred cycle did not recover")
	}
	c := f.start(f.player(), "large-v1", true)
	f.due(c)
	r, err = f.f.Settle(f.ctx, c)
	f.want(r, err, "settled")
	if f.balance(c.OwnerID) != 0 || f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND tier='large'`, c.OwnerID) != 2 {
		t.Fatal("automatic sale consumed reserved fish")
	}
	f.reconcile()
}
