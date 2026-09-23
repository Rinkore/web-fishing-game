package migration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"fishing.local/server/internal/testdb"
)

func TestRealMarketEconomyPreservesBalancesEscrowAndHistory(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	root := t.TempDir()
	write := func(name string, v any) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), jsonBytes(v, nil), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("config.json", map[string]any{"feedbackCfg": map[string]any{"cdHours": 3, "skipCost": 9}, "features": map[string]any{"sea.voyage": false}, "banners": []any{}, "bannerSeq": 7})
	now := time.Now()
	state := map[string]any{"m": .4, "lastTs": now.UnixMilli(), "soldTotal": 100, "soldToday": 5, "day": now.Format("2006-01-02")}
	history := map[string]any{"t": now.Add(-time.Hour).UnixMilli(), "p": 40}
	econ := map[string]any{"shopSales": map[string]any{"crucian": state}, "priceOv": map[string]any{"crucian": map[string]any{"base": 50}}, "priceLog": map[string]any{"crucian": []any{history}}, "tradeLog": map[string]any{"crucian": []any{map[string]any{"t": now.UnixMilli(), "who": "Synthetic", "qty": 3, "unit": 40}}}, "marketLog": []any{}, "economyLog": []any{map[string]any{"t": now.UnixMilli(), "who": "Synthetic", "text": "test change"}}}
	write("economy.json", econ)
	tx, err := db.Admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	rc := &RealContext{Tx: tx, Root: root, RunID: "77777777-7777-5777-8777-777777777777", Now: now, IDs: map[string]int64{}}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.migration_runs(id,source_version,snapshot_sha256,tool_version,state) VALUES($1,'test',repeat('0',64),'test','running')`, rc.RunID); err != nil {
		t.Fatal(err)
	}
	if err = PrepareRealCatalog(ctx, rc); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err = tx.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,1234)`, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,admin) VALUES($1,'synthetic','Synthetic','000001','synthetic',true)`, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'crucian','fish','normal',11)`} {
		if _, err := tx.Exec(ctx, q, owner); err != nil {
			t.Fatal(err)
		}
	}
	rc.IDs["synthetic"] = owner
	var sig, part string
	for _, it := range rc.Catalog.Items {
		if it.Kind == "component" && it.Part != "" {
			sig = it.ID + "#common#"
			part = it.Part
			break
		}
	}
	listing := func(lid int, id, src string, q int) map[string]any {
		return map[string]any{"lid": lid, "seller": "synthetic", "id": id, "qty": q, "price": 10, "t": now.UnixMilli(), "expireAt": now.Add(24 * time.Hour).UnixMilli(), "hours": 24, "src": src}
	}
	write("market.json", map[string]any{"listingSeq": 50, "listings": []any{listing(5, "crucian", "player", 3), listing(6, sig, "admin", 2), listing(7, "rodset:"+part+"="+sig, "player", 1)}, "marketSupply": map[string]any{"id": "supply-test", "enabled": false}})
	if err = ImportRealConfig(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ImportRealMarketEconomy(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealConfig(ctx, rc); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealMarketEconomy(ctx, rc); err != nil {
		t.Fatal(err)
	}
	var coins, qty, instances int
	if err = tx.QueryRow(ctx, `SELECT coins,(SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1),(SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='escrow') FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&coins, &qty, &instances); err != nil {
		t.Fatal(err)
	}
	if coins != 1234 || qty != 11 || instances != 3 {
		t.Fatalf("assets changed during historical import: coins=%d available=%d escrow=%d", coins, qty, instances)
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.economy_prices SET state='{}' WHERE item_id='crucian'`); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileRealMarketEconomy(ctx, rc); err == nil {
		t.Fatal("reconciliation accepted altered price state")
	}
	// The fixture remains uncommitted, so failure/cancellation cannot expose
	// partial catalog, escrow or history rows to runtime readers.
}

func TestRealHistoryRejectsMalformedTimestamps(t *testing.T) {
	var v map[string]any
	_ = json.Unmarshal([]byte(`{"priceLog":{"crucian":[{"t":-1,"p":3}]}}`), &v)
	if _, err := realEconomyRows(v); err == nil {
		t.Fatal("invalid history accepted")
	}
}
