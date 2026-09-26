package house

import (
	"context"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
	"testing"
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
	// Real identities + sessions: assets.Run revalidates the proof against
	// auth_sessions while holding the player guard, so a fake hash would be
	// rejected exactly like an expired login.
	f.owner, f.hash = f.account("house_player", false)
	f.admin, f.ahash = f.account("house_operator", true)
	// lockRow creates the row lazily; create it up front so tests can age the
	// settlement window directly.
	f.exec("INSERT INTO fishing.house_state(owner_id) VALUES($1)", f.owner)
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

// ageSettlement rewinds the settlement window without touching the server
// clock, which is exactly what "the player was offline for N hours" means.
func (f *fixture) ageSettlement(owner int64, expr string) {
	f.exec("UPDATE fishing.house_state SET settled_at=clock_timestamp()-"+expr+", enabled_at=clock_timestamp()-"+expr+" WHERE owner_id=$1", owner)
}

func (f *fixture) coins(owner int64) int64 {
	f.t.Helper()
	var n int64
	if err := f.db.Admin.QueryRow(f.ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", owner).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// The offline window is clamped to the yard capacity: a month away must pay the
// same as eight hours, otherwise the "bounded offline income" requirement is
// broken by simply staying logged out.
func TestCollectClampsOfflineWindow(t *testing.T) {
	f := setup(t)
	f.ageSettlement(f.owner, "interval '30 days'")
	if _, err := f.s.Collect(f.session(f.owner, false), f.owner, f.key("house-collect")); err != nil {
		t.Fatal(err)
	}
	h := f.c.HutConfig()
	want := h.Payout(h.Rate(1, 0), h.CapacityHours, 0)
	if got := f.coins(f.owner); got != want {
		t.Fatalf("30 days offline paid %d, want capacity-clamped %d", got, want)
	}
}

// There is deliberately no coin hard cap: renovating the hut must keep paying
// off. If someone reintroduces min(payout, cap), this test goes red.
func TestCollectKeepsNoCoinCap(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	h := c.HutConfig()
	base := payoutFor(t, 10, 0, h)
	improved := payoutFor(t, 10, 120, h)
	if improved <= base {
		t.Fatalf("endless investment did not increase payout: %d -> %d", base, improved)
	}
	want := h.Payout(h.Rate(10, 120), h.CapacityHours, 0)
	if improved != want {
		t.Fatalf("payout %d, want %d", improved, want)
	}
}

func payoutFor(t *testing.T, level, endless int, h rules.HutConfig) int64 {
	t.Helper()
	f := setup(t)
	f.exec("UPDATE fishing.house_state SET level=$2, endless=$3 WHERE owner_id=$1", f.owner, level, endless)
	f.ageSettlement(f.owner, "interval '30 days'")
	if _, err := f.s.Collect(f.session(f.owner, false), f.owner, f.key("house-collect")); err != nil {
		t.Fatal(err)
	}
	return f.coins(f.owner)
}

// Collecting is limited by time, not by a daily count: once the yard has
// refilled the player may collect again on the same day.
func TestCollectUnlimitedPerDay(t *testing.T) {
	f := setup(t)
	h := f.c.HutConfig()
	one := h.Payout(h.Rate(1, 0), h.CapacityHours, 0)
	for i := 0; i < 3; i++ {
		f.ageSettlement(f.owner, "interval '24 hours'")
		if _, err := f.s.Collect(f.session(f.owner, false), f.owner, f.key("house-collect")); err != nil {
			t.Fatalf("collection %d rejected: %v", i+1, err)
		}
	}
	if got, want := f.coins(f.owner), one*3; got != want {
		t.Fatalf("three same-day collections paid %d, want %d", got, want)
	}
}

// Operator reset clears the accrued yard; it must never hand out the backlog.
func TestAdminResetClearsAccruedHours(t *testing.T) {
	f := setup(t)
	f.ageSettlement(f.owner, "interval '8 hours'")
	if _, err := f.s.AdminReset(f.session(f.owner, true), f.admin, f.owner, f.key("house-reset")); err != nil {
		t.Fatal(err)
	}
	view, err := f.s.View(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if view.Hours > 0.01 {
		t.Fatalf("reset left %v hours accrued", view.Hours)
	}
	if got := f.coins(f.owner); got != 0 {
		t.Fatalf("reset paid out %d coins", got)
	}
}

// A frozen yard must stop accruing and refuse to pay out. The service reports
// this as a status (not an error) so the gateway can map it to 409 house_frozen.
func TestAdminFreezeBlocksCollect(t *testing.T) {
	f := setup(t)
	if _, err := f.s.AdminFreeze(f.session(f.owner, true), f.admin, f.owner, f.key("house-freeze"), true); err != nil {
		t.Fatal(err)
	}
	f.ageSettlement(f.owner, "interval '8 hours'")
	result, err := f.s.Collect(f.session(f.owner, false), f.owner, f.key("house-collect"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "frozen" {
		t.Fatalf("frozen yard returned status %q, want frozen", result.Status)
	}
	if got := f.coins(f.owner); got != 0 {
		t.Fatalf("frozen yard paid %d coins", got)
	}
}
