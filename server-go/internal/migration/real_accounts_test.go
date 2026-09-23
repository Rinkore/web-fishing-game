package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func realTestAccount(t *testing.T, key string) RealAccount {
	t.Helper()
	hash, err := identity.HashPassword("migration-test-password")
	if err != nil {
		t.Fatal(err)
	}
	return RealAccount{Key: key, Payload: map[string]any{
		"username": key, "name": "Migration fixture", "qq": "123456", "pwHash": hash, "createdAt": int64(1789000000000),
		"coins": int64(123456), "catchCount": int64(987), "rodSlotsCount": int64(2), "listingCap": int64(79),
		"inventory":     map[string]any{"crucian": int64(17), "rope": int64(5), "rod_bamboo#common#spd+5": int64(2)},
		"bigfish":       map[string]any{"crucian": map[string]any{"L": int64(3), "G": int64(1)}},
		"bd":            map[string]any{"rod": map[string]any{"compId": "rod_bamboo#common#spd+5"}},
		"rodActiveSlot": int64(0), "rodName": "active",
		"rodSlots":  []any{map[string]any{"name": "active", "bd": map[string]any{"rod": map[string]any{"compId": "rod_bamboo#common#spd+5"}}}, map[string]any{"name": "spare", "bd": map[string]any{"rod": map[string]any{"compId": "rod_bamboo#common#spd+5"}}}},
		"codex":     map[string]any{"crucian": map[string]any{"count": int64(987), "first": int64(1789000000001), "min": float64(11.2), "max": float64(42.8), "tier": "G"}},
		"chestPity": map[string]any{"chest_wreck": int64(3)},
		"autoSell":  map[string]any{"tier": true, "items": map[string]any{"crucian": map[string]any{"on": true, "keep": int64(10)}}},
		"subNotify": map[string]any{"on": true, "badge": true, "blink": false},
		"mall":      map[string]any{"key": "2026-09-21", "bought": map[string]any{"relic": int64(2)}},
		"ship":      map[string]any{"lv": int64(3), "xp": int64(4321)}, "sea": map[string]any{"charts": int64(7), "zones": []any{}},
	}}
}

func TestRealAccountRodsAreAdditionalToFreeInventory(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	a := realTestAccount(t, "sample_a")
	p, err := planRealAccount(&RealContext{Catalog: c}, a)
	if err != nil {
		t.Fatal(err)
	}
	if p.Loose["rod_bamboo#common#spd+5"] != 2 || len(p.Rods) != 2 {
		t.Fatal("free and two bound copies must remain distinct")
	}
	a.Payload["bd"] = map[string]any{"rod": map[string]any{"compId": "rod_bamboo#common#spd+6"}}
	if _, err = planRealAccount(&RealContext{Catalog: c}, a); err == nil {
		t.Fatal("inconsistent active slot accepted")
	}
}

func TestRealAccountRejectsUnknownFieldsAndOverflow(t *testing.T) {
	c, _ := rules.Default()
	rc := &RealContext{Catalog: c}
	for _, field := range []string{"unknown_state", "coins"} {
		a := realTestAccount(t, "sample_a")
		if field == "coins" {
			a.Payload[field] = json.Number("9007199254740992")
		} else {
			a.Payload[field] = true
		}
		if _, e := planRealAccount(rc, a); e == nil {
			t.Fatal("invalid field accepted")
		}
	}
}

func TestRealLegacyMFAEncodingPreservesRFCSecret(t *testing.T) {
	// RFC 6238 public test secret, not a player credential.
	const hexSecret = "3132333435363738393031323334353637383930"
	const base32Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	got, e := realMFASecret(hexSecret)
	if e != nil || got != base32Secret {
		t.Fatal("legacy hex MFA conversion changed key bytes")
	}
	if got, e = realMFASecret(base32Secret); e != nil || got != base32Secret {
		t.Fatal("Base32 MFA compatibility failed")
	}
	if _, e = realMFASecret("invalid secret!"); e == nil {
		t.Fatal("invalid MFA accepted")
	}
}

