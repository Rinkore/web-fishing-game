package breeding

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

type habitatFixture struct {
	db     testdb.DB
	svc    *Service
	ctx    context.Context
	owner  int64
	serial int
}

func TestIntegrationNaturalSpawnResumesAfterFeatureReopens(t *testing.T) {
	f := newHabitatFixture(t)
	tank := f.create(t, "aquarium")
	f.stock(t, tank, "koi", "normal")
	f.stock(t, tank, "moonkoi", "normal")
	var cycle int64
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT cycle FROM fishing.fish_habitats WHERE id=$1::bigint`, tank).Scan(&cycle); err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("habitat:auto:%d:%s:%d", f.owner, tank, cycle)
	if _, err := f.svc.Apply(f.ctx, f.owner, Command{Action: "habitat_create", HabitatKind: "marine", RequestKey: key}); !errors.Is(err, assets.ErrInvalid) {
		t.Fatalf("manual command occupied natural cycle: %v", err)
	}
	if _, err := f.svc.Spawn(context.Background(), f.owner, tank, cycle); !errors.Is(err, assets.ErrDeferred) {
		t.Fatalf("early spawn did not defer: %v", err)
	}
	cycle = f.due(t, tank)
	var release string
	if _, err := f.db.Admin.Exec(context.Background(), `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,'close-natural-breeding',decode(repeat('00',32),'hex'))`, f.owner); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Admin.QueryRow(context.Background(), `WITH op AS (INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,'close-natural-breeding','feature_publish','test-v1') RETURNING id) INSERT INTO fishing.feature_releases(operation_id,actor_id,schema_version,digest,flags) SELECT id,$1,1,repeat('0',64),'{"character.breeding":false}' FROM op RETURNING id`, f.owner).Scan(&release); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.feature_head SET release_id=$1::bigint WHERE singleton`, release); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Sweep(context.Background()); err != nil {
		t.Fatalf("closed feature sweep: %v", err)
	}
	if _, err := f.svc.Spawn(context.Background(), f.owner, tank, cycle); !errors.Is(err, assets.ErrDeferred) {
		t.Fatalf("closed feature cached rejection: %v", err)
	}
	var commands int
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.command_results WHERE actor_id=$1 AND request_key=$2`, f.owner, key).Scan(&commands); err != nil || commands != 0 {
		t.Fatalf("deferred cycle persisted a terminal result: %d %v", commands, err)
	}
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.feature_head SET release_id=NULL WHERE singleton`); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	r, err := f.svc.Spawn(context.Background(), f.owner, tank, cycle)
	if err != nil || r.Status != "natural_offspring" {
		t.Fatalf("reopened cycle did not replay birth: %#v %v", r, err)
	}
	view, err := f.svc.View(context.Background(), f.owner)
	if err != nil || len(view.Fish) != 3 {
		t.Fatalf("reopened cycle produced duplicate or missing birth: %d %v", len(view.Fish), err)
	}
}

