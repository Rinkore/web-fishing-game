package gateway

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

func decodePersonalFrames(t *testing.T, frames []string) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, frame := range frames {
		var value map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(frame, "data: "))), &value); err != nil {
			t.Fatal(err)
		}
		out = append(out, value)
	}
	return out
}

func TestIntegrationPersonalPushNativeSegmentsAndSnapshot(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(f.ctx, f.db.Admin, c); err != nil {
		t.Fatal(err)
	}
	grounds := c.Grounds()
	grounds[0].Spots[0].Pool = []rules.LootEntry{{Pick: "fish:crucian", Weight: 1}, {Pick: "material:rope", Weight: 1}, {Pick: "component:", Weight: 1}}
	grounds[0].Spots[0].BiteRate = 100
	c.Constants["GROUNDS"], _ = json.Marshal(grounds)
	c.Runtime = map[string]any{"doubleBase": 1.0}
	svc := fishing.NewNative(f.db.App, c)
	owner := f.id["trade_a"]
	start, err := svc.Start(f.ctx, fishing.NativeStart{ActorID: owner, RequestKey: "personal-start", GroundID: "map", SpotID: "dock", ConnectionGeneration: 1})
	if err != nil || start.Status != "started" {
		t.Fatalf("start: %+v %v", start, err)
	}
	id, _ := strconv.ParseInt(start.ResourceID, 10, 64)
	if _, err := f.db.Admin.Exec(f.ctx, `UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()-interval '1 hour',private_seed=decode(repeat('12',32),'hex') WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	f.expectPost("/api/subscribe", `{"on":true,"badge":false,"blink":true}`, "trade_a", 200, "")
	code, profile := f.do("GET", "/api/me", "", f.token["trade_a"])
	if code != 200 || profile["subNotify"].(map[string]any)["badge"] != false {
		t.Fatalf("subscription profile: %v", profile)
	}
	p := &legacyPersonalPush{api: &API{pool: f.db.App}, owner: owner, name: "trade_a", catalog: c}
	if _, err := p.init(f.ctx); err != nil {
		t.Fatal(err)
	}
	result, err := svc.Settle(f.ctx, fishing.Candidate{OwnerID: owner, SessionID: id, Generation: start.Generation, Sequence: 1})
	if err != nil || result.Status != "progressed" {
		t.Fatalf("segment: %+v %v", result, err)
	}
	var details struct {
		Catches []rules.Catch `json:"catches"`
	}
	if err := json.Unmarshal(result.Details, &details); err != nil {
		t.Fatal(err)
	}
	result, err = svc.Settle(f.ctx, fishing.Candidate{OwnerID: owner, SessionID: id, Generation: start.Generation, Sequence: 1})
	if err != nil || result.Status != "progressed" {
		t.Fatalf("second segment: %+v %v", result, err)
	}
	var second struct {
		Catches []rules.Catch `json:"catches"`
	}
	if err := json.Unmarshal(result.Details, &second); err != nil {
		t.Fatal(err)
	}
	details.Catches = append(details.Catches, second.Catches...)
	if len(details.Catches) <= 100 {
		t.Fatalf("fixture needs >100 catches, got %d", len(details.Catches))
	}
	// A sale/grant races ahead of reading the catches. The snapshot must reflect
	// current truth, not add the caught items a second time to an HTTP snapshot.
	_, err = assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: owner, RequestKey: "personal-sale", Reason: "consume", RuleVersion: "test-v1", Stacks: []assets.StackDelta{{ItemID: "crucian", Tier: "normal", Quantity: -1}}})
	if err != nil {
		t.Fatal(err)
	}
	frames, err := p.poll(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	items, alerts := []string{}, 0
	kinds := map[string]bool{}
	var state map[string]any
	for _, frame := range decodePersonalFrames(t, frames) {
		switch frame["type"] {
		case "catch":
			entry := frame["entry"].(map[string]any)
			if entry["ground"] != "世界地图" || entry["spot"] != "湖畔老码头" {
				t.Fatalf("location: %v", entry)
			}
			item := entry["item"].(map[string]any)
			items = append(items, item["id"].(string))
			kinds[item["kind"].(string)] = true
		case "subalert":
			alerts++
		case "assets":
			state = frame
		case "codexAdd":
			t.Fatal("snapshot must not double increment codex")
		}
	}
	if len(items) != len(details.Catches) || len(kinds) != 3 {
		t.Fatalf("missing catch kinds/tail: %d %v", len(items), kinds)
	}
	wantAlerts := 0
	for i, catch := range details.Catches {
		if items[i] != catch.ID {
			t.Fatalf("catch order changed at %d", i)
		}
		if catch.Kind == "component" {
			wantAlerts++
		}
	}
	if alerts != wantAlerts || alerts == 0 {
		t.Fatalf("subscription: got %d want %d", alerts, wantAlerts)
	}
	code, profile = f.do("GET", "/api/me", "", f.token["trade_a"])
	if code != 200 {
		t.Fatal(profile)
	}
	for _, key := range []string{"inventory", "bigfish", "codex", "catchCount", "coins", "invRev"} {
		got, _ := json.Marshal(state[key])
		want, _ := json.Marshal(profile[key])
		if string(got) != string(want) {
			t.Fatalf("snapshot %s: %s != %s", key, got, want)
		}
	}
	if frames, err := p.poll(f.ctx); err != nil || len(frames) != 0 {
		t.Fatalf("idle replay: %v %v", frames, err)
	}
	// Disabling subscription applies without reconnecting; failed reads leave
	// the operation cursor untouched, then retry sends the whole segment once.
	f.expectPost("/api/subscribe", `{"on":false}`, "trade_a", 200, "")
	result, err = svc.Settle(f.ctx, fishing.Candidate{OwnerID: owner, SessionID: id, Generation: start.Generation, Sequence: 1})
	if err != nil || result.Status != "progressed" {
		t.Fatalf("continuation: %+v %v", result, err)
	}
	before := p.cursor
	role := pgx.Identifier{f.db.Role}.Sanitize()
	if _, err := f.db.Admin.Exec(f.ctx, "REVOKE SELECT ON fishing.inventory_stacks FROM "+role); err != nil {
		t.Fatal(err)
	}
	if frames, err := p.poll(f.ctx); err == nil || len(frames) != 0 || p.cursor != before {
		t.Fatalf("failed read acknowledged page: %v %v", frames, err)
	}
	if _, err := f.db.Admin.Exec(f.ctx, "GRANT SELECT ON fishing.inventory_stacks TO "+role); err != nil {
		t.Fatal(err)
	}
	frames, err = p.poll(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range decodePersonalFrames(t, frames) {
		if frame["type"] == "subalert" {
			t.Fatal("disabled subscription sent alert")
		}
	}
	reconnect := &legacyPersonalPush{api: p.api, owner: owner, name: p.name, catalog: c}
	if _, err := reconnect.init(f.ctx); err != nil {
		t.Fatal(err)
	}
	if frames, err := reconnect.poll(f.ctx); err != nil || len(frames) != 0 {
		t.Fatalf("reconnect replay: %v %v", frames, err)
	}
}

func TestIntegrationPersonalPushPagesAndInitRace(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	c, _ := rules.Default()
	p := &legacyPersonalPush{api: &API{pool: f.db.App}, owner: f.id["trade_a"], name: "trade_a", catalog: c}
	if _, err := p.init(f.ctx); err != nil {
		t.Fatal(err)
	}
	// These commits land after the init snapshot but before it can be sent.
	for i := 0; i < 18; i++ {
		tx := stageSocialCatches(t, f, "trade_a", fmt.Sprintf("page-%d", i), "map", 105, 0)
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	for page, want := range []int{16 * 105, 2 * 105, 0} {
		frames, err := p.poll(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		caught := 0
		for _, f := range decodePersonalFrames(t, frames) {
			if f["type"] == "catch" {
				caught++
			}
		}
		if caught != want {
			t.Fatalf("page %d: got %d want %d", page, caught, want)
		}
	}
}

func TestLegacySubscriptionMatches(t *testing.T) {
	c, _ := rules.Default()
	min, max := 10.0, 20.0
	for _, tt := range []struct {
		name, id string
		cfg      *legacySubConfig
		want     bool
	}{
		{"off", "rod_bamboo#common#", nil, false},
		{"all", "rod_bamboo#common#", &legacySubConfig{On: true}, true},
		{"base", "rod_bamboo#common#", &legacySubConfig{On: true, BaseID: "line_cotton"}, false},
		{"quality", "rod_bamboo#common#", &legacySubConfig{On: true, Quality: "legend"}, false},
		{"inclusive", "rod_bamboo#common#spd10", &legacySubConfig{On: true, AffixType: "speed", Min: &min, Max: &max}, true},
		{"bounds", "rod_bamboo#common#spd21", &legacySubConfig{On: true, Min: &min, Max: &max}, false},
		{"same affix", "rod_bamboo#common#spd5,rare20", &legacySubConfig{On: true, AffixType: "speed", Min: &min}, false},
		{"no affix", "rod_bamboo#common#", &legacySubConfig{On: true, Min: &min}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := legacyMatchesSubscription(c, tt.id, tt.cfg); got != tt.want {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestIntegrationPersonalPushCommitBetweenWakeupAndPage(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	c, _ := rules.Default()
	p := &legacyPersonalPush{api: &API{pool: f.db.App}, owner: f.id["trade_a"], name: "trade_a", catalog: c}
	if _, err := p.init(f.ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 18; i++ {
		tx := stageSocialCatches(t, f, "trade_a", fmt.Sprintf("wake-%d", i), "map", 1, 0)
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.poll(f.ctx); err != nil {
		t.Fatal(err)
	}
	if p.snapshot <= p.cursor {
		t.Fatal("fixture needs a snapshot ahead of the catch cursor")
	}
	// Hold the outbox read while the cheap player revision remains at the old
	// committed value. Committing releases the page read onto a newer revision.
	tx := stageSocialCatches(t, f, "trade_a", "wake-late", "map", 1, 0)
	if _, err := tx.Exec(f.ctx, `LOCK TABLE fishing.outbox_events IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		frames []string
		err    error
	}
	done := make(chan result, 1)
	go func() { frames, err := p.poll(f.ctx); done <- result{frames, err} }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := f.db.Admin.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock')`, f.db.Role).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("page did not block on outbox lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		frames := socialFrames(t, got.frames)
		if frames["assets"] == nil || frames["assets"]["invRev"] != strconv.FormatInt(p.cursor, 10) {
			t.Fatalf("new page acknowledged without fresh snapshot: %v", frames["assets"])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("blocked poll did not recover")
	}
}

func TestIntegrationPersonalPushLiveAssets(t *testing.T) {
	f := newLegacyTradeFixture(t)
	f.seed()
	feed := openLegacyTradeStream(t, f, "trade_a")
	defer feed.cancel()
	feed.wait(t, "init", 10*time.Second)
	initial := feed.wait(t, "assets", 10*time.Second)
	if initial["inventory"].(map[string]any)["rope"] != float64(1) {
		t.Fatal(initial)
	}
	_, err := assets.New(f.db.App).ApplyChange(f.ctx, assets.Change{ActorID: f.id["trade_a"], RequestKey: "live-grant", Reason: "reward", RuleVersion: "test-v1", Coins: 77})
	if err != nil {
		t.Fatal(err)
	}
	updated := feed.wait(t, "assets", 10*time.Second)
	if updated["coins"] != float64(577) || updated["invRev"] == initial["invRev"] {
		t.Fatalf("live grant: %v", updated)
	}
}
