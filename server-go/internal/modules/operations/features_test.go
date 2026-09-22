package operations

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/mall"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/modules/social"
	"fishing.local/server/internal/modules/trade"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"fmt"
	"strconv"
	"sync"
	"testing"
)

func flags(enabled bool) map[string]bool {
	return map[string]bool{"market": enabled, "trade": enabled, "workshop": enabled, "chest": enabled, "mall": enabled, "sell": enabled, "autosell": enabled, "friends": enabled}
}
func TestIntegrationFeaturePublicationAuthorityRaceAndRollback(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	s := New(db.App)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 2)
	proofs := make([]context.Context, 2)
	for i := range ids {
		if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&ids[i]); err != nil {
			t.Fatal(err)
		}
		for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id) VALUES($1)`} {
			if _, err := db.Admin.Exec(ctx, sql, ids[i]); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,admin) VALUES($1,$2,'fixture','123456','unused-test-only',true)`, ids[i], fmt.Sprintf("admin_%d", i)); err != nil {
			t.Fatal(err)
		}
		var hash [32]byte
		hash[0] = byte(i + 1)
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at) VALUES($1,$2,true,clock_timestamp()+interval '1 hour')`, hash[:], ids[i]); err != nil {
			t.Fatal(err)
		}
		proofs[i] = assets.WithSession(ctx, ids[i], hash, true)
		if _, err := assets.New(db.App).ApplyChange(ctx, assets.Change{ActorID: ids[i], RequestKey: "stock", Reason: "reward", RuleVersion: "test-v1", Coins: 10000, Stacks: []assets.StackDelta{{ItemID: "bait_pack", Tier: "normal", Quantity: 10}}}); err != nil {
			t.Fatal(err)
		}
	}
	cmd := Publish{ActorID: ids[0], RequestKey: "publish", Flags: flags(false)}
	if _, err := s.Publish(ctx, cmd); err != assets.ErrUnauthenticated {
		t.Fatal("unauthenticated publish")
	}
	if _, err := s.Publish(assets.WithSession(ctx, ids[0], [32]byte{1}, false), cmd); err != assets.ErrUnauthenticated {
		t.Fatal("player realm publish")
	}
	listing, err := market.New(db.App).ListOrder(ctx, market.OrderRequest{ActorID: ids[0], RequestKey: "list", ItemID: "bait_pack", Quantity: 2, UnitPrice: 10, Hours: 6})
	if err != nil || listing.Status != "listed" {
		t.Fatal("list", err)
	}
	results := make([]assets.Result, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = s.Publish(proofs[i], Publish{ActorID: ids[i], RequestKey: "publish", Flags: flags(false)})
		}(i)
	}
	wg.Wait()
	winner := 0
	if results[1].Status == "published" {
		winner = 1
	}
	if errs[0] != nil || errs[1] != nil || results[winner].Status != "published" || results[1-winner].Status != "feature_revision_changed" {
		t.Fatal("publication race", results, errs)
	}
	view, err := s.Features(ctx)
	if err != nil || view.Revision < 1 || len(view.Digest) != 64 || view.Flags["mall"] {
		t.Fatal("head", view, err)
	}
	r, err := mall.New(db.App, c, nil).Buy(ctx, mall.Purchase{ActorID: ids[0], RequestKey: "blocked", ItemID: "bait_pack", Quantity: 1})
	if err != nil || r.Status != "feature_disabled" {
		t.Fatal("gate failed", r, err)
	}
	order, _ := strconv.ParseInt(listing.ResourceID, 10, 64)
	r, err = market.New(db.App).CloseOrder(ctx, ids[0], order, "cancel-while-closed", false)
	if err != nil || r.Status != "cancelled" {
		t.Fatal("disabled market trapped escrow", r, err)
	}
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER fail_release BEFORE UPDATE ON fishing.feature_head FOR EACH ROW EXECUTE FUNCTION fishing.fail_release()`); err != nil {
		t.Fatal(err)
	}
	resume := Publish{ActorID: ids[0], RequestKey: "resume", ExpectedRevision: view.Revision, Flags: flags(true)}
	if _, err := s.Publish(proofs[0], resume); err == nil {
		t.Fatal("expected publication failure")
	}
	var count int
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.feature_releases`).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed publication leaked history", count, err)
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_release ON fishing.feature_head`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Publish(proofs[0], resume)
	if err != nil || r.Status != "published" {
		t.Fatal("publication retry", r, err)
	}
	r, err = mall.New(db.App, c, nil).Buy(ctx, mall.Purchase{ActorID: ids[0], RequestKey: "enabled", ItemID: "bait_pack", Quantity: 1})
	if err != nil || r.Status != "purchased" {
		t.Fatal("enable failed", r, err)
	}
	// Eight-flag legacy publications leave newly introduced domains enabled.
	parties := social.New(db.App)
	party, err := parties.Party(ctx, social.PartyCommand{ActorID: ids[0], RequestKey: "party-create", Action: "create"})
	if err != nil || party.Status != "created" {
		t.Fatal("legacy flags disabled new domain", party, err)
	}
	view, err = s.Features(ctx)
	if err != nil {
		t.Fatal(err)
	}
	expanded := flags(true)
	conn, err := fishing.New(db.App).Connection(ctx, fishing.Connection{ActorID: ids[0], RequestKey: "native-connect", Action: "connect"})
	if err != nil || conn.Status != "connected" {
		t.Fatal(conn, err)
	}
	native := fishing.NewNative(db.App, c)
	cast, err := native.Start(ctx, fishing.NativeStart{ActorID: ids[0], RequestKey: "native-start", ConnectionGeneration: conn.Generation, GroundID: "map", SpotID: "dock"})
	if err != nil || cast.Status != "started" {
		t.Fatal(cast, err)
	}
	castID, _ := strconv.ParseInt(cast.ResourceID, 10, 64)
	// Keep an accepted trade with one confirmation in flight so disabling the
	// domain must cancel it and clear both confirmations atomically.
	otherConn, err := fishing.New(db.App).Connection(ctx, fishing.Connection{ActorID: ids[1], RequestKey: "trade-connect", Action: "connect"})
	if err != nil || otherConn.Status != "connected" {
		t.Fatal(otherConn, err)
	}
	trades := trade.New(db.App)
	invited, err := trades.Invite(ctx, trade.Invite{ActorID: ids[0], TargetID: ids[1], RequestKey: "feature-trade-invite"})
	if err != nil || invited.Status != "invited" {
		t.Fatal(invited, err)
	}
	tradeID, _ := strconv.ParseInt(invited.ResourceID, 10, 64)
	accepted, err := trades.Change(ctx, trade.Change{ActorID: ids[1], TradeID: tradeID, Revision: 1, RequestKey: "feature-trade-accept", Action: "respond", Accept: true})
	if err != nil || accepted.Status != "accepted" {
		t.Fatal(accepted, err)
	}
	confirmed, err := trades.Change(ctx, trade.Change{ActorID: ids[0], TradeID: tradeID, Revision: 2, RequestKey: "feature-trade-confirm", Action: "confirm"})
	if err != nil || confirmed.Status != "confirmed" {
		t.Fatal(confirmed, err)
	}
	expanded["sea"], expanded["party"], expanded["fishing"], expanded["trade"] = false, false, false, false
	// A technical failure while applying the shutdown side effect must roll back
	// the feature release and leave the active session untouched.
	if _, err := db.Admin.Exec(ctx, `CREATE FUNCTION fishing.fail_native_shutdown() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected native shutdown failure'; END $$; CREATE TRIGGER fail_native_shutdown BEFORE UPDATE ON fishing.native_fishing_sessions FOR EACH ROW EXECUTE FUNCTION fishing.fail_native_shutdown()`); err != nil {
		t.Fatal(err)
	}
	failed, err := s.Publish(proofs[0], Publish{ActorID: ids[0], RequestKey: "close-sea-party-failed", ExpectedRevision: view.Revision, Flags: expanded})
	if err == nil || failed.Status != "" {
		t.Fatal("shutdown failure did not roll back", failed, err)
	}
	var state string
	var generation int64
	var sessionResume bool
	if err := db.Admin.QueryRow(ctx, `SELECT state,generation,resume_enabled FROM fishing.native_fishing_sessions WHERE id=$1`, castID).Scan(&state, &generation, &sessionResume); err != nil {
		t.Fatal(err)
	}
	if state != "active" || generation != cast.Generation || sessionResume {
		t.Fatal("failed shutdown mutated session", state, generation, sessionResume)
	}
	var tradeState string
	var tradeRevision int64
	var tradeAConfirm, tradeBConfirm bool
	if err := db.Admin.QueryRow(ctx, `SELECT state,revision,a_confirm,b_confirm FROM fishing.trades WHERE id=$1`, tradeID).Scan(&tradeState, &tradeRevision, &tradeAConfirm, &tradeBConfirm); err != nil {
		t.Fatal(err)
	}
	if tradeState != "accepted" || tradeRevision != 2 || !tradeAConfirm || tradeBConfirm {
		t.Fatal("failed publication mutated trade", tradeState, tradeRevision, tradeAConfirm, tradeBConfirm)
	}
	var head int64
	if err := db.Admin.QueryRow(ctx, `SELECT release_id FROM fishing.feature_head WHERE singleton`).Scan(&head); err != nil || head != view.Revision {
		t.Fatal("failed shutdown mutated feature head", head, err)
	}
	if _, err := db.Admin.Exec(ctx, `DROP TRIGGER fail_native_shutdown ON fishing.native_fishing_sessions; DROP FUNCTION fishing.fail_native_shutdown()`); err != nil {
		t.Fatal(err)
	}
	r, err = s.Publish(proofs[0], Publish{ActorID: ids[0], RequestKey: "close-sea-party", ExpectedRevision: view.Revision, Flags: expanded})
	if err != nil || r.Status != "published" {
		t.Fatal("publish expanded flags", r, err)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT state,generation,resume_enabled FROM fishing.native_fishing_sessions WHERE id=$1`, castID).Scan(&state, &generation, &sessionResume); err != nil {
		t.Fatal(err)
	}
	if state != "stopped" || generation != cast.Generation+1 || sessionResume {
		t.Fatal("fishing shutdown did not stop active session", state, generation, sessionResume)
	}
	if err := db.Admin.QueryRow(ctx, `SELECT state,revision,a_confirm,b_confirm FROM fishing.trades WHERE id=$1`, tradeID).Scan(&tradeState, &tradeRevision, &tradeAConfirm, &tradeBConfirm); err != nil {
		t.Fatal(err)
	}
	if tradeState != "cancelled" || tradeRevision != 3 || tradeAConfirm || tradeBConfirm {
		t.Fatal("trade shutdown did not cancel active trade", tradeState, tradeRevision, tradeAConfirm, tradeBConfirm)
	}
	if _, err := native.Settle(ctx, fishing.Candidate{OwnerID: ids[0], SessionID: castID, Generation: cast.Generation, Sequence: 1}); err != assets.ErrDeferred {
		t.Fatal("disabled cycle must remain retryable", err)
	}
	r, err = native.Start(ctx, fishing.NativeStart{ActorID: ids[0], RequestKey: "disabled-native-start", ConnectionGeneration: conn.Generation, GroundID: "map", SpotID: "dock"})
	if err != nil || r.Status != "feature_disabled" {
		t.Fatal("native gate", r, err)
	}
	stale, err := native.Stop(ctx, fishing.Stop{ActorID: ids[0], RequestKey: "disabled-native-stop", Generation: cast.Generation})
	if err != nil || stale.Status != "stale_session" {
		t.Fatal("shutdown did not invalidate stale stop", stale, err)
	}
	seaService := sea.New(db.App, c)
	for _, command := range []sea.Command{
		{ActorID: ids[0], RequestKey: "blocked-chart", Action: "chart"},
		{ActorID: ids[0], RequestKey: "blocked-upgrade", Action: "upgrade", ExpectedLevel: 1},
	} {
		r, err := seaService.Apply(ctx, command)
		if err != nil || r.Status != "feature_disabled" {
			t.Fatal("sea gate", command.Action, r, err)
		}
	}
	for _, command := range []social.PartyCommand{
		{ActorID: ids[1], RequestKey: "blocked-create", Action: "create"},
		{ActorID: ids[0], TargetID: ids[1], RequestKey: "blocked-invite", Action: "invite"},
		{ActorID: ids[1], PartyID: 1, RequestKey: "blocked-accept", Action: "accept"},
	} {
		r, err := parties.Party(ctx, command)
		if err != nil || r.Status != "feature_disabled" {
			t.Fatal("party gate", command.Action, r, err)
		}
	}
	// Closing a feature must not prevent departures or collecting earned rewards.
	r, err = parties.Party(ctx, social.PartyCommand{ActorID: ids[0], RequestKey: "leave-closed-party", Action: "leave"})
	if err != nil || r.Status != "left" {
		t.Fatal("disabled party trapped member", r, err)
	}
	r, err = seaService.QuestRefresh(ctx, ids[0], "quests-while-closed")
	if err != nil || r.Status != "refreshed" {
		t.Fatal("disabled sea blocked quest view", r, err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_quest_boards SET selected='[{"id":"q_voyage","progress":2,"claimed":false}]' WHERE owner_id=$1`, ids[0]); err != nil {
		t.Fatal(err)
	}
	r, err = seaService.QuestClaim(ctx, ids[0], "claim-while-closed", "q_voyage")
	if err != nil || r.Status != "claimed" {
		t.Fatal("disabled sea trapped reward", r, err)
	}
	view, err = s.Features(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Reject incomplete required flags even if optional flags fill their count.
	invalid := flags(true)
	delete(invalid, "market")
	invalid["sea"] = true
	if _, err := s.Publish(proofs[0], Publish{ActorID: ids[0], RequestKey: "incomplete", ExpectedRevision: view.Revision, Flags: invalid}); err != assets.ErrInvalid {
		t.Fatal("missing required flag accepted", err)
	}
	r, err = s.Publish(proofs[0], Publish{ActorID: ids[0], RequestKey: "reopen-legacy", ExpectedRevision: view.Revision, Flags: flags(true)})
	if err != nil || r.Status != "published" {
		t.Fatal("reopen", r, err)
	}
	r, err = parties.Party(ctx, social.PartyCommand{ActorID: ids[1], RequestKey: "create-reopened", Action: "create"})
	if err != nil || r.Status != "created" {
		t.Fatal("party did not reopen", r, err)
	}
	if _, err := db.Admin.Exec(ctx, `DELETE FROM fishing.auth_sessions WHERE account_id=$1 AND admin`, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Publish(proofs[0], resume); err != assets.ErrUnauthenticated {
		t.Fatal("revoked admin replayed publish", err)
	}
	if _, err := db.Admin.Exec(ctx, `DELETE FROM fishing.feature_releases`); err == nil {
		t.Fatal("mutable release history")
	}
}
