package fishing

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"fishing.local/server/internal/rules"
)

func TestIntegrationSeaCatchBonusesProgressAndRollback(t *testing.T) {
	for _, event := range []string{"storm", "school", "bounty", "wreck"} {
		t.Run(event, func(t *testing.T) {
			f := nativeSetup(t)
			f.spot([]rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, nil, 100)
			g := f.s.catalog.Grounds()
			g[0].Type = "ocean"
			raw, _ := json.Marshal(g)
			f.s.catalog.Constants["GROUNDS"] = raw
			cfg := f.s.catalog.SeaConfig()
			cfg.Events = rules.SeaEvents{}
			switch event {
			case "storm":
				cfg.Events.Storm = 100
			case "school":
				cfg.Events.School = 100
			case "bounty":
				cfg.Events.Bounty = 100
				cfg.Events.BountyDouble = 100
			case "wreck":
				cfg.Events.Wreck = 100
			}
			cfg.Quests = []rules.SeaQuest{{ID: "test-ocean", Kind: "catch_ocean", Need: 20}, {ID: "test-event", Kind: "sea_event", Need: 20}}
			raw, _ = json.Marshal(cfg)
			f.s.catalog.Constants["SEA"] = raw
			f.exec(`INSERT INTO fishing.sea_players(owner_id,experience) VALUES($1,39)`, f.owner)
			c := f.start()
			f.exec(`CREATE FUNCTION fishing.fail_sea() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_sea BEFORE INSERT ON fishing.catch_segments FOR EACH ROW EXECUTE FUNCTION fishing.fail_sea()`)
			if _, e := f.s.Settle(f.ctx, c); e == nil {
				t.Fatal("fault accepted")
			}
			if f.num(`SELECT experience FROM fishing.sea_players WHERE owner_id=$1`, f.owner) != 39 || f.num(`SELECT count(*) FROM fishing.inventory_stacks`) != 0 {
				t.Fatal("partial sea reward")
			}
			f.exec(`DROP TRIGGER fail_sea ON fishing.catch_segments`)
			r, e := f.s.Settle(f.ctx, c)
			f.want(r, e, "settled")
			want := int64(1)
			if event == "storm" {
				want = 0
			}
			if f.num(`SELECT experience FROM fishing.sea_players WHERE owner_id=$1`, f.owner) != 39+want || f.num(`SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, f.owner) != want {
				t.Fatal("experience/catch count mismatch")
			}
			copies := want
			if event == "school" {
				copies++
			}
			if f.num(`SELECT COALESCE(sum(quantity),0) FROM fishing.inventory_stacks WHERE item_id='crucian'`) != copies || f.num(`SELECT COALESCE(sum(count),0) FROM fishing.player_codex WHERE item_id='crucian'`) != copies {
				t.Fatal("school count mismatch")
			}
			if f.num(`SELECT count(*) FROM fishing.catch_records`) != want {
				t.Fatal("bonus registered as primary catch")
			}
			if event == "bounty" && f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE item_id='chartfrag'`) != 2 {
				t.Fatal("bounty missing")
			}
			if event == "wreck" && f.num(`SELECT quantity FROM fishing.inventory_stacks WHERE item_id='deepscale'`) != 2 {
				t.Fatal("wreck missing")
			}
			r, e = f.s.Settle(f.ctx, c)
			f.want(r, e, "settled")
			f.reconcile()
		})
	}
}

func TestIntegrationSharedSeaPermissionRevokedBetweenSegments(t *testing.T) {
	f := nativeSetup(t)
	var owner int64
	if e := f.db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); e != nil {
		t.Fatal(e)
	}
	f.exec(`INSERT INTO fishing.player_state(account_id) VALUES($1)`, owner)
	c := f.start()
	// Synthetic topology/zone rows belong only to this isolated test database.
	op := f.num(`SELECT max(id) FROM fishing.asset_operations`)
	z := rules.SeaZone{ID: "shared", Mood: "deadly", Name: "test", Expire: time.Now().Add(time.Hour).UnixMilli(), Spots: []rules.SeaSpot{{ID: "z1", Pool: []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}}, Buffs: []rules.SeaBuff{{Type: "double", Value: 1e20}}}}}
	raw, _ := json.Marshal(z)
	f.exec(`INSERT INTO fishing.sea_zones(owner_id,id,data,expires_at,created_operation) VALUES($1,'shared',$2,clock_timestamp()+interval '1 hour',$3)`, owner, raw, op)
	ground := fmt.Sprintf("sea:%d:shared", owner)
	r, e := f.s.Start(f.ctx, NativeStart{ActorID: f.owner, RequestKey: f.next(), GroundID: ground, SpotID: "z1", ConnectionGeneration: f.num(`SELECT generation FROM fishing.fishing_connections WHERE owner_id=$1`, f.owner)})
	f.want(r, e, "sea_membership_required")
	f.exec(`INSERT INTO fishing.parties(leader_id,created_operation) VALUES($1,$2)`, owner, op)
	f.exec(`INSERT INTO fishing.party_members(owner_id,party_id,joined_operation,joined_revision) SELECT x,id,$3,1 FROM fishing.parties CROSS JOIN unnest(ARRAY[$1::bigint,$2::bigint]) x`, owner, f.owner, op)
	f.exec(`UPDATE fishing.native_fishing_sessions SET ground_id=$2,spot_id='z1' WHERE id=$1`, c.SessionID, ground)
	// Force a successful cast through the real cast formula; high skill sets bite 100.
	var runtime map[string]any
	_ = json.Unmarshal(f.s.catalog.Constants["SEA"], &runtime)
	runtime["events"] = map[string]any{}
	raw, _ = json.Marshal(runtime)
	f.s.catalog.Constants["SEA"] = raw
	z.Spots[0].Buffs = append(z.Spots[0].Buffs, rules.SeaBuff{Type: "skill", Value: 1e9})
	raw, _ = json.Marshal(z)
	f.exec(`UPDATE fishing.sea_zones SET data=$1`, raw)
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "progressed")
	before := f.num(`SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, f.owner)
	f.exec(`DELETE FROM fishing.party_members WHERE owner_id=$1`, f.owner)
	r, e = f.s.Settle(f.ctx, c)
	f.want(r, e, "stopped")
	if f.num(`SELECT catch_count FROM fishing.player_state WHERE account_id=$1`, f.owner) != before {
		t.Fatal("revoked member got rewards")
	}
	f.reconcile()
}
