package social

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

type partyFixture struct {
	t      *testing.T
	db     testdb.DB
	s      *Service
	ctx    context.Context
	ids    []int64
	serial int
}

func newPartyFixture(t *testing.T, n int) *partyFixture {
	t.Helper()
	f := &partyFixture{t: t, db: testdb.New(t, true), ctx: context.Background(), ids: make([]int64, n)}
	f.s = New(f.db.App)
	for i := range f.ids {
		if err := f.db.Admin.QueryRow(f.ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&f.ids[i]); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.player_state(account_id) VALUES($1)`, f.ids[i]); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Admin.Exec(f.ctx, `INSERT INTO fishing.wallets(account_id) VALUES($1)`, f.ids[i]); err != nil {
			t.Fatal(err)
		}
	}
	return f
}
func (f *partyFixture) command(actor, target, party int64, action, status string) assets.Result {
	f.t.Helper()
	f.serial++
	r, err := f.s.Party(f.ctx, PartyCommand{actor, target, party, fmt.Sprintf("party-%d", f.serial), action})
	if err != nil || r.Status != status {
		f.t.Fatalf("%s: status=%s err=%v", action, r.Status, err)
	}
	return r
}
func (f *partyFixture) view(owner int64) Party {
	f.t.Helper()
	v, err := f.s.PartyView(f.ctx, owner)
	if err != nil {
		f.t.Fatal(err)
	}
	return v["party"].(Party)
}
func (f *partyFixture) create(owner int64) int64 {
	f.t.Helper()
	f.command(owner, 0, 0, "create", "created")
	return f.view(owner).ID
}
func (f *partyFixture) invite(leader, target int64) {
	f.t.Helper()
	f.serial++
	r, err := f.s.Friend(f.ctx, FriendCommand{leader, target, fmt.Sprintf("friend-request-%d", f.serial), "request"})
	if err != nil {
		f.t.Fatal(err)
	}
	if r.Status == "pending" {
		r, err = f.s.Friend(f.ctx, FriendCommand{target, leader, fmt.Sprintf("friend-accept-%d", f.serial), "accept"})
		if err != nil || r.Status != "accepted" {
			f.t.Fatal("friend", r.Status, err)
		}
	} else if r.Status != "accepted" {
		f.t.Fatal("friend state", r.Status)
	}
	f.command(leader, target, 0, "invite", "invited")
}
func (f *partyFixture) join(leader, target, party int64) {
	f.t.Helper()
	f.invite(leader, target)
	f.command(target, 0, party, "accept", "accepted")
}

func TestIntegrationPartyAtomicSwitchCapacityAndRollback(t *testing.T) {
	f := newPartyFixture(t, 9)
	a, b, c := f.ids[0], f.ids[1], f.ids[2]
	pa, pb, pc := f.create(a), f.create(b), f.create(c)
	f.join(a, f.ids[3], pa)
	f.join(c, f.ids[4], pc)
	f.join(b, f.ids[5], pb)
	f.join(b, f.ids[6], pb)
	f.command(a, f.ids[7], 0, "invite", "party_friend_required")
	f.command(f.ids[3], f.ids[7], 0, "invite", "party_leader_required")
	f.invite(b, a)
	f.invite(b, c)
	before := []Party{f.view(a), f.view(c)}
	commands := []PartyCommand{{a, 0, pb, "last-slot-a", "accept"}, {c, 0, pb, "last-slot-c", "accept"}}
	results := make([]assets.Result, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range commands {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errs[i] = f.s.Party(f.ctx, commands[i]) }(i)
	}
	wg.Wait()
	winner := 0
	if results[1].Status == "accepted" {
		winner = 1
	}
	loser := 1 - winner
	if errs[0] != nil || errs[1] != nil || results[winner].Status != "accepted" || results[loser].Status != "party_full" {
		t.Fatal("last slot race", results, errs)
	}
	old := f.view(commands[loser].ActorID)
	if !reflect.DeepEqual(old, before[loser]) {
		t.Fatal("failed switch changed original party", old, before[loser])
	}
	v, err := f.s.PartyView(f.ctx, commands[loser].ActorID)
	if err != nil || v["invitedPartyId"] != strconv.FormatInt(pb, 10) {
		t.Fatal("failed switch lost invitation", err)
	}
	if len(f.view(b).Members) != 4 {
		t.Fatal("capacity exceeded")
	}
	// A departed leader hands ownership to the first actual join, not request ID order.
	buddy := f.ids[3]
	if winner == 1 {
		buddy = f.ids[4]
	}
	if p := f.view(buddy); p.LeaderID != buddy || len(p.Members) != 1 {
		t.Fatal("leader succession", p)
	}
	for i, cmd := range commands {
		again, err := f.s.Party(f.ctx, cmd)
		// JSONB preserves values, not object key order or insignificant spaces.
		// Compare every result field semantically, including the party snapshot.
		var got, want any
		gotJSON, gotErr := json.Marshal(again)
		wantJSON, wantErr := json.Marshal(results[i])
		if gotErr != nil || wantErr != nil || json.Unmarshal(gotJSON, &got) != nil || json.Unmarshal(wantJSON, &want) != nil {
			t.Fatal("invalid replay JSON")
		}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatal("idempotent accept", err)
		}
	}
	// Fail the final event write, after removal/insertion, and verify the entire switch rolls back.
	target := f.ids[7]
	pt := f.create(target)
	who := commands[loser].ActorID
	f.invite(target, who)
	var rev int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT revision FROM fishing.party_guard`).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `CREATE FUNCTION fishing.fail_party_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_party_event BEFORE INSERT ON fishing.party_events FOR EACH ROW EXECUTE FUNCTION fishing.fail_party_event()`); err != nil {
		t.Fatal(err)
	}
	cmd := PartyCommand{who, 0, pt, "switch-fault", "accept"}
	if _, err := f.s.Party(f.ctx, cmd); err == nil {
		t.Fatal("expected injected fault")
	}
	if !reflect.DeepEqual(f.view(who), old) || len(f.view(target).Members) != 1 {
		t.Fatal("failed transaction leaked membership")
	}
	var after int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT revision FROM fishing.party_guard`).Scan(&after); err != nil || after != rev {
		t.Fatal("failed transaction leaked event cursor", err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, `DROP TRIGGER fail_party_event ON fishing.party_events`); err != nil {
		t.Fatal(err)
	}
	r, err := f.s.Party(f.ctx, cmd)
	if err != nil || r.Status != "accepted" {
		t.Fatal("fault recovery", r.Status, err)
	}
	var recipients []int64
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT recipients FROM fishing.party_events WHERE operation_id=$1`, r.OperationID).Scan(&recipients); err != nil {
		t.Fatal(err)
	}
	for _, id := range append(memberIDs(old), target) {
		found := false
		for _, recipient := range recipients {
			if id == recipient {
				found = true
			}
		}
		if !found {
			t.Fatal("missing affected recipient", id)
		}
	}
	f.command(who, 0, 0, "disband", "party_leader_required")
	f.command(target, who, 0, "kick", "kicked")
	if f.view(who).ID != 0 {
		t.Fatal("kick did not remove membership")
	}
	f.command(target, 0, 0, "leave", "left")
	var active bool
	if err := f.db.Admin.QueryRow(f.ctx, `SELECT active FROM fishing.parties WHERE id=$1`, pt).Scan(&active); err != nil || active {
		t.Fatal("last departure did not deactivate", err)
	}
	if _, err := f.db.App.Exec(f.ctx, `DELETE FROM fishing.party_events`); err == nil {
		t.Fatal("party audit is mutable")
	}
}

