package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
)

func TestIntegrationLegacySnapshotRestoresEquipmentAndAllRods(t *testing.T) {
	for _, scenario := range []string{"loose", "saved", "legacy-saved", "consumed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAdminFixture(t)
			ctx := context.Background()
			if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES('rod_bamboo','equipment','rod'),('rod_fiberglass','equipment','rod'),('line_nylon','equipment','line') ON CONFLICT DO NOTHING`); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.player_state SET rod_capacity=2 WHERE account_id=$1`, f.playerID); err != nil {
				t.Fatal(err)
			}
			service, seq := assets.New(f.db.App), 0
			nextKey := func() string { seq++; return "snapshot-regression-" + strconv.Itoa(seq) }
			create := func(base, part, signature string) int64 {
				t.Helper()
				attributes, _ := json.Marshal(map[string]string{"signature": signature})
				result, err := service.ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: nextKey(), Reason: "reward", RuleVersion: "snapshot-test", Create: []assets.EquipmentSpec{{DefinitionID: base, Part: part, Attributes: attributes}}})
				if err != nil || result.Status != "applied" || len(result.EquipmentIDs) != 1 {
					t.Fatalf("create equipment: %+v %v", result, err)
				}
				id, err := strconv.ParseInt(result.EquipmentIDs[0], 10, 64)
				if err != nil {
					t.Fatal(err)
				}
				return id
			}
			rod := func(command assets.RodCommand) {
				t.Helper()
				command.ActorID, command.RequestKey = f.playerID, nextKey()
				result, err := service.ChangeRod(ctx, command)
				if err != nil || result.Status != "rod_updated" {
					t.Fatalf("rod command: %+v %v", result, err)
				}
			}
			number := func(query string, args ...any) int64 {
				t.Helper()
				var n int64
				if err := f.db.Admin.QueryRow(ctx, query, args...).Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			}
			const signatureA, signatureB, signatureSaved = "rod_bamboo#common#", "rod_fiberglass#common#", "rod_bamboo#rare#"
			a := create("rod_bamboo", "rod", signatureA)
			b := create("rod_fiberglass", "rod", signatureB)
			saved := create("rod_bamboo", "rod", signatureSaved)
			rod(assets.RodCommand{Action: "equip", Part: "rod", EquipmentID: saved})
			rod(assets.RodCommand{Action: "save", Slot: 0, Name: "keep saved rod"})
			rod(assets.RodCommand{Action: "stow"})
			rod(assets.RodCommand{Action: "equip", Part: "rod", EquipmentID: a})
			code, body := f.admin("POST", "/api/admin/users/snapshot-now", `{"target":"`+f.playerKey+`"}`)
			f.expect(code, body, 200, "")
			code, list := f.admin("GET", "/api/admin/users/snapshots?key="+f.playerKey, "")
			f.expect(code, list, 200, "")
			name := list["snapshots"].([]any)[0].(map[string]any)["name"].(string)
			if scenario == "legacy-saved" {
				// Simulate the older durable format, which did not capture saved rods.
				if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.operator_settings SET value=(SELECT jsonb_agg(jsonb_set(entry,'{view}',(entry->'view')-'_rodLoadouts'::text)) FROM jsonb_array_elements(value) entry) WHERE key=$1`, snapshotSettingKey(f.playerID)); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "saved" || scenario == "legacy-saved" {
				rod(assets.RodCommand{Action: "save", Slot: 1, Name: "moved after snapshot"})
				rod(assets.RodCommand{Action: "stow"})
			}
			rod(assets.RodCommand{Action: "equip", Part: "rod", EquipmentID: b})
			if scenario == "consumed" {
				result, err := service.ApplyChange(ctx, assets.Change{ActorID: f.playerID, RequestKey: nextKey(), Reason: "consume", RuleVersion: "snapshot-test", Consume: []int64{a}})
				if err != nil || result.Status != "applied" {
					t.Fatalf("consume A: %+v %v", result, err)
				}
			}
			line := create("line_nylon", "line", "line_nylon#common#")
			rod(assets.RodCommand{Action: "equip", Part: "line", EquipmentID: line})
			beforeRev := number(`SELECT loadout_rev FROM fishing.player_state WHERE account_id=$1`, f.playerID)
			beforeEntries := number(`SELECT count(*) FROM fishing.rod_entries WHERE owner_id=$1`, f.playerID)
			code, body = f.admin("POST", "/api/admin/users/rollback", `{"target":"`+f.playerKey+`","snap":"`+name+`","confirm":true}`)
			f.expect(code, body, 200, "")
			code, view := f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
			f.expect(code, view, 200, "")
			bd := view["bd"].(map[string]any)
			if len(bd) != 1 || bd["rod"].(map[string]any)["compId"] != signatureA {
				t.Fatalf("rollback assembly is not exact: %v", bd)
			}
			inventory := view["inventory"].(map[string]any)
			if inventory[signatureB] != float64(1) || inventory[signatureA] != nil || inventory["line_nylon#common#"] != nil {
				t.Fatalf("rollback loose inventory: %v", inventory)
			}
			if number(`SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'`, f.playerID) != 3 || number(`SELECT count(*) FROM fishing.rod_components WHERE owner_id=$1`, f.playerID) != 2 {
				t.Fatal("rollback duplicated or lost available equipment")
			}
			if number(`SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=0 AND part='rod'`, f.playerID) != saved {
				t.Fatal("rollback lost saved rod")
			}
			restoredA := number(`SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=-1 AND part='rod'`, f.playerID)
			if scenario != "consumed" && restoredA != a {
				t.Fatal("rollback failed to reuse still-owned A")
			}
			operation := number(`SELECT max(operation_id) FROM fishing.rod_entries WHERE owner_id=$1`, f.playerID)
			if number(`SELECT loadout_rev FROM fishing.player_state WHERE account_id=$1`, f.playerID) != beforeRev+1 || number(`SELECT count(*) FROM fishing.rod_entries WHERE owner_id=$1`, f.playerID) != beforeEntries+1 {
				t.Fatal("rollback did not advance rod revision and audit exactly once")
			}
			if number(`SELECT count(*) FROM fishing.equipment_entries WHERE operation_id=$1 AND action='consume' AND equipment_id IN ($2,$3)`, operation, b, line) != 2 {
				t.Fatal("rollback omitted consumed equipment ledger")
			}
			wantCreated := int64(1) // B returns to the loose inventory.
			if scenario == "consumed" {
				wantCreated++
			}
			if number(`SELECT count(*) FROM fishing.equipment_entries WHERE operation_id=$1 AND action='create'`, operation) != wantCreated {
				t.Fatal("rollback creation ledger does not match replacement equipment")
			}
			if number(`SELECT count(*) FROM fishing.equipment_instances e WHERE e.owner_id=$1 AND e.lifecycle='available' AND NOT EXISTS(SELECT 1 FROM fishing.equipment_entries l WHERE l.equipment_id=e.id AND l.action='create')`, f.playerID) != 0 {
				t.Fatal("available equipment lacks creation ledger")
			}
		})
	}
}

