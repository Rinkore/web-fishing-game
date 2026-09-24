package gear

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
)

func TestIntegrationBatchConversionAtomicRetryAndBinding(t *testing.T) {
	f := setup(t)
	cfg := f.c.GearConfig()
	cfg.Costs.Convert.Coins = 500
	cfg.Costs.Convert.Items = map[string]int64{"gear_alloy": 2}
	cfg.Costs.Convert.Receipts = 1
	f.c.Constants["GEAR_SYSTEM"] = cfg.Raw()
	ids := []string{f.add("gear_line_2#rare#spd+4"), f.add("gear_hook_2#epic#skl+4")}
	f.exec(`UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=true WHERE id=$1`, ids[0])
	beforeCoins := f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner)
	in := Command{Action: "convert_batch", IDs: ids, RequestKey: f.key()}
	var wg sync.WaitGroup
	rr, ee := make([]assets.Result, 3), make([]error, 3)
	for i := range rr {
		wg.Add(1)
		go func(i int) { defer wg.Done(); rr[i], ee[i] = f.s.Apply(f.ctx, f.owner, in) }(i)
	}
	wg.Wait()
	var first string
	for i, r := range rr {
		if ee[i] != nil || r.Status != "crafted" {
			t.Fatal(r, ee[i])
		}
		var d struct {
			Count     int `json:"count"`
			Converted []struct {
				ID string `json:"id"`
			} `json:"converted"`
		}
		if err := json.Unmarshal(r.Details, &d); err != nil || d.Count != 2 || len(d.Converted) != 2 {
			t.Fatal("invalid batch result", string(r.Details), err)
		}
		if first != "" && first != d.Converted[0].ID {
			t.Fatal("retry produced new equipment")
		}
		first = d.Converted[0].ID
	}
	if f.num("SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='gear_alloy'", f.owner) != 996 {
		t.Fatal("batch materials charged incorrectly")
	}
	if f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != beforeCoins-2*cfg.Costs.Convert.Coins || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 100+cfg.LegacyConvertReceipts["rare"]+cfg.LegacyConvertReceipts["epic"]-2*cfg.Costs.Convert.Receipts {
		t.Fatal("batch fees or compensation repeated")
	}
	if f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available' AND reward_bound AND bind_outputs AND attributes->>'signature' LIKE '%@g0_none_0%'`, f.owner) != 2 {
		t.Fatal("batch lost inherited reward binding")
	}
}

func TestIntegrationBatchConversionRejectionsRollback(t *testing.T) {
	f := setup(t)
	id := f.add("gear_line_2#rare#spd+4")
	modern := f.modern(0, "")
	f.exec(`INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,1,'test',true)`, f.owner)
	locked := f.add("gear_hook_2#rare#skl+4")
	f.exec(`INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,1,'hook',$2)`, f.owner, locked)
	for i, ids := range [][]string{{}, {id, id}, {id, "0"}, {id, modern}, {id, locked}, make([]string, 101)} {
		r, err := f.s.Apply(f.ctx, f.owner, Command{Action: "convert_batch", IDs: ids, RequestKey: fmt.Sprintf("batch-rejection-%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		if r.Status == "crafted" || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, id) != 1 || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 100 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 1000000 {
			t.Fatal("rejected batch changed assets", ids, r)
		}
	}
	cfg := f.c.GearConfig()
	cfg.Costs.Convert.Items = map[string]int64{"gear_fine": 101}
	f.c.Constants["GEAR_SYSTEM"] = cfg.Raw()
	if r := f.apply(Command{Action: "convert_batch", IDs: []string{id}}); r.Status != "insufficient_items" || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, id) != 1 || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 100 {
		t.Fatal("insufficient conversion materials leaked assets", r)
	}
	cfg.Costs.Convert.Items = map[string]int64{}
	f.c.Constants["GEAR_SYSTEM"] = cfg.Raw()
	f.exec(`UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=true WHERE id=$1`, id)
	if r := f.apply(Command{Action: "convert_batch", IDs: []string{id}, UnboundInputs: true}); r.Status != "reward_bound" {
		t.Fatal("ordinary-only batch consumed reward gear", r)
	}
	f.exec(`CREATE FUNCTION fishing.conversion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER conversion_fault BEFORE INSERT ON fishing.equipment_instances FOR EACH ROW EXECUTE FUNCTION fishing.conversion_fault()`)
	in := Command{Action: "convert_batch", IDs: []string{id}, RequestKey: f.key()}
	if _, err := f.s.Apply(f.ctx, f.owner, in); err == nil || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE id=$1 AND lifecycle='available'`, id) != 1 || f.num("SELECT (state->>'receipts')::bigint FROM fishing.gear_progress WHERE owner_id=$1", f.owner) != 100 {
		t.Fatal("creation failure leaked conversion assets", err)
	}
	f.exec("DROP TRIGGER conversion_fault ON fishing.equipment_instances")
	if r := f.apply(in); r.Status != "crafted" {
		t.Fatal("failed conversion could not retry", r)
	}
}

func TestIntegrationBatchConversionCompetingRequests(t *testing.T) {
	f := setup(t)
	ids := []string{f.add("gear_line_2#rare#spd+4"), f.add("gear_hook_2#epic#skl+4")}
	var wg sync.WaitGroup
	results, errs := make([]assets.Result, 2), make([]error, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.s.Apply(f.ctx, f.owner, Command{Action: "convert_batch", IDs: ids, RequestKey: fmt.Sprintf("batch-competing-%d", i)})
		}(i)
	}
	wg.Wait()
	crafted := 0
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.Status == "crafted" {
			crafted++
		}
	}
	cfg := f.c.GearConfig()
	if crafted != 1 || f.num("SELECT coins FROM fishing.wallets WHERE account_id=$1", f.owner) != 1000000-2*cfg.Costs.Convert.Coins || f.num(`SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'`, f.owner) != 2 {
		t.Fatal("competing batches duplicated conversion", results)
	}
}
