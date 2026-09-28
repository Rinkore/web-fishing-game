package gateway

import (
	"context"
	"fmt"
	"testing"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

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
