package trade

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/testdb"
)

type fixture struct {
	t     *testing.T
	db    testdb.DB
	svc   *Service
	asset *assets.Service
	a, b  int64
	ctx   context.Context
	next  int
}

func setup(t *testing.T) *fixture {
	db := testdb.New(t, true)
	f := &fixture{t: t, db: db, svc: New(db.App), asset: assets.New(db.App), ctx: context.Background()}
	for _, p := range []*int64{&f.a, &f.b} {
		if err := db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(p); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.player_state(account_id) VALUES($1)`, *p); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.wallets(account_id) VALUES($1)`, *p); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.fishing_connections(owner_id,generation,expires_at) VALUES($1,1,clock_timestamp()+interval '1 hour')`, *p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('ore','material')`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{f.a, f.b} {
		f.reward(id, 10)
	}
	return f
}
func (f *fixture) key() string { f.next++; return fmt.Sprintf("test-%d", f.next) }
func (f *fixture) reward(id, quantity int64) {
	f.t.Helper()
	reason := "reward"
	if quantity < 0 {
		reason = "consume"
	}
	res, err := f.asset.ApplyChange(f.ctx, assets.Change{ActorID: id, RequestKey: f.key(), Reason: reason, RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "ore", Tier: "normal", Quantity: quantity}}})
	if err != nil || res.Status != "applied" {
		f.t.Fatalf("reward: %s %v", res.Status, err)
	}
}
func (f *fixture) invite() int64 {
	f.t.Helper()
	res, err := f.svc.Invite(f.ctx, Invite{ActorID: f.a, TargetID: f.b, RequestKey: f.key()})
	if err != nil || res.Status != "invited" {
		f.t.Fatalf("invite: %s %v", res.Status, err)
	}
	id, _ := strconv.ParseInt(res.ResourceID, 10, 64)
	return id
}
func (f *fixture) change(c Change, status string) assets.Result {
	f.t.Helper()
	if c.RequestKey == "" {
		c.RequestKey = f.key()
	}
	r, err := f.svc.Change(f.ctx, c)
	if err != nil || r.Status != status {
		f.t.Fatalf("%s: %s %v want %s", c.Action, r.Status, err, status)
	}
	return r
}
func (f *fixture) quantity(owner int64) int64 {
	f.t.Helper()
	var q int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='ore' AND tier='normal'`, owner).Scan(&q); err != nil {
		f.t.Fatal(err)
	}
	return q
}
func TestIntegrationTradeConcurrentConfirmNetSettlement(t *testing.T) {
	f := setup(t)
	id := f.invite()
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 1, Action: "respond", Accept: true}, "cannot_respond")
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 1, Action: "respond", Accept: true}, "accepted")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 2, Action: "offer", Offer: Offer{Stacks: []Stack{{"ore", 3}}}}, "offer_updated")
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 3, Action: "offer", Offer: Offer{Stacks: []Stack{{"ore", 5}}}}, "offer_updated")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 3, Action: "confirm"}, "offer_changed")
	commands := []Change{{ActorID: f.a, TradeID: id, Revision: 4, Action: "confirm", RequestKey: "confirm-a"}, {ActorID: f.b, TradeID: id, Revision: 4, Action: "confirm", RequestKey: "confirm-b"}}
	var wg sync.WaitGroup
	out := make(chan assets.Result, 2)
	for _, c := range commands {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.svc.Change(f.ctx, c)
			if err != nil {
				t.Error(err)
			}
			out <- r
		}()
	}
	wg.Wait()
	close(out)
	confirmed, settled := 0, 0
	for r := range out {
		if r.Status == "confirmed" {
			confirmed++
		}
		if r.Status == "traded" {
			settled++
		}
	}
	if confirmed != 1 || settled != 1 || f.quantity(f.a) != 12 || f.quantity(f.b) != 8 {
		t.Fatal("concurrent settlement was not exactly once")
	}
	for _, c := range commands {
		if _, err := f.svc.Change(f.ctx, c); err != nil {
			t.Fatal("replay failed", err)
		}
	}
	if f.quantity(f.a) != 12 || f.quantity(f.b) != 8 {
		t.Fatal("replay moved inventory again")
	}
	var rows int
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT count(*) FROM fishing.inventory_entries e JOIN fishing.trades t ON t.settled_operation=e.operation_id WHERE t.id=$1`, id).Scan(&rows); err != nil || rows != 2 {
		t.Fatal("net inventory ledger did not reconcile")
	}
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.trades SET state='accepted' WHERE id=$1`, id); err == nil {
		t.Fatal("settled trade is mutable")
	}
}
func TestIntegrationTradeChangeAndInsufficientOfferInvalidateConfirm(t *testing.T) {
	f := setup(t)
	id := f.invite()
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 1, Action: "respond", Accept: true}, "accepted")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 2, Action: "offer", Offer: Offer{Stacks: []Stack{{"ore", 9}}}}, "offer_updated")
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 3, Action: "confirm"}, "confirmed")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 3, Action: "offer", Offer: Offer{Stacks: []Stack{{"ore", 8}}}}, "offer_updated")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 4, Action: "confirm"}, "confirmation_cooldown")
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.trades SET cooldown_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 4, Action: "confirm"}, "confirmed")
	f.reward(f.a, -5)
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 4, Action: "confirm"}, "offer_invalidated")
	v, err := f.svc.View(f.ctx, id, f.a)
	if err != nil || v.Revision != 5 || v.AConfirm || v.BConfirm || f.quantity(f.b) != 10 {
		t.Fatal("invalidated offer transferred assets")
	}
}
func TestIntegrationTradeRecipientLimitRollsBackAndOfflineExpiryRetries(t *testing.T) {
	f := setup(t)
	id := f.invite()
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 1, Action: "respond", Accept: true}, "accepted")
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 2, Action: "offer", Offer: Offer{Stacks: []Stack{{"ore", 1}}}}, "offer_updated")
	f.reward(f.b, assets.MaxCoins-10)
	f.change(Change{ActorID: f.a, TradeID: id, Revision: 3, Action: "confirm"}, "confirmed")
	f.change(Change{ActorID: f.b, TradeID: id, Revision: 3, Action: "confirm"}, "quantity_limit")
	if f.quantity(f.a) != 10 || f.quantity(f.b) != assets.MaxCoins {
		t.Fatal("failed settlement partially moved inventory")
	}
	if _, err := f.svc.Expire(f.ctx, id, f.a); !errors.Is(err, assets.ErrDeferred) {
		t.Fatal("premature expiry cached")
	}
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.fishing_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, f.b); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Sweep(f.ctx); err != nil {
		t.Fatal(err)
	}
	v, err := f.svc.View(f.ctx, id, f.a)
	if err != nil || v.State != "expired" {
		t.Fatal("offline trade remained open")
	}
	r, err := f.svc.Expire(f.ctx, id, f.a)
	if err != nil || r.Status != "expired" {
		t.Fatal("expiry replay failed")
	}
}