func TestIntegrationPartySharingRevocationAndReplay(t *testing.T) {
	f := newPartyFixture(t, 4)
	a, b, c, d := f.ids[0], f.ids[1], f.ids[2], f.ids[3]
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	s := sea.New(f.db.App, catalog)
	zoneIDs := map[int64]string{}
	for _, owner := range []int64{a, b, c} {
		_, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: owner, RequestKey: "seed-chart", Reason: "reward", RuleVersion: "test", Stacks: []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: 3}}})
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.Apply(f.ctx, sea.Command{ActorID: owner, RequestKey: "chart", Action: "chart"})
		if err != nil || r.Status != "crafted" {
			t.Fatal("chart", err)
		}
		r, err = s.Voyage(f.ctx, owner, "voyage")
		if err != nil || r.Status != "voyaged" {
			t.Fatal("voyage", err)
		}
		zoneIDs[owner] = r.ResourceID
	}
	pa := f.create(a)
	pc := f.create(c)
	f.join(a, b, pa)
	check := func(owner int64, want []int64) {
		t.Helper()
		v, err := f.s.PartyView(f.ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		o, err := s.Overview(f.ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		zones := v["memberZones"].([]sea.SharedZone)
		if !reflect.DeepEqual(zones, o["memberZones"]) || len(zones) != len(want) {
			t.Fatal("party/sea views disagree", len(zones), len(want))
		}
		for i, z := range zones {
			if z.OwnerID != want[i] || z.ID != zoneIDs[want[i]] {
				t.Fatal("wrong shared owner", z.OwnerID)
			}
		}
		data, _ := json.Marshal(zones)
		var public []map[string]any
		_ = json.Unmarshal(data, &public)
		for _, z := range public {
			for _, spot := range z["spots"].([]any) {
				if _, exists := spot.(map[string]any)["pool"]; exists {
					t.Fatal("private pool exposed")
				}
			}
		}
	}
	check(a, []int64{b})
	check(b, []int64{a})
	check(c, nil)
	check(d, nil)
	r, err := s.Anchor(f.ctx, b, "cannot-anchor-shared", zoneIDs[a])
	if err != nil || r.Status != "sea_zone_expired" {
		t.Fatal("non-owner anchored shared zone", r.Status, err)
	}
	f.invite(c, b)
	f.command(b, 0, pc, "accept", "accepted")
	check(a, nil)
	check(b, []int64{c})
	check(c, []int64{b})
	// A committed disband survives recreating the service; old commands do not restore membership.
	cmd := PartyCommand{c, 0, 0, "disband", "disband"}
	r, err = f.s.Party(f.ctx, cmd)
	if err != nil || r.Status != "disbanded" {
		t.Fatal(err)
	}
	f.s = New(f.db.App)
	again, err := f.s.Party(f.ctx, cmd)
	if err != nil || again.OperationID != r.OperationID {
		t.Fatal("disband replay", err)
	}
	check(b, nil)
	check(c, nil)
	// One current invitation, stale accept denied, decline removes it.
	f.invite(a, d)
	pc = f.create(c)
	f.invite(c, d)
	f.command(d, 0, pa, "accept", "party_invite_missing")
	f.command(d, 0, 0, "decline", "declined")
	f.command(d, 0, pc, "accept", "party_invite_missing")
	f.join(a, b, pa)
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.sea_zones SET expires_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, a); err != nil {
		t.Fatal(err)
	}
	check(b, nil)
	check(a, []int64{b})
	f.command(a, b, 0, "kick", "kicked")
	check(a, nil)
	check(b, nil)
	f.join(a, b, pa)
	f.command(b, 0, 0, "leave", "left")
	check(a, nil)
	check(b, nil)
}
