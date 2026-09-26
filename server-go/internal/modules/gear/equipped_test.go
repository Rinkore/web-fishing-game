package gear

import (
	"testing"
)

// 工坊允许直接修改已装备的组件：成长结果替换同一配装槽位里的旧组件，玩家不必先卸下。
func TestIntegrationGrowthOnEquippedComponent(t *testing.T) {
	f := setup(t)
	id := f.modern(3, "")
	f.exec(`INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,1,'test',true)`, f.owner)
	f.exec(`INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,1,'reel',$2)`, f.owner, id)
	next := resultID(t, f.apply(Command{Action: "upgrade", ID: id, Sub: "skill"}))
	if next == id {
		t.Fatal("equipped growth reused the consumed instance")
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='consumed'`, id) != 1 {
		t.Fatal("equipped source not consumed")
	}
	if f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=1 AND part='reel' AND equipment_id=$2`, f.owner, next) != 1 {
		t.Fatal("growth result missing from the loadout slot")
	}
	if f.num(`SELECT count(*) FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id=$1 AND (c.owner_id<>e.owner_id OR e.lifecycle<>'available' OR c.part<>e.part)`, f.owner) != 0 {
		t.Fatal("loadout invariant broken by equipped growth")
	}
	if f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 996000 || f.num("SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='gear_alloy'", f.owner) != 992 || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 99 {
		t.Fatal("equipped growth charged the wrong fee")
	}
	view, err := f.s.View(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range view["equipment"].([]Equipment) {
		if e.ID != next {
			continue
		}
		found = true
		if !e.Locked || e.Growth == nil || e.Growth.Level != 4 {
			t.Fatal("growth result not reported as equipped", e)
		}
	}
	if !found {
		t.Fatal("growth result missing from the view")
	}
}

// 已装备组件走「仅使用普通物品」被拒时，整个操作（含摘下的配装槽位）必须回滚。
func TestIntegrationEquippedGrowthRejectionKeepsLoadout(t *testing.T) {
	f := setup(t)
	id := f.modern(3, "")
	f.exec(`INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,1,'test',true)`, f.owner)
	f.exec(`INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,1,'reel',$2)`, f.owner, id)
	f.exec(`UPDATE fishing.equipment_instances SET reward_bound=true WHERE id=$1`, id)
	if r := f.apply(Command{Action: "upgrade", ID: id, Sub: "skill", UnboundInputs: true}); r.Status != "reward_bound" {
		t.Fatal("ordinary-only growth consumed reward gear", r)
	}
	if f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND slot=1 AND part='reel' AND equipment_id=$2`, f.owner, id) != 1 {
		t.Fatal("rejected growth detached the equipped component")
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, id) != 1 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 1000000 {
		t.Fatal("rejected growth changed assets")
	}
}

// 成长转移的目标仍必须是未占用配件：把已装备的 +0 配件当目标要被拒绝。
func TestIntegrationTransferTargetMustStayUnequipped(t *testing.T) {
	f := setup(t)
	source := f.modern(5, "skill")
	target := f.modern(0, "")
	f.exec(`INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,1,'test',true)`, f.owner)
	f.exec(`INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,1,'reel',$2)`, f.owner, target)
	if r := f.apply(Command{Action: "transfer", ID: source, OtherID: target}); r.Status != "目标必须为未占用同部位基础配件" {
		t.Fatal("equipped transfer target accepted", r)
	}
	if f.num(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1 AND equipment_id=$2`, f.owner, target) != 1 || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, source) != 1 {
		t.Fatal("rejected transfer changed the loadout")
	}
}
