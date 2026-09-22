package prototype_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/market"
)

func TestIntegrationLastLotHasOnlyOneBuyer(t *testing.T) {
	f := setup(t)
	seller, a, b := f.player(), f.player(), f.player()
	f.reward(seller, 0, 1)
	f.reward(a, 100, 0)
	f.reward(b, 100, 0)
	id := f.lot(seller, 1, 0, 30, time.Hour)
	if f.qty(seller) != 0 {
		t.Fatal("listing did not escrow stock")
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan assets.Result, 2)
	for i, buyer := range []int64{a, b} {
		wg.Add(1)
		go func(i int, buyer int64) {
			defer wg.Done()
			<-start
			r, err := f.m.Buy(f.ctx, market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 30, RequestKey: fmt.Sprintf("buy-%d", i)})
			if err != nil {
				t.Error(err)
			}
			results <- r
		}(i, buyer)
	}
	close(start)
	wg.Wait()
	close(results)
	success := 0
	for r := range results {
		if r.Status == "purchased" {
			success++
		} else if r.Status != "listing_closed" {
			t.Fatal(r.Status)
		}
	}
	if success != 1 || f.qty(a)+f.qty(b) != 1 || f.balance(a)+f.balance(b) != 170 || f.balance(seller) != 30 {
		t.Fatal("purchase lost or duplicated assets")
	}
	// Both winning and losing requests retain their original terminal outcome.
	for i, buyer := range []int64{a, b} {
		r, err := f.m.Buy(f.ctx, market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 30, RequestKey: fmt.Sprintf("buy-%d", i)})
		if err != nil || r.Status != "purchased" && r.Status != "listing_closed" {
			t.Fatal("replay changed")
		}
	}
	f.reconcile()
}

func TestIntegrationMarketEquipmentAndGuardedOwnership(t *testing.T) {
	f := setup(t)
	seller, buyer := f.player(), f.player()
	f.reward(buyer, 100, 0)
	gear := f.gear(seller)
	id := f.lot(seller, 0, gear, 25, time.Hour)
	r, err := f.a.ChangeRod(f.ctx, assets.RodCommand{ActorID: seller, RequestKey: f.key(), Action: "equip", Part: "rod", EquipmentID: gear})
	f.want(r, err, "equipment_unavailable")
	r, err = f.a.ExchangeAssets(f.ctx, assets.Exchange{ActorID: seller, RecipientID: buyer, RequestKey: f.key(), Equipment: []int64{gear}})
	f.want(r, err, "equipment_unavailable")
	r, err = f.m.Close(f.ctx, market.Close{ActorID: buyer, ListingID: id, RequestKey: f.key()})
	f.want(r, err, "not_listing_owner")
	r, err = f.m.Buy(f.ctx, market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 26, RequestKey: f.key()})
	f.want(r, err, "price_changed")
	r, err = f.m.Buy(f.ctx, market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 25, RequestKey: f.key()})
	f.want(r, err, "purchased")
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND owner_id=$2 AND lifecycle='available' AND escrow_listing_id IS NULL AND attributes->'affix'->>'value'='-2.5'`, gear, buyer) != 1 {
		t.Fatal("equipment ownership or attributes changed incorrectly")
	}
	r, err = f.a.ChangeRod(f.ctx, assets.RodCommand{ActorID: buyer, RequestKey: f.key(), Action: "equip", Part: "rod", EquipmentID: gear})
	f.want(r, err, "rod_updated")
	r, err = f.m.List(f.ctx, market.List{ActorID: buyer, RequestKey: f.key(), EquipmentID: gear, Price: 10, Lifetime: time.Hour})
	f.want(r, err, "equipment_locked")
	if f.num(`SELECT count(*) FROM fishing.market_listings`) != 1 {
		t.Fatal("failed bound listing leaked row")
	}
	f.reconcile()
}

func TestIntegrationMarketFailureRollsBackPaymentAndEscrow(t *testing.T) {
	for _, gearLot := range []bool{false, true} {
		t.Run(fmt.Sprintf("gear-%v", gearLot), func(t *testing.T) {
			f := setup(t)
			seller, buyer := f.player(), f.player()
			f.reward(seller, 0, 3)
			f.reward(buyer, 100, 0)
			gear := int64(0)
			qty := int64(3)
			if gearLot {
				gear = f.gear(seller)
				qty = 0
			}
			id := f.lot(seller, qty, gear, 25, time.Hour)
			f.exec(`CREATE FUNCTION fishing.fail_market() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_market BEFORE INSERT ON fishing.outbox_events FOR EACH ROW EXECUTE FUNCTION fishing.fail_market()`)
			r := market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 25, RequestKey: "atomic-buy"}
			if _, err := f.m.Buy(f.ctx, r); !errors.Is(err, assets.ErrUnavailable) {
				t.Fatal("failure not returned")
			}
			if f.balance(buyer) != 100 || f.balance(seller) != 0 || f.qty(buyer) != 0 || f.num(`SELECT count(*) FROM fishing.market_listings WHERE id=$1 AND state='open' AND closed_operation IS NULL`, id) != 1 {
				t.Fatal("failed purchase left partial effects")
			}
			if gearLot && f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='escrow' AND owner_id=$2`, gear, seller) != 1 {
				t.Fatal("failed purchase released equipment")
			}
			if _, err := f.a.Lookup(f.ctx, buyer, r.RequestKey); !errors.Is(err, assets.ErrNotFound) {
				t.Fatal("failed buy persisted result")
			}
			f.exec(`DROP TRIGGER fail_market ON fishing.outbox_events; DROP FUNCTION fishing.fail_market()`)
			result, err := f.m.Buy(f.ctx, r)
			f.want(result, err, "purchased")
			f.reconcile()
		})
	}
}

