package breeding

import (
	"context"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationFounderBreedIdempotencyAndRelease(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	var owner int64
	if err = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO fishing.player_state(account_id) VALUES($1)`,
		`INSERT INTO fishing.wallets(account_id,coins) VALUES($1,1000)`,
		`INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,'breed_player','繁育玩家','123456','x')`,
		`INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES ($1,'koi','fish','normal',2),($1,'bass','fish','normal',1)`,
	} {
		if _, err = db.Admin.Exec(ctx, statement, owner); err != nil {
			t.Fatal(err)
		}
	}
	var hash [32]byte
	copy(hash[:], []byte("breed-session-token-hash-00000000"))
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at) VALUES($1,$2,false,clock_timestamp()+interval '1 day')`, hash[:], owner); err != nil {
		t.Fatal(err)
	}
	session := assets.WithSession(ctx, owner, hash, false)
	service := New(db.App)

	a, err := service.Apply(session, owner, Command{Action: "founder", RequestKey: "breed-founder-a", Species: "koi", Tier: "normal"})
	if err != nil || a.Status != "founder_added" {
		t.Fatalf("first founder: %#v %v", a, err)
	}
	b, err := service.Apply(session, owner, Command{Action: "founder", RequestKey: "breed-founder-b", Species: "koi", Tier: "normal"})
	if err != nil || b.Status != "founder_added" {
		t.Fatalf("second founder: %#v %v", b, err)
	}
	childCommand := Command{Action: "breed", RequestKey: "breed-child-one", ID: a.ResourceID, OtherID: b.ResourceID}
	child, err := service.Apply(session, owner, childCommand)
	if err != nil || child.Status != "offspring_born" {
		t.Fatalf("breed: %#v %v", child, err)
	}
	replayed, err := service.Apply(session, owner, childCommand)
	if err != nil || replayed.ResourceID != child.ResourceID {
		t.Fatalf("idempotent replay changed offspring: %#v %#v %v", child, replayed, err)
	}
	view, err := service.View(ctx, owner)
	if err != nil || len(view.Fish) != 3 || !view.Fish[0].Phenotype.ReferenceExact {
		t.Fatalf("view after breed: %#v %v", view, err)
	}
	var coins int64
	if err = db.Admin.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, owner).Scan(&coins); err != nil || coins != 900 {
		t.Fatalf("breed charged %d coins, want 100: %v", 1000-coins, err)
	}
	if result, releaseErr := service.Apply(session, owner, Command{Action: "release", RequestKey: "breed-release-one", ID: child.ResourceID}); releaseErr != nil || result.Status != "released" {
		t.Fatalf("release: %#v %v", result, releaseErr)
	}
	view, err = service.View(ctx, owner)
	if err != nil || len(view.Fish) != 3 || view.Fish[2].Active {
		t.Fatalf("release should retain inactive ancestry: %#v %v", view, err)
	}
}
