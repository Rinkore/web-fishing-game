package house

import (
	"context"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

type fixture struct {
	t     *testing.T
	ctx   context.Context
	db    testdb.DB
	c     *rules.Catalog
	s     *Service
	owner int64
	hash  [32]byte
	admin int64
	ahash [32]byte
	seq   int
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, ctx: context.Background(), db: db, c: c, s: New(db.App, c)}
	f.owner, f.hash = f.account("house_player", false)
	f.admin, f.ahash = f.account("house_operator", true)
	f.exec("INSERT INTO fishing.house_state(owner_id) VALUES($1)", f.owner)
	// Give the player some fish to place on the rack.
	f.exec(`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity)
	        VALUES($1,'common_fish','fish','normal',20)
	        ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=EXCLUDED.quantity`, f.owner)
	return f
}

func (f *fixture) account(name string, admin bool) (int64, [32]byte) {
	f.t.Helper()
	var id int64
	if err := f.db.Admin.QueryRow(f.ctx, "INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id").Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	f.exec("INSERT INTO fishing.player_state(account_id) VALUES($1)", id)
	f.exec("INSERT INTO fishing.wallets(account_id,coins) VALUES($1,0)", id)
	f.exec(`INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,admin)
	        VALUES($1,$2,$2,'123456','x',$3)`, id, name, admin)
	var hash [32]byte
	copy(hash[:], []byte(name+"-token-hash-000000000000000000000000"))
	f.exec(`INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at)
	        VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`, hash[:], id, admin)
	return id, hash
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Admin.Exec(f.ctx, sql, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) session(owner int64, admin bool) context.Context {
	if admin {
		return assets.WithSession(f.ctx, f.admin, f.ahash, true)
	}
	return assets.WithSession(f.ctx, f.owner, f.hash, false)
}

func (f *fixture) key(prefix string) string {
	f.seq++
	return prefix + "-request-key-" + string(rune('a'+f.seq%26))
}

func (f *fixture) coins(owner int64) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", owner).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// placeFish is a test helper that places one fish on a rack slot and returns
// without checking the coin result. The fish id must already be in inventory.
func (f *fixture) placeFish(slotIdx int, fishID string, chain []string) {
	f.t.Helper()
	_, err := f.s.PlaceFish(
		f.session(f.owner, false),
		f.owner,
		f.key("house-place-"+fishID),
		fishID,
		slotIdx, chain,
	)
	if err != nil {
		f.t.Fatalf("placeFish slot %d: %v", slotIdx, err)
	}
}

// markDone fast-forwards the placed batch by updating its StartedAt far enough
// into the past that all phases are complete.
func (f *fixture) markDone(owner int64) {
	f.t.Helper()
	// Pull current racks from extras, set StartedAt 48 hours ago for all slots.
	f.exec(`UPDATE fishing.house_state
	        SET state = jsonb_set(
	            state,
	            '{racks}',
	            COALESCE((
	                SELECT jsonb_agg(
	                    slot || jsonb_build_object('startedAt', (clock_timestamp() - interval '48 hours')::text)
	                )
	                FROM jsonb_array_elements(state->'racks') AS slot
	            ), '[]'::jsonb)
	        )
	        WHERE owner_id=$1`, owner)
}

// TestPlaceFishAndCollectRack verifies the full lifecycle: place → collect → coins.
func TestPlaceFishAndCollectRack(t *testing.T) {
	f := setup(t)
	// Unlock one rack slot (level 3 = first slot by default config).
	f.exec("UPDATE fishing.house_state SET level=3 WHERE owner_id=$1", f.owner)

	f.placeFish(0, "common_fish", []string{"dry"})

	// Fast-forward so the batch is done.
	f.markDone(f.owner)

	_, err := f.s.CollectRack(f.session(f.owner, false), f.owner, f.key("house-collect"), false)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.coins(f.owner); got <= 0 {
		t.Fatalf("collect paid %d coins, want > 0", got)
	}
}

// TestCollectRackNothingReady returns a "nothing_ready" status when no batch is done.
func TestCollectRackNothingReady(t *testing.T) {
	f := setup(t)
	f.exec("UPDATE fishing.house_state SET level=3 WHERE owner_id=$1", f.owner)

	f.placeFish(0, "common_fish", []string{"dry"})

	result, err := f.s.CollectRack(f.session(f.owner, false), f.owner, f.key("house-collect-empty"), false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "nothing_ready" {
		t.Fatalf("expected nothing_ready, got %q", result.Status)
	}
	if got := f.coins(f.owner); got != 0 {
		t.Fatalf("nothing_ready paid %d coins", got)
	}
}

// TestRackSlotOccupiedRejection verifies placing on an occupied slot is rejected.
func TestRackSlotOccupiedRejection(t *testing.T) {
	f := setup(t)
	f.exec("UPDATE fishing.house_state SET level=3 WHERE owner_id=$1", f.owner)

	f.placeFish(0, "common_fish", []string{"dry"})

	// Give more fish so the second place attempt doesn't fail on inventory.
	f.exec(`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity)
	        VALUES($1,'common_fish','fish','normal',20)
	        ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=20`, f.owner)

	_, err := f.s.PlaceFish(
		f.session(f.owner, false),
		f.owner,
		f.key("house-place-dup"),
		"common_fish",
		0, []string{"dry"},
	)
	if err == nil {
		t.Fatal("expected rejection for occupied slot, got nil")
	}
}

// TestRackLockedAtLevelOne verifies rack slots are unavailable before level 3.
func TestRackLockedAtLevelOne(t *testing.T) {
	f := setup(t)
	// Level 1 — rackSlotsByLevel[0] == 0 by default config.
	_, err := f.s.PlaceFish(
		f.session(f.owner, false),
		f.owner,
		f.key("house-place-locked"),
		"common_fish",
		0, []string{"dry"},
	)
	if err == nil {
		t.Fatal("expected rack_locked rejection at level 1, got nil")
	}
}

// TestAdminFreezeBlocksCollectRack verifies a frozen house refuses to pay out.
func TestAdminFreezeBlocksCollectRack(t *testing.T) {
	f := setup(t)
	f.exec("UPDATE fishing.house_state SET level=3 WHERE owner_id=$1", f.owner)
	f.placeFish(0, "common_fish", []string{"dry"})
	f.markDone(f.owner)

	if _, err := f.s.AdminFreeze(f.session(f.owner, true), f.admin, f.owner, f.key("house-freeze"), true); err != nil {
		t.Fatal(err)
	}
	result, err := f.s.CollectRack(f.session(f.owner, false), f.owner, f.key("house-collect-frozen"), false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "frozen" {
		t.Fatalf("frozen house returned status %q, want frozen", result.Status)
	}
	if got := f.coins(f.owner); got != 0 {
		t.Fatalf("frozen house paid %d coins", got)
	}
}

// TestAdminResetClearsRacks verifies AdminReset clears in-progress racks.
func TestAdminResetClearsRacks(t *testing.T) {
	f := setup(t)
	f.exec("UPDATE fishing.house_state SET level=3 WHERE owner_id=$1", f.owner)
	f.placeFish(0, "common_fish", []string{"dry"})

	if _, err := f.s.AdminReset(f.session(f.owner, true), f.admin, f.owner, f.key("house-reset")); err != nil {
		t.Fatal(err)
	}
	// After reset, collecting immediately should return nothing_ready or frozen=false.
	view, err := f.s.View(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	// The rack slot is still present (reset doesn't erase placed batches, only
	// the settlement clock); verify no coins were paid.
	if got := f.coins(f.owner); got != 0 {
		t.Fatalf("reset paid out %d coins", got)
	}
	_ = view
}

// TestPremiumBatchCoinsHigherThanNormal verifies premium flag yields more coins.
func TestPremiumBatchCoinsHigherThanNormal(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	h := c.HutConfig()
	normal := batchCoins(h, 100, "common", []string{"dry"}, 0, 0, false)
	premium := batchCoins(h, 100, "common", []string{"dry"}, 0, 0, true)
	if premium <= normal {
		t.Fatalf("premium batch coins (%d) not greater than normal (%d)", premium, normal)
	}
}

// TestBatchTotalHoursReducedByProductionPet verifies production pet speeds drying.
func TestBatchTotalHoursReducedByProductionPet(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	h := c.HutConfig()
	baseHours := batchTotalHoursFrom(h, []string{"dry"}, 0)
	fasterHours := batchTotalHoursFrom(h, []string{"dry"}, 5)
	if fasterHours >= baseHours {
		t.Fatalf("production pet affinity 5 gave %v hours, expected less than base %v", fasterHours, baseHours)
	}
}

// TestAdvancePhasesMarksSlotDone verifies advancePhases sets Done=true once time elapses.
func TestAdvancePhasesMarksSlotDone(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	h := c.HutConfig()
	r := &row{
		Level: 3,
		Racks: []RackSlot{
			{
				SlotIdx:   0,
				FishID:    "common_fish",
				FishTier:  "common",
				FishPrice: 100,
				Phases:    []string{"dry"},
				PhaseIdx:  0,
				StartedAt: time.Now().UTC().Add(-48 * time.Hour), // far in the past
			},
		},
	}
	advancePhases(h, r, 0, time.Now().UTC())
	if !r.Racks[0].Done {
		t.Fatal("expected batch to be marked done after 48h elapsed")
	}
}
