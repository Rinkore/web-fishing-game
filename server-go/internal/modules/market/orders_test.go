package market

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/testdb"
)

type orderFixture struct {
	t       *testing.T
	db      testdb.DB
	s       *Service
	assets  *assets.Service
	ctx     context.Context
	a, b, c int64
	seq     int
}

func orderSetup(t *testing.T) *orderFixture {
	db := testdb.New(t, true)
	f := &orderFixture{t: t, db: db, s: New(db.App), assets: assets.New(db.App), ctx: context.Background()}
	for _, p := range []*int64{&f.a, &f.b, &f.c} {
		if err := db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(p); err != nil {
			t.Fatal(err)
		}
		for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
			if _, err := db.Admin.Exec(f.ctx, sql, *p); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.Admin.Exec(f.ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES('ore','material',NULL),('rod_test','equipment','rod'),('line_test','equipment','line')`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{f.a, f.b, f.c} {
		f.reward(id, 10000, 100)
	}
	return f
}
func (f *orderFixture) key() string { f.seq++; return fmt.Sprintf("order-test-%d", f.seq) }
func (f *orderFixture) reward(owner, coins, qty int64) {
	f.t.Helper()
	c := assets.Change{ActorID: owner, RequestKey: f.key(), Reason: "reward", RuleVersion: "test-v1", Coins: coins}
	if qty != 0 {
		c.Stacks = []assets.StackDelta{{ItemID: "ore", Tier: "normal", Quantity: qty}}
	}
	res, err := f.assets.ApplyChange(f.ctx, c)
	if err != nil || res.Status != "applied" {
		f.t.Fatalf("reward: %s %v", res.Status, err)
	}
}
func (f *orderFixture) num(sql string, args ...any) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}
func (f *orderFixture) list(r OrderRequest) int64 {
	f.t.Helper()
	r.ActorID = f.a
	r.RequestKey = f.key()
	res, err := f.s.ListOrder(f.ctx, r)
	if err != nil || res.Status != "listed" {
		f.t.Fatalf("list: %s %v", res.Status, err)
	}
	id, _ := strconv.ParseInt(res.ResourceID, 10, 64)
	return id
}
func TestIntegrationPartialMarketFeeTaxAndCancel(t *testing.T) {
	f := orderSetup(t)
	id := f.list(OrderRequest{ItemID: "ore", Quantity: 10, UnitPrice: 11, Hours: 6})
	if f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.a) != 9998 {
		t.Fatal("listing fee mismatch")
	}
	command := FillRequest{ActorID: f.b, OrderID: id, Quantity: 3, ExpectedUnitPrice: 11, RequestKey: f.key()}
	res, err := f.s.Fill(f.ctx, command)
	if err != nil || res.Status != "purchased" {
		t.Fatal(res, err)
	}
	repeat, err := f.s.Fill(f.ctx, command)
	if err != nil || repeat.OperationID != res.OperationID {
		t.Fatal("fill replay")
	}
	if f.num(`SELECT remaining FROM fishing.market_orders WHERE id=$1`, id) != 7 || f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.a) != 10027 || f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.b) != 9967 {
		t.Fatal("partial fill balances")
	}
	if f.num(`SELECT sum(amount) FROM fishing.market_charges WHERE order_id=$1`, id) != 6 {
		t.Fatal("fee/tax sink ledger")
	}
	res, err = f.s.CloseOrder(f.ctx, f.a, id, f.key(), false)
	if err != nil || res.Status != "cancelled" {
		t.Fatal(res, err)
	}
	if f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='ore'`, f.a) != 97 {
		t.Fatal("cancel did not return only remaining quantity")
	}
	if f.num(`SELECT sum(coins) FROM fishing.wallets`)+f.num(`SELECT sum(amount) FROM fishing.market_charges`) != 30000 {
		t.Fatal("coin conservation with fee sinks")
	}
}
func TestIntegrationConcurrentFillAndCancelNoOversell(t *testing.T) {
	f := orderSetup(t)
	id := f.list(OrderRequest{ItemID: "ore", Quantity: 1, UnitPrice: 50, Hours: 12})
	var wg sync.WaitGroup
	results := make(chan assets.Result, 3)
	for i, owner := range []int64{f.b, f.c} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.s.Fill(f.ctx, FillRequest{ActorID: owner, OrderID: id, Quantity: 1, ExpectedUnitPrice: 50, RequestKey: fmt.Sprintf("race-%d", i)})
			if err != nil {
				t.Error(err)
			}
			results <- r
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		r, err := f.s.CloseOrder(f.ctx, f.a, id, "race-cancel", false)
		if err != nil {
			t.Error(err)
		}
		results <- r
	}()
	wg.Wait()
	close(results)
	wins := 0
	for r := range results {
		if r.Status == "purchased" || r.Status == "cancelled" {
			wins++
		}
	}
	if wins != 1 || f.num(`SELECT sum(quantity) FROM fishing.inventory_stacks WHERE item_id='ore'`) != 300 {
		t.Fatal("oversell or duplicated return")
	}
}
func (f *orderFixture) rod(owner int64) []string {
	f.t.Helper()
	r, err := f.assets.ApplyChange(f.ctx, assets.Change{ActorID: owner, RequestKey: f.key(), Reason: "reward", RuleVersion: "test-v1", Create: []assets.EquipmentSpec{{DefinitionID: "rod_test", Part: "rod", Attributes: json.RawMessage(`{"speed":1}`)}, {DefinitionID: "line_test", Part: "line", Attributes: json.RawMessage(`{"skill":1}`)}}})
	if err != nil || len(r.EquipmentIDs) != 2 {
		f.t.Fatal("gear reward", err)
	}
	for i, id := range r.EquipmentIDs {
		n, _ := strconv.ParseInt(id, 10, 64)
		res, err := f.assets.ChangeRod(f.ctx, assets.RodCommand{ActorID: owner, RequestKey: f.key(), Action: "equip", Part: []string{"rod", "line"}[i], EquipmentID: n})
		if err != nil || res.Status != "rod_updated" {
			f.t.Fatal("equip", res, err)
		}
	}
	res, err := f.assets.ChangeRod(f.ctx, assets.RodCommand{ActorID: owner, RequestKey: f.key(), Action: "save", Slot: 0, Name: "测试钓竿"})
	if err != nil || res.Status != "rod_updated" {
		f.t.Fatal("save", res, err)
	}
	return r.EquipmentIDs
}
func TestIntegrationWholeRodEscrowCapacityAndReturn(t *testing.T) {
	f := orderSetup(t)
	ids := f.rod(f.a)
	slot := 0
	id := f.list(OrderRequest{RodSlot: &slot, UnitPrice: 100, Hours: 24})
	if f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1`, f.a) != 0 || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='escrow'`, f.a) != 2 {
		t.Fatal("rod not escrowed")
	}
	f.rod(f.b)
	before := f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.b)
	res, err := f.s.Fill(f.ctx, FillRequest{ActorID: f.b, OrderID: id, Quantity: 1, ExpectedUnitPrice: 100, RequestKey: f.key()})
	if err != nil || res.Status != "rod_capacity" || f.num(`SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.b) != before {
		t.Fatal("full rack purchase was not rolled back", res, err)
	}
	res, err = f.s.Fill(f.ctx, FillRequest{ActorID: f.c, OrderID: id, Quantity: 1, ExpectedUnitPrice: 100, RequestKey: f.key()})
	if err != nil || res.Status != "purchased" {
		t.Fatal("whole rod purchase", res, err)
	}
	for _, id := range ids {
		if f.num(`SELECT owner_id FROM fishing.equipment_instances WHERE id=$1`, id) != f.c {
			t.Fatal("gear not delivered")
		}
	}
	if f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=0`, f.c) != 2 {
		t.Fatal("rod split on purchase")
	}
	// A returned rod becomes loose equipment only when all purchased slots filled.
	f.rod(f.a)
	second := f.list(OrderRequest{RodSlot: &slot, UnitPrice: 100, Hours: 6})
	f.rod(f.a)
	res, err = f.s.CloseOrder(f.ctx, f.a, second, f.key(), false)
	if err != nil || res.Status != "cancelled" {
		t.Fatal(res, err)
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'`, f.a) != 4 || f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1`, f.a) != 2 {
		t.Fatal("full rack return lost equipment")
	}
}
