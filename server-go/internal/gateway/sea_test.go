package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationHTTPSeaCommandsReplayAndOwnership(t *testing.T) {
	db := testdb.New(t, true)
	ctx := context.Background()
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(ctx, db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	users := make([]identity.LoginResult, 2)
	for i := range users {
		users[i], err = identity.New(db.App, nil).Register(ctx, identity.Registration{Username: fmt.Sprintf("sea_http_%d", i), Password: "Synthetic-sea-Pass42", QQ: "123456"})
		if err != nil {
			t.Fatal(err)
		}
	}
	owner := users[0].Session.AccountID
	if _, err := assets.New(db.App).ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: "seed", Reason: "reward", RuleVersion: "test", Coins: 1000000, Stacks: []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: 3}, {ItemID: "deepscale", Tier: "normal", Quantity: 100}}}); err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil, loc))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	request := func(method, path, body, token string, code int) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if method == "POST" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != code {
			t.Fatal(path, res.StatusCode, value)
		}
		return value
	}
	post := func(path, body, status string) map[string]any {
		t.Helper()
		value := request("POST", path, body, users[0].Token, 200)
		if value["status"] != status {
			t.Fatal(path, value)
		}
		return value
	}
	for _, path := range []string{"/api/v1/sea", "/api/v1/sea/voyage", "/api/v1/sea/anchor", "/api/v1/sea/quests", "/api/v1/sea/quest/claim"} {
		request("POST", path, `{}`, "", 401)
	}
	request("POST", "/api/v1/sea", `{"requestKey":"spoof","action":"chart","actorId":"1"}`, users[0].Token, 400)
	request("POST", "/api/v1/sea", `{"requestKey":"invalid","action":"upgrade","expectedLevel":0}`, users[0].Token, 400)
	chart := post("/api/v1/sea", `{"requestKey":"chart","action":"chart"}`, "crafted")
	replay := post("/api/v1/sea", `{"requestKey":"chart","action":"chart"}`, "crafted")
	if !reflect.DeepEqual(chart, replay) {
		t.Fatal("chart replay changed result")
	}
	request("POST", "/api/v1/sea", `{"requestKey":"chart","action":"upgrade","expectedLevel":1}`, users[0].Token, 409)
	post("/api/v1/sea", `{"requestKey":"no-xp","action":"upgrade","expectedLevel":1}`, "ship_experience_insufficient")
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_players SET experience=560 WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	post("/api/v1/sea", `{"requestKey":"upgrade","action":"upgrade","expectedLevel":1}`, "upgraded")
	zone := post("/api/v1/sea/voyage", `{"requestKey":"voyage"}`, "voyaged")
	if !reflect.DeepEqual(zone, post("/api/v1/sea/voyage", `{"requestKey":"voyage"}`, "voyaged")) {
		t.Fatal("voyage rerolled")
	}
	zoneID := zone["resourceId"].(string)
	anchor := `{"requestKey":"anchor","zoneId":"` + zoneID + `"}`
	denied := request("POST", "/api/v1/sea/anchor", anchor, users[1].Token, 200)
	if denied["status"] != "sea_zone_expired" {
		t.Fatal("non-owner changed zone", denied)
	}
	post("/api/v1/sea/anchor", anchor, "anchored")
	post("/api/v1/sea/quests", `{"requestKey":"quests"}`, "refreshed")
	if _, err := db.Admin.Exec(ctx, `UPDATE fishing.sea_quest_boards SET selected='[{"id":"q_submit_scale","progress":0,"claimed":false}]' WHERE owner_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	claimBody := `{"requestKey":"claim","id":"q_submit_scale"}`
	claim := post("/api/v1/sea/quest/claim", claimBody, "claimed")
	if !reflect.DeepEqual(claim, post("/api/v1/sea/quest/claim", claimBody, "claimed")) {
		t.Fatal("claim replay changed")
	}
	post("/api/v1/sea/quest/claim", `{"requestKey":"claim-again","id":"q_submit_scale"}`, "quest_already_claimed")
	view := request("GET", "/api/v1/sea", "", users[0].Token, 200)
	state := view["state"].(map[string]any)
	if state["charts"] != float64(0) || state["level"] != float64(2) || len(view["zones"].([]any)) != 1 {
		t.Fatal("sea state mismatch", view)
	}
	other := request("GET", fmt.Sprintf("/api/v1/sea?ownerId=%d", owner), "", users[1].Token, 200)
	if len(other["zones"].([]any)) != 0 {
		t.Fatal("owner query leaked zones")
	}
	var pearls int64
	if err := db.Admin.QueryRow(ctx, `SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id='dragonpearl' AND tier='normal'`, owner).Scan(&pearls); err != nil || pearls != 2 {
		t.Fatal("duplicate reward", pearls, err)
	}
	request("POST", "/api/logout", `{}`, users[0].Token, 200)
	request("POST", "/api/v1/sea/quest/claim", claimBody, users[0].Token, 401)
}
