package gateway

import (
	"context"
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/breeding"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

func TestIntegrationAquacultureHTTP(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, f.db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,'koi','fish','normal',1),($1,'moonkoi','fish','normal',1)`, f.playerID); err != nil {
		t.Fatal(err)
	}
	var tank, sea string
	for _, kind := range []string{"aquarium", "freshwater", "marine"} {
		code, response := f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"habitat_create","habitatKind":%q,"requestKey":%q}`, kind, "create-http-"+kind))
		if code != 200 || response["result"].(map[string]any)["status"] != "habitat_created" {
			t.Fatalf("create %s: %d %v", kind, code, response)
		}
		id := response["result"].(map[string]any)["resourceId"].(string)
		if kind == "aquarium" {
			tank = id
		} else if kind == "marine" {
			sea = id
		}
	}
	for _, species := range []string{"koi", "moonkoi"} {
		code, response := f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"founder","requestKey":%q,"species":%q,"tier":"normal","habitatId":%q}`, "stock-http-"+species, species, tank))
		if code != 200 {
			t.Fatalf("stock %s: %d %v", species, code, response)
		}
		id := response["result"].(map[string]any)["resourceId"].(string)
		code, response = f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"stock","requestKey":%q,"id":%q,"habitatId":%q}`, "wrong-water-"+species, id, sea))
		if code != 409 || response["error"] != "breeding_wrong_habitat" {
			t.Fatalf("wrong water accepted: %d %v", code, response)
		}
	}
	code, response := f.player("GET", "/api/house/breeding", "")
	if code != 200 {
		t.Fatalf("read idle parents: %d %v", code, response)
	}
	parents := response["breeding"].(map[string]any)["fish"].([]any)
	code, response = f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"breed","requestKey":"forbidden-idle-manual-breed","id":%q,"otherId":%q}`, parents[0].(map[string]any)["id"], parents[1].(map[string]any)["id"]))
	if code != 409 || response["error"] != "breeding_parent_in_habitat" {
		t.Fatalf("idle fish entered manual workflow: %d %v", code, response)
	}
	var cycle int64
	if err = f.db.Admin.QueryRow(ctx, `UPDATE fishing.fish_habitats SET next_spawn_at=clock_timestamp()-interval '1 second' WHERE id=$1::bigint RETURNING cycle`, tank).Scan(&cycle); err != nil {
		t.Fatal(err)
	}
	if r, err := breeding.New(f.db.App).Spawn(ctx, f.playerID, tank, cycle); err != nil || r.Status != "natural_offspring" {
		t.Fatalf("worker birth: %#v %v", r, err)
	}
	code, response = f.player("GET", "/api/house/breeding", "")
	if code != 200 {
		t.Fatalf("habitat projection: %d %v", code, response)
	}
	view := response["breeding"].(map[string]any)
	habitats := view["habitats"].([]any)
	if len(habitats) != 3 || len(habitats[0].(map[string]any)["fishIds"].([]any)) != 3 {
		t.Fatalf("worker offspring missing from habitat: %v", habitats)
	}
	fish := view["fish"].([]any)
	child := fish[2].(map[string]any)
	phenotype := child["phenotype"].(map[string]any)
	ornaments := phenotype["ornaments"].(map[string]any)
	if child["habitatId"] != tank || ornaments["goldscale"] != true || ornaments["moonlight"] != false {
		t.Fatalf("gold/moon inheritance missing from HTTP view: %v", child)
	}
	code, response = f.player("POST", "/api/house/breeding", `{"action":"habitat_create","habitatKind":"aquarium","requestKey":"habitat:auto:1:1:0"}`)
	if code != 400 || response["error"] != "invalid_request_key" {
		t.Fatalf("player used a reserved worker key: %d %v", code, response)
	}
}

func TestIntegrationBreedingHTTP(t *testing.T) {
	f := newAdminFixture(t)
	ctx := context.Background()
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(ctx, f.db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Admin.Exec(ctx, `UPDATE fishing.wallets SET coins=1000 WHERE account_id=$1`, f.playerID); err != nil {
		t.Fatal(err)
	}
	for _, fish := range []struct {
		id  string
		qty int
	}{{"koi", 2}, {"bass", 1}} {
		if _, err = f.db.Admin.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,'fish','normal',$3)`, f.playerID, fish.id, fish.qty); err != nil {
			t.Fatal(err)
		}
	}

	code, response := f.player("GET", "/api/house/breeding", "")
	if code != 200 || response["breeding"] == nil {
		t.Fatalf("initial breeding view: %d %v", code, response)
	}
	addFounder := func(species, key string) string {
		t.Helper()
		code, response := f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"founder","requestKey":%q,"species":%q,"tier":"normal"}`, key, species))
		if code != 200 {
			t.Fatalf("add %s founder: %d %v", species, code, response)
		}
		result := response["result"].(map[string]any)
		if result["status"] != "founder_added" {
			t.Fatalf("unexpected founder result: %v", result)
		}
		return result["resourceId"].(string)
	}
	a := addFounder("koi", "breed-http-founder-a")
	b := addFounder("koi", "breed-http-founder-b")
	bass := addFounder("bass", "breed-http-founder-c")
	code, response = f.player("GET", "/api/house/breeding", "")
	if code != 200 {
		t.Fatalf("read breeding view: %d %v", code, response)
	}
	view := response["breeding"].(map[string]any)
	individuals := view["fish"].([]any)
	if len(individuals) != 3 {
		t.Fatalf("expected three founders, got %d", len(individuals))
	}
	first := individuals[0].(map[string]any)
	phenotype := first["phenotype"].(map[string]any)
	if phenotype["referenceExact"] != true || phenotype["body"] != "koi" {
		t.Fatalf("founder reference drifted: %v", phenotype)
	}

	breedBody := fmt.Sprintf(`{"action":"breed","requestKey":"breed-http-child-one","id":%q,"otherId":%q}`, a, b)
	code, response = f.player("POST", "/api/house/breeding", breedBody)
	if code != 200 {
		t.Fatalf("breed compatible pair: %d %v", code, response)
	}
	child := response["result"].(map[string]any)["resourceId"].(string)
	code, replay := f.player("POST", "/api/house/breeding", breedBody)
	if code != 200 || replay["result"].(map[string]any)["resourceId"] != child {
		t.Fatalf("idempotent replay changed the child: %d %v", code, replay)
	}
	code, response = f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"breed","requestKey":"breed-http-invalid-pair","id":%q,"otherId":%q}`, a, bass))
	if code != 409 || response["error"] != "breeding_incompatible" {
		t.Fatalf("unlisted cross-species pair was accepted: %d %v", code, response)
	}
	var coins int64
	if err = f.db.Admin.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, f.playerID).Scan(&coins); err != nil || coins != 900 {
		t.Fatalf("breeding should charge exactly once: coins=%d err=%v", coins, err)
	}
	code, response = f.player("POST", "/api/house/breeding", fmt.Sprintf(`{"action":"release","requestKey":"breed-http-release-one","id":%q}`, child))
	if code != 200 || response["result"].(map[string]any)["status"] != "released" {
		t.Fatalf("release offspring: %d %v", code, response)
	}
	archived := response["breeding"].(map[string]any)["fish"].([]any)
	if len(archived) != 4 || archived[3].(map[string]any)["active"] != false {
		t.Fatalf("release removed ancestry: %v", archived)
	}
}