func newHabitatFixture(t *testing.T) *habitatFixture {
	t.Helper()
	db := testdb.New(t, true)
	ctx := context.Background()
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, db.Admin, c); err != nil {
		t.Fatal(err)
	}
	f := &habitatFixture{db: db, svc: New(db.App)}
	if err = db.Admin.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&f.owner); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{`INSERT INTO fishing.player_state(account_id) VALUES($1)`, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,5000)`, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash) VALUES($1,'aquaculture','养殖测试','123456','x')`, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'koi','fish','normal',20),($1,'moonkoi','fish','normal',20),($1,'bass','fish','normal',20),($1,'tuna','fish','normal',20),($1,'koi','fish','giant',3)`} {
		if _, err = db.Admin.Exec(ctx, sql, f.owner); err != nil {
			t.Fatal(err)
		}
	}
	var hash [32]byte
	copy(hash[:], []byte("aquaculture-test-session-hash000"))
	if _, err = db.Admin.Exec(ctx, `INSERT INTO fishing.auth_sessions(token_hash,account_id,admin,expires_at) VALUES($1,$2,false,clock_timestamp()+interval '1 day')`, hash[:], f.owner); err != nil {
		t.Fatal(err)
	}
	f.ctx = assets.WithSession(ctx, f.owner, hash, false)
	return f
}
func (f *habitatFixture) command(t *testing.T, in Command, status string) assets.Result {
	t.Helper()
	f.serial++
	in.RequestKey = fmt.Sprintf("aquaculture-%d", f.serial)
	result, err := f.svc.Apply(f.ctx, f.owner, in)
	if err != nil || result.Status != status {
		t.Fatalf("%s: %#v %v", in.Action, result, err)
	}
	return result
}
func (f *habitatFixture) create(t *testing.T, kind string) string {
	return f.command(t, Command{Action: "habitat_create", HabitatKind: kind}, "habitat_created").ResourceID
}
func (f *habitatFixture) stock(t *testing.T, id, species, tier string) string {
	return f.command(t, Command{Action: "founder", HabitatID: id, Species: species, Tier: tier}, "founder_added").ResourceID
}
func (f *habitatFixture) due(t *testing.T, id string) int64 {
	t.Helper()
	var cycle int64
	if err := f.db.Admin.QueryRow(context.Background(), `UPDATE fishing.fish_habitats SET next_spawn_at=clock_timestamp()-interval '1 second' WHERE id=$1::bigint RETURNING cycle`, id).Scan(&cycle); err != nil {
		t.Fatal(err)
	}
	return cycle
}

func TestIntegrationHabitatsCapacityOwnershipAndNaturalInheritance(t *testing.T) {
	f := newHabitatFixture(t)
	tank := f.create(t, "aquarium")
	fresh := f.create(t, "freshwater")
	marine := f.create(t, "marine")
	f.command(t, Command{Action: "founder", HabitatID: tank, Species: "bass", Tier: "normal"}, "breeding_wrong_habitat")
	f.command(t, Command{Action: "founder", HabitatID: tank, Species: "koi", Tier: "giant"}, "breeding_wrong_habitat")
	f.command(t, Command{Action: "founder", HabitatID: fresh, Species: "tuna", Tier: "normal"}, "breeding_wrong_habitat")
	f.command(t, Command{Action: "founder", HabitatID: marine, Species: "koi", Tier: "normal"}, "breeding_wrong_habitat")
	first := f.stock(t, tank, "koi", "normal")
	f.stock(t, tank, "moonkoi", "normal")
	for i := 0; i < 5; i++ {
		f.stock(t, tank, "koi", "normal")
	}
	view, err := f.svc.View(context.Background(), f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if view.Habitats[0].Capacity != 8 || len(view.Habitats[0].FishIDs) != 7 || view.Habitats[0].CompatiblePairs == 0 {
		t.Fatalf("tank projection: %#v", view.Habitats)
	}
	cycle := f.due(t, tank)
	var wg sync.WaitGroup
	errors := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.svc.Spawn(context.Background(), f.owner, tank, cycle)
			if e != nil || r.Status != "natural_offspring" {
				errors <- fmt.Errorf("%#v %v", r, e)
			}
		}()
	}
	wg.Wait()
	close(errors)
	for e := range errors {
		t.Fatal(e)
	}
	view, err = f.svc.View(context.Background(), f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Fish) != 8 || len(view.Habitats[0].FishIDs) != 8 || view.Habitats[0].Status != "full" {
		t.Fatalf("natural breeding exceeded capacity: %#v", view.Habitats)
	}
	f.command(t, Command{Action: "founder", HabitatID: tank, Species: "koi", Tier: "normal"}, "breeding_habitat_full")
	f.command(t, Command{Action: "stock", ID: first, HabitatID: fresh}, "fish_moved")
	var coins int64
	if err = f.db.Admin.QueryRow(context.Background(), `SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.owner).Scan(&coins); err != nil || coins != 5000 {
		t.Fatalf("natural reproduction charged coins: %d %v", coins, err)
	}
	f.command(t, Command{Action: "stock", ID: first, HabitatID: marine}, "breeding_wrong_habitat")
	f.command(t, Command{Action: "unstock", ID: first}, "fish_moved")
	f.create(t, "aquarium")
	f.command(t, Command{Action: "habitat_create", HabitatKind: "aquarium"}, "breeding_habitat_limit")
	// A habitat id is always owner-bound, even if the fish belongs to the caller.
	var other int64
	if err = f.db.Admin.QueryRow(context.Background(), `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Admin.Exec(context.Background(), `INSERT INTO fishing.player_state(account_id) VALUES($1)`, other); err != nil {
		t.Fatal(err)
	}
	var foreign string
	if err = f.db.Admin.QueryRow(context.Background(), `INSERT INTO fishing.fish_habitats(owner_id,kind,slot,capacity) VALUES($1,'freshwater',1,12) RETURNING id`, other).Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	f.command(t, Command{Action: "stock", ID: first, HabitatID: foreign}, "breeding_habitat_not_found")
}

func TestIntegrationMixedSpeciesStayInertAndMarineFishBreed(t *testing.T) {
	f := newHabitatFixture(t)
	fresh := f.create(t, "freshwater")
	sea := f.create(t, "marine")
	f.stock(t, fresh, "bass", "normal")
	f.stock(t, fresh, "koi", "normal")
	r, err := f.svc.Spawn(context.Background(), f.owner, fresh, f.due(t, fresh))
	if err != nil || r.Status != "no_pair" {
		t.Fatalf("incompatible fish reacted: %#v %v", r, err)
	}
	f.stock(t, sea, "tuna", "normal")
	f.stock(t, sea, "tuna", "normal")
	r, err = f.svc.Spawn(context.Background(), f.owner, sea, f.due(t, sea))
	if err != nil || r.Status != "natural_offspring" {
		t.Fatalf("marine breeding: %#v %v", r, err)
	}
	view, err := f.svc.View(context.Background(), f.owner)
	if err != nil || len(view.Fish) != 5 {
		t.Fatalf("mixed habitat view: %#v %v", view, err)
	}
	if view.Habitats[0].CompatiblePairs != 0 || view.Habitats[0].Status != "no_pair" || len(view.Habitats[1].FishIDs) != 3 {
		t.Fatalf("habitat segregation: %#v", view.Habitats)
	}
}

func TestIntegrationWorkbenchAndAquacultureStaySeparate(t *testing.T) {
	f := newHabitatFixture(t)
	tank := f.create(t, "aquarium")
	a := f.stock(t, tank, "koi", "normal")
	b := f.stock(t, tank, "moonkoi", "normal")
	f.command(t, Command{Action: "breed", ID: a, OtherID: b}, "breeding_parent_in_habitat")
	f.command(t, Command{Action: "unstock", ID: a}, "fish_moved")
	f.command(t, Command{Action: "breed", ID: a, OtherID: b}, "breeding_parent_in_habitat")
	f.command(t, Command{Action: "unstock", ID: b}, "fish_moved")
	manual := f.command(t, Command{Action: "breed", ID: a, OtherID: b}, "offspring_born")
	var member string
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT COALESCE(habitat_id::text,'') FROM fishing.breeding_fish WHERE id=$1::bigint`, manual.ResourceID).Scan(&member); err != nil || member != "" {
		t.Fatalf("manual offspring entered an idle habitat: %q %v", member, err)
	}
	f.command(t, Command{Action: "stock", ID: a, HabitatID: tank}, "fish_moved")
	f.command(t, Command{Action: "stock", ID: b, HabitatID: tank}, "fish_moved")
	if _, err := f.db.Admin.Exec(context.Background(), `UPDATE fishing.inventory_stacks SET quantity=100 WHERE owner_id=$1 AND item_id='koi' AND tier='normal'`, f.owner); err != nil {
		t.Fatal(err)
	}
	// The existing manual child takes one slot; fill its independent workbench.
	for i := 1; i < Capacity; i++ {
		f.command(t, Command{Action: "founder", Species: "koi", Tier: "normal"}, "founder_added")
	}
	f.command(t, Command{Action: "founder", Species: "koi", Tier: "normal"}, "breeding_capacity")
	f.command(t, Command{Action: "unstock", ID: a}, "breeding_capacity")
	// A full workbench must not block direct stocking or natural offspring.
	c := f.stock(t, tank, "koi", "normal")
	natural, err := f.svc.Spawn(context.Background(), f.owner, tank, f.due(t, tank))
	if err != nil || natural.Status != "natural_offspring" {
		t.Fatalf("full workbench blocked idle production: %#v %v", natural, err)
	}
	if err = f.db.Admin.QueryRow(context.Background(), `SELECT COALESCE(habitat_id::text,'') FROM fishing.breeding_fish WHERE id=$1::bigint`, natural.ResourceID).Scan(&member); err != nil || member != tank {
		t.Fatalf("natural offspring escaped its facility: %q %v", member, err)
	}
	view, err := f.svc.View(context.Background(), f.owner)
	if err != nil || view.Capacity != Capacity || view.AquacultureCapacity != 60 || len(view.Fish) != Capacity+4 {
		t.Fatalf("separate capacity projection: %d %#v %v", len(view.Fish), view.Habitats, err)
	}
	f.command(t, Command{Action: "release", ID: manual.ResourceID}, "released")
	// Return and manual founder compete for the last workbench slot.
	var wg sync.WaitGroup
	results := make(chan assets.Result, 2)
	failures := make(chan error, 2)
	for i, command := range []Command{{Action: "unstock", ID: c}, {Action: "founder", Species: "koi", Tier: "normal"}} {
		command.RequestKey = fmt.Sprintf("separate-workbench-race-%d", i)
		wg.Add(1)
		go func(in Command) {
			defer wg.Done()
			r, e := f.svc.Apply(f.ctx, f.owner, in)
			results <- r
			failures <- e
		}(command)
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	success, rejected := 0, 0
	for r := range results {
		if r.Status == "breeding_capacity" {
			rejected++
		} else if r.Status == "fish_moved" || r.Status == "founder_added" {
			success++
		}
	}
	var count int
	if err = f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.breeding_fish WHERE owner_id=$1 AND active AND habitat_id IS NULL`, f.owner).Scan(&count); err != nil || count != Capacity || success != 1 || rejected != 1 {
		t.Fatalf("return/founder race crossed workbench limit: %d success=%d rejected=%d %v", count, success, rejected, err)
	}
}

func TestIntegrationNaturalSpawnRollbackAndStockRace(t *testing.T) {
	f := newHabitatFixture(t)
	tank := f.create(t, "aquarium")
	for i := 0; i < 7; i++ {
		f.stock(t, tank, "koi", "normal")
	}
	cycle := f.due(t, tank)
	if _, err := f.db.Admin.Exec(context.Background(), `CREATE FUNCTION fishing.fail_spawn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.generation>0 THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_spawn BEFORE INSERT ON fishing.breeding_fish FOR EACH ROW EXECUTE FUNCTION fishing.fail_spawn()`); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.Spawn(context.Background(), f.owner, tank, cycle)
	if err == nil {
		t.Fatal("injected database failure succeeded")
	}
	var retained int64
	if err = f.db.Admin.QueryRow(context.Background(), `SELECT cycle FROM fishing.fish_habitats WHERE id=$1::bigint`, tank).Scan(&retained); err != nil || retained != cycle {
		t.Fatalf("failure advanced schedule: %d %v", retained, err)
	}
	if _, err = f.db.Admin.Exec(context.Background(), `DROP TRIGGER fail_spawn ON fishing.breeding_fish; DROP FUNCTION fishing.fail_spawn()`); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		r, e := f.svc.Spawn(context.Background(), f.owner, tank, cycle)
		if e != nil || (r.Status != "natural_offspring" && r.Status != "not_due" && r.Status != "habitat_full") {
			failures <- fmt.Errorf("spawn: %#v %v", r, e)
		}
	}()
	go func() {
		defer wg.Done()
		r, e := f.svc.Apply(f.ctx, f.owner, Command{Action: "founder", RequestKey: "stock-capacity-race", HabitatID: tank, Species: "koi", Tier: "normal"})
		if e != nil || (r.Status != "founder_added" && r.Status != "breeding_habitat_full") {
			failures <- fmt.Errorf("stock: %#v %v", r, e)
		}
	}()
	wg.Wait()
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	var count int
	if err = f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.breeding_fish WHERE habitat_id=$1::bigint AND active`, tank).Scan(&count); err != nil || count != 8 {
		t.Fatalf("stock/spawn race overfilled: %d %v", count, err)
	}
}
