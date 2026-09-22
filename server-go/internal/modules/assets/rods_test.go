package assets

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func TestIntegrationRodOwnership(t *testing.T) {
	f := newAssets(t)
	t.Run("save-switch-stow-delete-and-uninstall", func(t *testing.T) {
		a, b := f.player(), f.player()
		rod, line, second := f.gear(a, "rod"), f.gear(a, "line"), f.gear(a, "rod")
		if _, err := f.db.Admin.Exec(f.ctx, "UPDATE fishing.player_state SET rod_capacity=2 WHERE account_id=$1", a); err != nil {
			t.Fatal(err)
		}
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: rod}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "line", EquipmentID: line}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: rod}, "rod_updated")
		if f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1", a) != 2 {
			t.Fatal("same instance equip duplicated")
		}
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 0, Name: "第一根"}, "rod_updated")
		if f.active(a) != 0 || f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1", a) != 2 {
			t.Fatal("save duplicated bindings")
		}
		f.exchange(Exchange{ActorID: a, RecipientID: b, Equipment: []int64{rod}}, "equipment_locked")
		f.change(Change{ActorID: a, Reason: "consume", Consume: []int64{line}}, "equipment_locked")
		f.rod(RodCommand{ActorID: a, Action: "stow"}, "rod_updated")
		if f.active(a) != -1 || f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=0", a) != 2 {
			t.Fatal("saved stow released components")
		}
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: second}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 1, Name: "第二根"}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "use", Slot: 0}, "rod_updated")
		if f.active(a) != 0 || f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1", a) != 3 {
			t.Fatal("switch changed instance count")
		}
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "line"}, "rod_updated")
		if f.active(a) != -1 || f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=0", a) != 0 {
			t.Fatal("uninstall did not dissolve saved slot")
		}
		if f.number("SELECT slot FROM fishing.rod_components WHERE equipment_id=$1", rod) != -1 {
			t.Fatal("remaining rod did not become loose active assembly")
		}
		f.exchange(Exchange{ActorID: a, RecipientID: b, Equipment: []int64{line}}, "exchanged")
		f.rod(RodCommand{ActorID: a, Action: "use", Slot: 1}, "rod_updated")
		if f.number("SELECT count(*) FROM fishing.rod_components WHERE equipment_id=$1", rod) != 0 {
			t.Fatal("loose assembly not returned on use")
		}
		f.rod(RodCommand{ActorID: a, Action: "rename", Slot: 1, Name: "改名"}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "delete", Slot: 1}, "rod_updated")
		if f.active(a) != -1 || f.number("SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1", a) != 0 {
			t.Fatal("delete did not free saved equipment")
		}
		f.exchange(Exchange{ActorID: a, RecipientID: b, Equipment: []int64{rod, second}}, "exchanged")
	})
	t.Run("part-owner-capacity-and-forced-save", func(t *testing.T) {
		a, b := f.player(), f.player()
		first, second, foreign := f.gear(a, "rod"), f.gear(a, "rod"), f.gear(b, "rod")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: foreign}, "equipment_unavailable")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "line", EquipmentID: first}, "wrong_equipment_part")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: first}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 1}, "slot_not_purchased")
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 0}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "stow"}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: first}, "equipment_locked")
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: second}, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 0}, "slot_occupied")
		if f.number("SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=0", a) != first {
			t.Fatal("non-forced save overwrote rod")
		}
		f.rod(RodCommand{ActorID: a, Action: "save", Slot: 0, Force: true}, "rod_updated")
		if f.number("SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=0", a) != second || f.number("SELECT count(*) FROM fishing.rod_components WHERE equipment_id=$1", first) != 0 {
			t.Fatal("forced save lost or duplicated equipment")
		}
		f.exchange(Exchange{ActorID: a, RecipientID: b, Equipment: []int64{first}}, "exchanged")
	})
	t.Run("equip-transfer-race", func(t *testing.T) {
		a, b := f.player(), f.player()
		for i := 0; i < 12; i++ {
			id := f.gear(a, "rod")
			start := make(chan struct{})
			var wg sync.WaitGroup
			wg.Add(2)
			go func(i int) {
				defer wg.Done()
				<-start
				r, err := f.s.ChangeRod(context.Background(), RodCommand{ActorID: a, RequestKey: fmt.Sprintf("race-equip-%d", i), Action: "equip", Part: "rod", EquipmentID: id})
				if err != nil || r.Status != "rod_updated" && r.Status != "equipment_unavailable" {
					t.Errorf("equip race %v %s", err, r.Status)
				}
			}(i)
			go func(i int) {
				defer wg.Done()
				<-start
				r, err := f.s.ExchangeAssets(context.Background(), Exchange{ActorID: a, RecipientID: b, RequestKey: fmt.Sprintf("race-transfer-%d", i), Equipment: []int64{id}})
				if err != nil || r.Status != "exchanged" && r.Status != "equipment_locked" {
					t.Errorf("transfer race %v %s", err, r.Status)
				}
			}(i)
			close(start)
			wg.Wait()
			var bad bool
			if err := f.db.Admin.QueryRow(f.ctx, "SELECT EXISTS(SELECT 1 FROM fishing.rod_components c JOIN fishing.equipment_instances e ON c.equipment_id=e.id WHERE c.owner_id<>e.owner_id)").Scan(&bad); err != nil || bad {
				t.Fatal("race produced cross-owner binding")
			}
		}
	})
	t.Run("equipment-only-one-consumer", func(t *testing.T) {
		a, b, c := f.player(), f.player(), f.player()
		id := f.gear(a, "rod")
		var wg sync.WaitGroup
		wg.Add(2)
		results := make(chan Result, 2)
		for i, to := range []int64{b, c} {
			go func(i int, to int64) {
				defer wg.Done()
				r, err := f.s.ExchangeAssets(f.ctx, Exchange{ActorID: a, RecipientID: to, RequestKey: fmt.Sprintf("gear-sell-%d", i), Equipment: []int64{id}})
				if err != nil {
					t.Error(err)
				}
				results <- r
			}(i, to)
		}
		wg.Wait()
		close(results)
		success := 0
		for r := range results {
			if r.Status == "exchanged" {
				success++
			} else if r.Status != "equipment_unavailable" {
				t.Error(r.Status)
			}
		}
		if success != 1 {
			t.Fatal("equipment transferred more than once")
		}
	})
	t.Run("replayed-rod-command-does-not-restore-old-binding", func(t *testing.T) {
		a, b := f.player(), f.player()
		id := f.gear(a, "rod")
		r := RodCommand{ActorID: a, RequestKey: "equip-replay", Action: "equip", Part: "rod", EquipmentID: id}
		first := f.rod(r, "rod_updated")
		f.rod(RodCommand{ActorID: a, Action: "stow"}, "rod_updated")
		f.exchange(Exchange{ActorID: a, RecipientID: b, Equipment: []int64{id}}, "exchanged")
		if replay := f.rod(r, "rod_updated"); first.OperationID != replay.OperationID {
			t.Fatal("replay result changed")
		}
		if f.number("SELECT count(*) FROM fishing.rod_components WHERE equipment_id=$1", id) != 0 {
			t.Fatal("replay reequipped transferred instance")
		}
	})
	t.Run("database-rejects-cross-owner-or-part-binding", func(t *testing.T) {
		a, b := f.player(), f.player()
		id := f.gear(a, "rod")
		f.rod(RodCommand{ActorID: b, Action: "equip", Part: "rod"}, "rod_updated")
		if _, err := f.db.Admin.Exec(f.ctx, "INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES ($1,-1,'rod',$2)", b, id); err == nil {
			t.Fatal("cross-owner binding accepted by FK")
		}
		f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: id}, "rod_updated")
		if _, err := f.db.Admin.Exec(f.ctx, "UPDATE fishing.equipment_instances SET lifecycle='consumed' WHERE id=$1", id); err == nil {
			t.Fatal("bound equipment consumed through direct SQL")
		}
		if _, err := f.db.Admin.Exec(f.ctx, "UPDATE fishing.equipment_instances SET owner_id=$2 WHERE id=$1", id, b); err == nil {
			t.Fatal("bound equipment owner changed through direct SQL")
		}
	})
	assertInventoryReconciles(t, f.db.Admin)
}

