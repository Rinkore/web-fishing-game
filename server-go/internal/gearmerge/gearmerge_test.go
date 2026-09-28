package gearmerge

import (
	"context"
	"testing"

	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// TestMergePipeline publishes the alias-marked catalog, seeds retired-base
// references, converts them and verifies nothing is left. Requires a real
// PostgreSQL via FISHING_GO_TEST_DATABASE_URL (bootstrap database fishing_test).
func TestMergePipeline(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if len(Aliases(c)) != 19 {
		t.Fatalf("expected 19 aliases (4 per part for line/hook/bait/reel, 3 for accessory), got %d", len(Aliases(c)))
	}

	// Admin actor + player, mirroring the asset fixture seeding.
	var admin, player int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&admin); err != nil {
		t.Fatal(err)
	}
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&player); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{admin, player} {
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES ($1)`, id); err != nil {
			t.Fatal(err)
		}
	}

	version, err := Publish(ctx, db.App, admin)
	if err != nil {
		t.Fatal(err)
	}
	if version == "" {
		t.Fatal("empty catalog version")
	}

	// Seed one retired instance per store, plus a canonical codex row to merge into.
	var operation int64
	if err := db.Admin.QueryRow(ctx, `WITH command AS (
		INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES ($1,'gearmerge-seed',decode(repeat('00',32),'hex')) RETURNING actor_id,request_key
	) INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) SELECT actor_id,request_key,'chest_craft','gearmerge-test' FROM command RETURNING id`, admin).Scan(&operation); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation)
		VALUES ($1,'gear_hook_2','hook',jsonb_build_object('signature','gear_hook_2#epic#size+3@g0_none_0,skl+1'),$2)`, player, operation); err != nil {
		t.Fatal(err)
	}
	var instance int64
	if err := db.Admin.QueryRow(ctx, `SELECT id FROM fishing.equipment_instances WHERE owner_id=$1 AND definition_id='gear_hook_2'`, player).Scan(&instance); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.mail_messages(recipient_id,subject) VALUES ($1,'gearmerge') RETURNING id`, player); err != nil {
		t.Fatal(err)
	}
	var mail int64
	if err := db.Admin.QueryRow(ctx, `SELECT id FROM fishing.mail_messages WHERE recipient_id=$1`, player).Scan(&mail); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.mail_attachments(mail_id,item_id,quantity) VALUES ($1,'gear_reel_5#rare#spd+12',$2)`, mail, operation); err != nil {
		t.Fatal(err)
	}
	for _, seed := range []struct {
		item  string
		count int
	}{{"gear_hook_1", 2}, {"gear_hook_2", 3}} {
		if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at) VALUES ($1,$2,$3,now())`, player, seed.item, seed.count); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := Migrate(ctx, db.App, c, true); err != nil {
		t.Fatal(err)
	}
	s, err := Migrate(ctx, db.App, c, false)
	if err != nil {
		t.Fatal(err)
	}
	if s.Instances != 1 || s.Mail != 1 || s.Codex != 1 {
		t.Fatalf("unexpected stats %+v", s)
	}

	var sig string
	var definition string
	if err := db.Admin.QueryRow(ctx, `SELECT definition_id, attributes->>'signature' FROM fishing.equipment_instances WHERE id=$1`, instance).Scan(&definition, &sig); err != nil {
		t.Fatal(err)
	}
	if definition != "gear_hook_1" || sig != "gear_hook_1#epic#size+3@g0_none_0,skl+1" {
		t.Fatalf("instance not rewritten: %s %s", definition, sig)
	}
	var item string
	if err := db.Admin.QueryRow(ctx, `SELECT item_id FROM fishing.mail_attachments WHERE mail_id=$1`, mail).Scan(&item); err != nil {
		t.Fatal(err)
	}
	if item != "gear_reel_1#rare#spd+12" {
		t.Fatalf("mail attachment not rewritten: %s", item)
	}
	var count int
	if err := db.Admin.QueryRow(ctx, `SELECT count FROM fishing.player_codex WHERE owner_id=$1 AND item_id='gear_hook_1'`, player).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 5 {
		t.Fatalf("codex counts not merged: %d", count)
	}
	var aliasRows int
	if err := db.Admin.QueryRow(ctx, `SELECT count(*) FROM fishing.player_codex WHERE item_id='gear_hook_2'`).Scan(&aliasRows); err != nil {
		t.Fatal(err)
	}
	if aliasRows != 0 {
		t.Fatalf("alias codex rows remain: %d", aliasRows)
	}

	left, err := Remaining(ctx, db.App, c)
	if err != nil {
		t.Fatal(err)
	}
	if left.Instances+left.Mail+left.Codex != 0 {
		t.Fatalf("references remain: %+v", left)
	}

	// The resolved catalog must serve the canonical base for retired ids and
	// hide them from the drop pool.
	if it, ok := c.Item("gear_hook_2"); !ok || it.ID != "gear_hook_1" || it.Name != "倒刺钩" {
		t.Fatalf("alias not resolved: %+v %+v", it, ok)
	}
	if inst, _, affixes, ok := c.Instance("gear_hook_2#epic#size+3"); !ok || inst.ID != "gear_hook_1" || len(affixes) != 1 {
		t.Fatalf("instance alias not resolved: %+v %+v %+v", inst, ok, affixes)
	}
}

// TestAutoMigrateIdempotent runs the startup hook twice against the same
// database: the first pass publishes and converts, the second must be a no-op.
func TestAutoMigrateIdempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	db := testdb.New(t, true)
	ctx := context.Background()
	var admin int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&admin); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES ($1,'gearmergeadmin','迁移','10000','x')`, admin); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.identities SET admin=true WHERE account_id=$1`, admin); err != nil {
		t.Fatal(err)
	}
	logs := 0
	if err := AutoMigrate(ctx, db.App, func(string, ...any) { logs++ }); err != nil {
		t.Fatal(err)
	}
	if logs == 0 {
		t.Fatal("first run should publish and convert")
	}
	afterFirst := logs
	if err := AutoMigrate(ctx, db.App, func(string, ...any) { logs++ }); err != nil {
		t.Fatal(err)
	}
	if logs != afterFirst {
		t.Fatalf("second run must be a no-op, got %d extra log lines", logs-afterFirst)
	}
	var releaseID int64
	if err := db.App.QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton`).Scan(&releaseID); err != nil {
		t.Fatal(err)
	}
	if releaseID == 0 {
		t.Fatal("head not published")
	}
}

func TestAutoMigrateDefersOnFreshDatabase(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	db := testdb.New(t, true)
	ctx := context.Background()
	if err := AutoMigrate(ctx, db.App, func(string, ...any) {}); err != nil {
		t.Fatalf("fresh database should start without an admin: %v", err)
	}
	var releaseID int64
	if err := db.App.QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton`).Scan(&releaseID); err != nil {
		t.Fatal(err)
	}
	if releaseID != 0 {
		t.Fatalf("catalog publication must wait for an audited admin actor, got %d", releaseID)
	}
	var admin int64
	if err := db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&admin); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Admin.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,admin) VALUES ($1,'merge_admin','迁移','10000','x',true)`, admin); err != nil {
		t.Fatal(err)
	}
	if err := AutoMigrate(ctx, db.App, func(string, ...any) {}); err != nil {
		t.Fatalf("deferred publication should finish once an admin exists: %v", err)
	}
	if err := db.App.QueryRow(ctx, `SELECT COALESCE(release_id,0) FROM fishing.catalog_head WHERE singleton`).Scan(&releaseID); err != nil {
		t.Fatal(err)
	}
	if releaseID == 0 {
		t.Fatal("deferred catalog was not published")
	}
}