func TestRealAccountRejectsUnknownNestedFields(t *testing.T) {
	c, _ := rules.Default()
	rc := &RealContext{Catalog: c}
	mutations := map[string]func(map[string]any){
		"bd_part":      func(m map[string]any) { realObject(m["bd"])["future_part"] = map[string]any{} },
		"bd_component": func(m map[string]any) { realObject(realObject(m["bd"])["rod"])["future_state"] = 1 },
		"bd_affix": func(m map[string]any) {
			realObject(realObject(m["bd"])["rod"])["affixes"] = []any{map[string]any{"type": "speed", "value": 5, "future_state": 1}}
		},
		"rod_slot":    func(m map[string]any) { realObject(realArray(m["rodSlots"])[0])["future_state"] = 1 },
		"codex_entry": func(m map[string]any) { realObject(realObject(m["codex"])["crucian"])["future_state"] = 1 },
		"mall":        func(m map[string]any) { realObject(m["mall"])["future_state"] = 1 },
		"mall_item":   func(m map[string]any) { realObject(realObject(m["mall"])["bought"])["future_item"] = 1 },
		"bigfish":     func(m map[string]any) { realObject(realObject(m["bigfish"])["crucian"])["future_tier"] = 1 },
		"chest_pity":  func(m map[string]any) { realObject(m["chestPity"])["future_chest"] = 1 },
		"ship":        func(m map[string]any) { realObject(m["ship"])["future_state"] = 1 },
		"sea":         func(m map[string]any) { realObject(m["sea"])["future_state"] = 1 },
		"quests": func(m map[string]any) {
			realObject(m["sea"])["quests"] = map[string]any{"day": "2026-09-21", "list": []any{}, "future_state": 1}
		},
		"quest": func(m map[string]any) {
			realObject(m["sea"])["quests"] = map[string]any{"day": "2026-09-21", "list": []any{map[string]any{"id": c.SeaConfig().Quests[0].ID, "kind": c.SeaConfig().Quests[0].Kind, "progress": 0, "claimed": false, "future_state": 1}}}
		},
		"subscription": func(m map[string]any) { realObject(m["subNotify"])["future_state"] = 1 },
		"autosell":     func(m map[string]any) { realObject(m["autoSell"])["future_state"] = 1 },
		"autosell_rule": func(m map[string]any) {
			realObject(realObject(realObject(m["autoSell"])["items"])["crucian"])["future_state"] = 1
		},
		"last_fishing": func(m map[string]any) {
			m["lastFishing"] = map[string]any{"groundId": "map", "spotId": "dock", "at": 1, "future_state": 1}
		},
		"object_type": func(m map[string]any) { m["subNotify"] = []any{} },
		"array_type":  func(m map[string]any) { realObject(m["sea"])["zones"] = map[string]any{} },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			a := realTestAccount(t, "sample_a")
			mutate(a.Payload)
			if _, e := planRealAccount(rc, a); e == nil {
				t.Fatal("unmapped nested input accepted")
			}
		})
	}
}

func TestRealAccountAllowsKnownArchivedMetadata(t *testing.T) {
	c, _ := rules.Default()
	a := realTestAccount(t, "sample_a")
	for _, bd := range []map[string]any{realObject(a.Payload["bd"]), realObject(realObject(realArray(a.Payload["rodSlots"])[0])["bd"])} {
		component := realObject(bd["rod"])
		component["name"] = "cached name"
		component["rare"] = "common"
		component["isCharm"] = false
		component["affixes"] = []any{map[string]any{"type": "speed", "value": 5, "extra": false, "src": "", "srcExplicit": false}}
	}
	realObject(realArray(a.Payload["rodSlots"])[0])["t"] = int64(1789000000000)
	realObject(a.Payload["sea"])["xpNotified"] = true
	realObject(a.Payload["sea"])["quests"] = map[string]any{"day": "2026-09-21", "list": []any{map[string]any{"id": "q_submit_scale", "kind": "submit_deepscale", "progress": 0, "claimed": false}}}
	a.Payload["lastFishing"] = map[string]any{"groundId": "map", "spotId": "dock", "at": int64(1789000000000)}
	if _, e := planRealAccount(&RealContext{Catalog: c}, a); e != nil {
		t.Fatal(e)
	}
}