func TestIntegrationRodFailureRollsBackBindings(t *testing.T) {
	for _, table := range []string{"rod_entries", "outbox_events"} {
		t.Run(table, func(t *testing.T) {
			f := newAssets(t)
			a := f.player()
			old, replacement := f.gear(a, "rod"), f.gear(a, "rod")
			f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: old}, "rod_updated")
			f.rod(RodCommand{ActorID: a, Action: "save", Slot: 0, Name: "original"}, "rod_updated")
			f.rod(RodCommand{ActorID: a, Action: "stow"}, "rod_updated")
			f.rod(RodCommand{ActorID: a, Action: "equip", Part: "rod", EquipmentID: replacement}, "rod_updated")
			rev := f.number("SELECT assets_rev FROM fishing.player_state WHERE account_id=$1", a)
			_, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.reject_rod() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER reject_rod BEFORE INSERT ON fishing.`+table+` FOR EACH ROW EXECUTE FUNCTION fishing.reject_rod()`)
			if err != nil {
				t.Fatal(err)
			}
			c := RodCommand{ActorID: a, RequestKey: "force-save-retry", Action: "save", Slot: 0, Force: true, Name: "replacement"}
			if _, err := f.s.ChangeRod(f.ctx, c); !errors.Is(err, ErrUnavailable) {
				t.Fatal("injected failure not returned")
			}
			if f.active(a) != -1 || f.number("SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=0", a) != old || f.number("SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=-1", a) != replacement || f.number("SELECT assets_rev FROM fishing.player_state WHERE account_id=$1", a) != rev {
				t.Fatal("failed forced save changed bindings, active slot or revision")
			}
			var name string
			if err := f.db.Admin.QueryRow(f.ctx, "SELECT name FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=0", a).Scan(&name); err != nil || name != "original" {
				t.Fatal("failed save changed name")
			}
			if _, err := f.s.Lookup(f.ctx, a, c.RequestKey); !errors.Is(err, ErrNotFound) {
				t.Fatal("failed save persisted result")
			}
			if _, err := f.db.Admin.Exec(f.ctx, "DROP TRIGGER reject_rod ON fishing."+table+"; DROP FUNCTION fishing.reject_rod()"); err != nil {
				t.Fatal(err)
			}
			f.rod(c, "rod_updated")
			if f.active(a) != 0 || f.number("SELECT count(*) FROM fishing.rod_components WHERE equipment_id=$1", old) != 0 {
				t.Fatal("same-key retry failed")
			}
			assertInventoryReconciles(t, f.db.Admin)
		})
	}
}