func TestIntegrationLegacySnapshotGuardAndRevokedSession(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	actor, err := identity.New(f.db.App, nil).Authenticate(ctx, f.adminToken, true)
	if err != nil {
		t.Fatal(err)
	}
	blocker, err := f.db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, f.playerID); err != nil {
		t.Fatal(err)
	}
	waiting, err := f.db.App.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer waiting.Rollback(ctx)
	deadline, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	if err := legacyAdminWriteGuard(deadline, waiting, actor, f.playerID); !errors.Is(err, identity.ErrStorage) || deadline.Err() == nil {
		t.Fatalf("snapshot guard did not wait for player transaction: %v", err)
	}
	_ = waiting.Rollback(ctx)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE token_hash=$1`, actor.Hash[:]); err != nil {
		t.Fatal(err)
	}
	revoked, err := f.db.App.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoked.Rollback(ctx)
	if err := legacyAdminWriteGuard(ctx, revoked, actor, f.playerID); !errors.Is(err, identity.ErrCredentials) {
		t.Fatalf("revoked session passed write guard: %v", err)
	}
}

func TestIntegrationLegacyAdminSnapshots(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind) VALUES('snapshot_rope','material') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'snapshot_rope','material','normal',3)`, f.playerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(ctx, `UPDATE fishing.wallets SET coins=700 WHERE account_id=$1`, f.playerID); err != nil {
		t.Fatal(err)
	}

	if code, _ := f.call("GET", "/api/admin/users/snapshot?key="+f.playerKey, "", ""); code != 401 {
		t.Fatalf("snapshot without admin session: %d", code)
	}
	code, view := f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
	f.expect(code, view, 200, "")
	if view["coins"].(float64) != 700 || view["inventory"].(map[string]any)["snapshot_rope"].(float64) != 3 {
		t.Fatalf("initial snapshot: %v", view)
	}

	code, body := f.admin("POST", "/api/admin/users/snapshot-now", `{"target":"`+f.playerKey+`"}`)
	f.expect(code, body, 200, "")
	if body["count"].(float64) != 1 {
		t.Fatalf("snapshot-now count: %v", body)
	}
	code, list := f.admin("GET", "/api/admin/users/snapshots?key="+f.playerKey, "")
	f.expect(code, list, 200, "")
	snapshots := list["snapshots"].([]any)
	if len(snapshots) != 1 || snapshots[0].(map[string]any)["coins"].(float64) != 700 {
		t.Fatalf("snapshot list: %v", list)
	}
	snapName := snapshots[0].(map[string]any)["name"].(string)

	code, body = f.saveSnapshot(`{"target":"` + f.playerKey + `","coins":900,"inventory":{"snapshot_rope":1}}`)
	f.expect(code, body, 200, "")
	if body["coins"].(float64) != 900 || body["inventory"].(map[string]any)["snapshot_rope"].(float64) != 1 {
		t.Fatalf("edited snapshot: %v", body)
	}
	if code, _ = f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"missing_item":1}}`); code != 400 {
		t.Fatalf("unknown inventory item accepted: %d", code)
	}
	if _, err := f.db.Admin.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES('rod_bamboo','equipment','rod') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	component := `rod_bamboo#common#`
	code, body = f.saveSnapshot(`{"target":"` + f.playerKey + `","inventory":{"snapshot_rope":1,"` + component + `":1}}`)
	f.expect(code, body, 200, "")
	var beforeLoadoutRev, beforeRodEntries int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT loadout_rev,(SELECT count(*) FROM fishing.rod_entries WHERE owner_id=$1) FROM fishing.player_state WHERE account_id=$1`, f.playerID).Scan(&beforeLoadoutRev, &beforeRodEntries); err != nil {
		t.Fatal(err)
	}
	code, body = f.saveSnapshot(`{"target":"` + f.playerKey + `","bd":{"rod":{"compId":"` + component + `"}}}`)
	f.expect(code, body, 200, "")
	if body["bd"].(map[string]any)["rod"].(map[string]any)["compId"] != component {
		t.Fatalf("component equip: %v", body["bd"])
	}
	var afterLoadoutRev, afterRodEntries int64
	if err := f.db.Admin.QueryRow(ctx, `SELECT loadout_rev,(SELECT count(*) FROM fishing.rod_entries WHERE owner_id=$1) FROM fishing.player_state WHERE account_id=$1`, f.playerID).Scan(&afterLoadoutRev, &afterRodEntries); err != nil {
		t.Fatal(err)
	}
	if afterLoadoutRev != beforeLoadoutRev+1 || afterRodEntries != beforeRodEntries+1 {
		t.Fatal("admin bd edit did not advance rod revision and audit")
	}
	code, body = f.saveSnapshot(`{"target":"` + f.playerKey + `","bd":{"rod":{"compId":"` + component + `"}}}`)
	f.expect(code, body, 200, "")
	if err := f.db.Admin.QueryRow(ctx, `SELECT loadout_rev,(SELECT count(*) FROM fishing.rod_entries WHERE owner_id=$1) FROM fishing.player_state WHERE account_id=$1`, f.playerID).Scan(&beforeLoadoutRev, &beforeRodEntries); err != nil {
		t.Fatal(err)
	}
	if afterLoadoutRev != beforeLoadoutRev || afterRodEntries != beforeRodEntries {
		t.Fatal("unchanged admin bd edit rewrote rod revision and audit")
	}
	code, body = f.saveSnapshot(`{"target":"` + f.playerKey + `","coins":1200,"inventory":{"snapshot_rope":7},"bd":{"reel":{"compId":"` + component + `"}}}`)
	f.expect(code, body, 400, "")
	code, view = f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
	f.expect(code, view, 200, "")
	if view["coins"] != float64(900) || view["inventory"].(map[string]any)["snapshot_rope"] != float64(1) {
		t.Fatalf("invalid rod edit leaked preceding asset writes: %v", view)
	}

	code, body = f.admin("POST", "/api/admin/users/rollback", `{"target":"`+f.playerKey+`","snap":"`+snapName+`"}`)
	f.expect(code, body, 400, "回档需要二次确认")
	code, body = f.admin("POST", "/api/admin/users/rollback", `{"target":"`+f.playerKey+`","snap":"`+snapName+`","confirm":true}`)
	f.expect(code, body, 200, "")
	if body["coins"].(float64) != 700 || body["inventory"].(map[string]any)["snapshot_rope"].(float64) != 3 {
		t.Fatalf("rollback result: %v", body)
	}
	code, view = f.admin("GET", "/api/admin/users/snapshot?key="+f.playerKey, "")
	f.expect(code, view, 200, "")
	if len(view["bd"].(map[string]any)) != 0 {
		t.Fatalf("rollback left active rod assembly: %v", view["bd"])
	}

	code, body = f.admin("POST", "/api/admin/snapshot/config", `{"cfg":{"enabled":false,"intervalMin":2,"keep":1}}`)
	f.expect(code, body, 200, "")
	cfg := body["cfg"].(map[string]any)
	if cfg["enabled"] != false || cfg["intervalMin"].(float64) != 2 || cfg["keep"].(float64) != 1 {
		t.Fatalf("snapshot cfg: %v", body)
	}
	code, body = f.admin("POST", "/api/admin/users/snapshot-now", `{"target":"`+f.playerKey+`"}`)
	f.expect(code, body, 200, "")
	code, list = f.admin("GET", "/api/admin/users/snapshots?key="+f.playerKey, "")
	f.expect(code, list, 200, "")
	if list["count"].(float64) != 1 {
		t.Fatalf("snapshot retention: %v", list)
	}

	actions := map[string]bool{}
	for _, raw := range f.auditLog() {
		actions[raw.(map[string]any)["action"].(string)] = true
	}
	for _, action := range []string{"users/snapshot-now", "users/snapshot", "users/rollback", "snapshot/config"} {
		if !actions[action] {
			t.Fatalf("missing snapshot audit %s", action)
		}
	}
}