func TestRealAccountFullRoundTripAndTampering(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	c, e := rules.Default()
	if e != nil {
		t.Fatal(e)
	}
	if e = workshop.SeedDefinitions(ctx, db.Admin, c); e != nil {
		t.Fatal(e)
	}
	tx, e := db.Admin.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	rc := &RealContext{Tx: tx, Catalog: c, IDs: map[string]int64{}, RunID: "33333333-3333-5333-8333-333333333333", Now: time.Now(), MFAKey: bytes.Repeat([]byte{7}, 32)}
	if _, e = tx.Exec(ctx, `INSERT INTO fishing.migration_runs(id,source_version,snapshot_sha256,tool_version,state) VALUES($1,'fixture',$2,'real-test','running')`, rc.RunID, strings.Repeat("a", 64)); e != nil {
		t.Fatal(e)
	}
	a, b := realTestAccount(t, "sample_a"), realTestAccount(t, "sample_b")
	a.Payload["friends"] = []any{"sample_b"}
	b.Payload["friends"] = []any{"sample_a"}
	a.Payload["admin"] = true
	a.Payload["adminTotpSecret"] = "JBSWY3DPEHPK3PXP"
	a.Payload["adminTotpStep"] = int64(77)
	accounts := []RealAccount{a, b}
	summary, e := ImportRealAccounts(ctx, rc, accounts)
	if e != nil {
		t.Fatal(e)
	}
	if summary.Accounts != 2 || summary.Equipment != 8 || summary.Friends != 1 || summary.MFA != 1 {
		t.Fatalf("unexpected counts %+v", summary)
	}
	if e = ReconcileRealAccounts(ctx, rc, accounts); e != nil {
		t.Fatal(e)
	}
	var stacks int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM fishing.inventory_entries`).Scan(&stacks); e != nil || stacks != 8 {
		t.Fatal("opening stack ledger missing")
	}
	if _, e = tx.Exec(ctx, `UPDATE fishing.player_codex SET max_size=max_size+1 WHERE owner_id=$1`, rc.IDs["sample_a"]); e != nil {
		t.Fatal(e)
	}
	if e = ReconcileRealAccounts(ctx, rc, accounts); e == nil {
		t.Fatal("codex tamper undetected")
	}
	if _, e = tx.Exec(ctx, `UPDATE fishing.player_codex SET max_size=42.8 WHERE owner_id=$1`, rc.IDs["sample_a"]); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `UPDATE fishing.equipment_instances SET definition_id='rod_carbon' WHERE id=(SELECT id FROM fishing.equipment_instances WHERE owner_id=$1 ORDER BY id LIMIT 1)`, rc.IDs["sample_a"]); e != nil {
		t.Fatal(e)
	}
	if e = ReconcileRealAccounts(ctx, rc, accounts); e == nil || !strings.Contains(e.Error(), "equipment_definition_diff") {
		t.Fatal("equipment signature/definition mismatch undetected")
	}
}

// This opt-in read-only preflight never connects to a database or emits source
// names/values. It is useful before copying a frozen private snapshot off host.
func TestRealPrivateAccountPreflight(t *testing.T) {
	root := os.Getenv("FISHING_REAL_PREFLIGHT_ROOT")
	if root == "" {
		t.Skip("private source preflight is opt-in")
	}
	c, e := rules.Default()
	if e != nil {
		t.Fatal(e)
	}
	rc := &RealContext{Catalog: c, IDs: map[string]int64{}}
	files, e := os.ReadDir(filepath.Join(root, "accounts"))
	if e != nil {
		t.Fatal("source unavailable")
	}
	accounts := []RealAccount{}
	for _, file := range files {
		if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(root, "accounts", file.Name()))
		if e != nil {
			t.Fatal("source read failed")
		}
		var payload map[string]any
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		if d.Decode(&payload) != nil {
			t.Fatal("source parse failed")
		}
		accounts = append(accounts, RealAccount{Key: strings.TrimSuffix(file.Name(), ".json"), Payload: payload})
	}
	stats := struct {
		Accounts, BoundEquipment, MFA, Stacks, Codex int
		LooseEquipment, Coins, Catches               int64
	}{}
	for i, a := range accounts {
		p, e := planRealAccount(rc, a)
		if e != nil {
			t.Fatalf("account ordinal %d: %v", i, e)
		}
		rc.IDs[strings.ToLower(a.Key)] = int64(i + 1)
		rc.IDs[p.Username] = int64(i + 1)
		stats.Accounts++
		stats.Stacks += len(p.Stacks)
		stats.Codex += len(p.Codex)
		stats.Coins += p.Coins
		stats.Catches += p.Catches
		for _, n := range p.Loose {
			stats.LooseEquipment += n
		}
		for _, r := range p.Rods {
			stats.BoundEquipment += len(r.Parts)
		}
		if p.Secret != "" {
			stats.MFA++
			if _, e = identity.EncryptMFA(bytes.Repeat([]byte{1}, 32), int64(i+1), p.Secret); e != nil {
				t.Fatal("private MFA format incompatible")
			}
		}
	}
	friends, e := realFriendPlan(rc, accounts)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("private account aggregate: %+v; social relations=%d", stats, len(friends))
}