func TestIntegrationBuyCancelAndEquipListRaces(t *testing.T) {
	f := setup(t)
	for i := 0; i < 10; i++ {
		seller, buyer := f.player(), f.player()
		f.reward(seller, 0, 1)
		f.reward(buyer, 50, 0)
		id := f.lot(seller, 1, 0, 20, time.Hour)
		var wg sync.WaitGroup
		wg.Add(2)
		start := make(chan struct{})
		go func() {
			defer wg.Done()
			<-start
			r, err := f.m.Buy(f.ctx, market.Purchase{ActorID: buyer, ListingID: id, ExpectedPrice: 20, RequestKey: "buy"})
			if err != nil || r.Status != "purchased" && r.Status != "listing_closed" {
				t.Errorf("buy %s %v", r.Status, err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			r, err := f.m.Close(f.ctx, market.Close{ActorID: seller, ListingID: id, RequestKey: "cancel"})
			if err != nil || r.Status != "cancelled" && r.Status != "listing_closed" {
				t.Errorf("cancel %s %v", r.Status, err)
			}
		}()
		close(start)
		wg.Wait()
		if f.qty(seller)+f.qty(buyer) != 1 || f.balance(seller)+f.balance(buyer) != 50 || f.balance(seller) != 20*f.qty(buyer) {
			t.Fatal("buy/cancel race broke conservation")
		}
		gear := f.gear(seller)
		wg.Add(2)
		start = make(chan struct{})
		go func() {
			defer wg.Done()
			<-start
			r, err := f.a.ChangeRod(f.ctx, assets.RodCommand{ActorID: seller, RequestKey: "equip", Action: "equip", Part: "rod", EquipmentID: gear})
			if err != nil || r.Status != "rod_updated" && r.Status != "equipment_unavailable" {
				t.Errorf("equip %s %v", r.Status, err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			r, err := f.m.List(f.ctx, market.List{ActorID: seller, RequestKey: "list-gear", EquipmentID: gear, Price: 20, Lifetime: time.Hour})
			if err != nil || r.Status != "listed" && r.Status != "equipment_locked" {
				t.Errorf("list %s %v", r.Status, err)
			}
		}()
		close(start)
		wg.Wait()
	}
	f.reconcile()
}

func TestIntegrationExpiryRetryPaginationAndImmutability(t *testing.T) {
	f := setup(t)
	seller := f.player()
	f.reward(seller, 0, assets.MaxCoins)
	id := f.lot(seller, 1, 0, 10, 500*time.Millisecond)
	r := market.Close{ActorID: seller, ListingID: id, RequestKey: fmt.Sprintf("market:expire:%d", id), Expire: true}
	if _, err := f.m.Close(f.ctx, r); !errors.Is(err, assets.ErrDeferred) {
		t.Fatal("premature expiry not deferred")
	}
	f.reward(seller, 0, 1) // normal inventory full while one fish remains in escrow
	time.Sleep(600 * time.Millisecond)
	if _, err := f.m.Close(f.ctx, r); !errors.Is(err, assets.ErrDeferred) {
		t.Fatal("full return poisoned automatic expiry")
	}
	if f.num(`SELECT count(*) FROM fishing.market_listings WHERE id=$1 AND state='open'`, id) != 1 {
		t.Fatal("deferred return lost escrow")
	}
	result, err := f.a.ApplyChange(f.ctx, assets.Change{ActorID: seller, RequestKey: f.key(), RuleVersion: "test-v1", Reason: "consume", Stacks: []assets.StackDelta{{ItemID: "fish", Tier: "normal", Quantity: -1}}})
	f.want(result, err, "applied")
	if _, err = f.m.Expire(f.ctx, 0, 10); err != nil {
		t.Fatal(err)
	}
	if f.qty(seller) != assets.MaxCoins || f.num(`SELECT count(*) FROM fishing.market_listings WHERE id=$1 AND state='expired'`, id) != 1 {
		t.Fatal("expired stock not returned once")
	}
	result, err = f.m.Close(f.ctx, r)
	f.want(result, err, "expired")
	first := f.lot(seller, 1, 0, 5, time.Hour)
	second := f.lot(seller, 1, 0, 6, time.Hour)
	page, err := f.m.Open(f.ctx, 0, 1)
	if err != nil || len(page) != 1 || page[0].ID != first {
		t.Fatal("first page incorrect")
	}
	page, err = f.m.Open(f.ctx, first, 1)
	if err != nil || len(page) != 1 || page[0].ID != second {
		t.Fatal("cursor page incorrect")
	}
	if _, err = f.db.Admin.Exec(f.ctx, `UPDATE fishing.market_listings SET price=99 WHERE id=$1`, first); err == nil {
		t.Fatal("listing price changed after publication")
	}
	if _, err = f.db.Admin.Exec(f.ctx, `UPDATE fishing.fishing_rules SET bite_ppm=0 WHERE version='caught-v1'`); err == nil {
		t.Fatal("published rule mutated")
	}
	f.reconcile()
}

func TestIntegrationListingAndReturnFailureDoNotLoseEscrow(t *testing.T) {
	f := setup(t)
	seller := f.player()
	gear := f.gear(seller)
	f.exec(`CREATE FUNCTION fishing.fail_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_return BEFORE INSERT ON fishing.outbox_events FOR EACH ROW EXECUTE FUNCTION fishing.fail_return()`)
	list := market.List{ActorID: seller, RequestKey: "failed-list", EquipmentID: gear, Price: 25, Lifetime: time.Hour}
	if _, err := f.m.List(f.ctx, list); !errors.Is(err, assets.ErrUnavailable) {
		t.Fatal("listing failure not returned")
	}
	if f.num(`SELECT count(*) FROM fishing.market_listings`) != 0 || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available' AND escrow_listing_id IS NULL`, gear) != 1 {
		t.Fatal("failed listing left escrow")
	}
	f.exec(`DROP TRIGGER fail_return ON fishing.outbox_events`)
	r, err := f.m.List(f.ctx, list)
	f.want(r, err, "listed")
	id := parse(t, r.ResourceID)
	f.exec(`CREATE TRIGGER fail_return BEFORE INSERT ON fishing.outbox_events FOR EACH ROW EXECUTE FUNCTION fishing.fail_return()`)
	cancel := market.Close{ActorID: seller, ListingID: id, RequestKey: "failed-return"}
	if _, err := f.m.Close(f.ctx, cancel); !errors.Is(err, assets.ErrUnavailable) {
		t.Fatal("return failure not returned")
	}
	if f.num(`SELECT count(*) FROM fishing.market_listings WHERE id=$1 AND state='open'`, id) != 1 || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='escrow'`, gear) != 1 {
		t.Fatal("failed return lost escrow")
	}
	f.exec(`DROP TRIGGER fail_return ON fishing.outbox_events;DROP FUNCTION fishing.fail_return()`)
	r, err = f.m.Close(f.ctx, cancel)
	f.want(r, err, "cancelled")
	r, err = f.m.Close(f.ctx, cancel)
	f.want(r, err, "cancelled")
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, gear) != 1 {
		t.Fatal("return retry failed")
	}
	f.reconcile()
}
