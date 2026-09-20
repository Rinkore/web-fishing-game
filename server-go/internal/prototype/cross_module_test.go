package prototype_test

import (
	"sync"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/market"
)

func TestIntegrationAutoSaleAndPurchaseSharePlayerGuard(t *testing.T) {
	f := setup(t)
	for i := 0; i < 8; i++ {
		seller, buyer := f.player(), f.player()
		f.reward(seller, 0, 1)
		lot := f.lot(seller, 1, 0, 14, time.Hour)
		c := f.start(buyer, "caught-v1", true)
		f.due(c)
		buy := market.Purchase{ActorID: buyer, ListingID: lot, ExpectedPrice: 14, RequestKey: "cycle-funded-buy"}
		var wg sync.WaitGroup
		wg.Add(2)
		start := make(chan struct{})
		var purchase assets.Result
		go func() {
			defer wg.Done()
			<-start
			r, err := f.f.Settle(f.ctx, c)
			if err != nil || r.Status != "settled" {
				t.Errorf("settlement %s %v", r.Status, err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			r, err := f.m.Buy(f.ctx, buy)
			if err != nil {
				t.Error(err)
			}
			purchase = r
		}()
		close(start)
		wg.Wait()
		if f.balance(seller)+f.balance(buyer) != 14 {
			t.Fatal("auto-sale earnings lost while buying")
		}
		switch purchase.Status {
		case "insufficient_funds":
			if f.balance(buyer) != 14 || f.qty(buyer) != 0 {
				t.Fatal("rejected purchase took assets")
			}
			r, err := f.m.Buy(f.ctx, buy)
			f.want(r, err, "insufficient_funds")
			buy.RequestKey = "new-funded-buy"
			r, err = f.m.Buy(f.ctx, buy)
			f.want(r, err, "purchased")
		case "purchased":
		default:
			t.Fatal(purchase.Status)
		}
		if f.balance(seller) != 14 || f.balance(buyer) != 0 || f.qty(buyer) != 1 {
			t.Fatal("purchase did not use exactly one cycle's earnings")
		}
	}
	f.reconcile()
}
