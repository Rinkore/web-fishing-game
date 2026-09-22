package social

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/testdb"
	"fmt"
	"sync"
	"testing"
)

func TestIntegrationFriendReciprocityRacesAndLimits(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	s := New(db.App)
	ids := make([]int64, 53)
	for i := range ids {
		if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&ids[i]); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES($1)`, ids[i]); err != nil {
			t.Fatal(err)
		}
	}
	a, b := ids[0], ids[1]
	commands := []FriendCommand{{a, b, "cross-a", "request"}, {b, a, "cross-b", "request"}}
	results := make([]assets.Result, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range commands {
		wg.Add(1)
		go func(i int) { defer wg.Done(); results[i], errs[i] = s.Friend(ctx, commands[i]) }(i)
	}
	wg.Wait()
	winner := 0
	if results[1].Status == "pending" {
		winner = 1
	}
	if errs[0] != nil || errs[1] != nil || results[winner].Status != "pending" || results[1-winner].Status != "incoming_request_exists" {
		t.Fatal("cross request race", results, errs)
	}
	sender, recipient := commands[winner].ActorID, commands[winner].TargetID
	r, err := s.Friend(ctx, FriendCommand{sender, recipient, "cannot-self-accept", "accept"})
	if err != nil || r.Status != "friend_request_missing" {
		t.Fatal("wrong accept direction", err, r.Status)
	}
	r, err = s.Friend(ctx, FriendCommand{recipient, sender, "accept", "accept"})
	if err != nil || r.Status != "accepted" {
		t.Fatal("accept", err, r.Status)
	}
	for _, owner := range []int64{sender, recipient} {
		list, err := s.Relations(ctx, owner, 0, 100)
		if err != nil || len(list) != 1 || list[0].Kind != "friend" || list[0].ID == owner {
			t.Fatal("reciprocity", list, err)
		}
	}
	// Replaying the old request returns its old result without restoring pending state.
	r, err = s.Friend(ctx, commands[winner])
	if err != nil || r.OperationID != results[winner].OperationID {
		t.Fatal("replay", err)
	}
	r, err = s.Friend(ctx, FriendCommand{a, b, "remove", "remove"})
	if err != nil || r.Status != "removed" {
		t.Fatal("remove", err)
	}
	for i := 1; i <= 50; i++ {
		r, err := s.Friend(ctx, FriendCommand{a, ids[i], fmt.Sprintf("request-%d", i), "request"})
		if err != nil || r.Status != "pending" {
			t.Fatal("seed outgoing", i, err, r.Status)
		}
	}
	r, err = s.Friend(ctx, FriendCommand{a, ids[51], "too-many", "request"})
	if err != nil || r.Status != "friend_request_limit" {
		t.Fatal("request limit", err, r.Status)
	}
	r, err = s.Friend(ctx, FriendCommand{a, b, "cancel", "cancel"})
	if err != nil || r.Status != "cancelled" {
		t.Fatal("cancel", err, r.Status)
	}
	r, err = s.Friend(ctx, FriendCommand{a, ids[51], "slot-freed", "request"})
	if err != nil || r.Status != "pending" {
		t.Fatal("released quota", err, r.Status)
	}
	// A failing relationship write must roll back its event/revision as well.
	var before int64
	if err := db.Admin.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, ids[51]).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_friend() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_friend BEFORE UPDATE ON fishing.friend_relations FOR EACH ROW EXECUTE FUNCTION fishing.fail_friend()`); err != nil {
		t.Fatal(err)
	}
	cmd := FriendCommand{ids[51], a, "accept-fault", "accept"}
	if _, err := s.Friend(ctx, cmd); err == nil {
		t.Fatal("expected fault")
	}
	var after int64
	if err := db.Admin.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, ids[51]).Scan(&after); err != nil || before != after {
		t.Fatal("fault leaked revision", err)
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_friend ON fishing.friend_relations`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Friend(ctx, cmd)
	if err != nil || r.Status != "accepted" {
		t.Fatal("recovered accept", err, r.Status)
	}
}
