package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

// TestIntegrationLegacyWorkshop covers the original workshop contract: the
// merged smelt config view plus smelt / recast / forge on data.js component
// signatures.
func TestIntegrationLegacyWorkshop(t *testing.T) {
	db := testdb.New(t, true)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(context.Background(), db.Admin, c); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()

	do := func(method, path, body, token string) (int, map[string]any) {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if method == "POST" {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(res.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, value
	}
	code, reg := do("POST", "/api/register", `{"username":"legacy_ws","password":"Synthetic-Pass42","qq":"123456","name":"Workshop"}`, "")
	if code != 200 {
		t.Fatalf("register: %d %v", code, reg)
	}
	token := reg["token"].(string)
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: session.AccountID, RequestKey: "fund", Reason: "reward", RuleVersion: "test-v1",
		Coins: 1000000, Stacks: []assets.StackDelta{
			{ItemID: "dragonpearl", Tier: "normal", Quantity: 6},
			{ItemID: "relic", Tier: "normal", Quantity: 10},
			{ItemID: "rope", Tier: "normal", Quantity: 5},
		},
	}); err != nil {
		t.Fatal(err)
	}
	gear := func(key, signature string) {
		t.Helper()
		base, _, _, ok := c.Instance(signature)
		if !ok {
			t.Fatalf("bad fixture signature %s", signature)
		}
		attrs, _ := json.Marshal(map[string]any{"signature": signature})
		if _, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
			ActorID: session.AccountID, RequestKey: key, Reason: "reward", RuleVersion: "test-v1",
			Create: []assets.EquipmentSpec{{DefinitionID: base.ID, Part: base.Part, Attributes: attrs}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	inventory := func() map[string]any {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["inventory"].(map[string]any)
	}
	coins := func() float64 {
		t.Helper()
		code, body := do("GET", "/api/me", "", token)
		if code != 200 {
			t.Fatalf("me: %d %v", code, body)
		}
		return body["coins"].(float64)
	}

	// Configuration view.
	code, view := do("GET", "/api/workshop", "", token)
	if code != 200 {
		t.Fatalf("workshop view: %d %v", code, view)
	}
	cfg := view["cfg"].(map[string]any)
	if cfg["baseRate"] != float64(50) || cfg["goldBase"] != float64(5000) || cfg["retainMaxRelic"] != float64(10) {
		t.Fatalf("workshop cfg: %v", cfg)
	}
	materials := view["materials"].([]any)
	if len(materials) != 6 {
		t.Fatalf("workshop materials: %v", materials)
	}
	order := []string{}
	for _, entry := range materials {
		order = append(order, entry.(map[string]any)["id"].(string))
	}
	if strings.Join(order, ",") != "lure,bait_pack,rope,relic,tide_sand,dragon_scale" {
		t.Fatalf("material order: %v", order)
	}
	if first := materials[0].(map[string]any); first["affix"] != "skill" || first["affixName"] != "技巧" || first["name"] != "反光假饵" {
		t.Fatalf("material entry: %v", first)
	}
	if pearl := view["pearl"].(map[string]any); pearl["id"] != "dragonpearl" || pearl["name"] != "龙宫宝珠" {
		t.Fatalf("pearl entry: %v", pearl)
	}
	recast := view["recast"].(map[string]any)
	if recast["quality"] != "mythic" || recast["qualityName"] != "神话" || recast["pearlBase"] != float64(1) || recast["pearlHave"] != float64(6) {
		t.Fatalf("recast info: %v", recast)
	}
	retain := view["retain"].(map[string]any)
	if retain["relicId"] != "relic" || retain["max"] != float64(10) || retain["per"] != float64(10) || retain["protectAffix"] != true || retain["relicHave"] != float64(10) {
		t.Fatalf("retain info: %v", retain)
	}
	labels := view["affixLabel"].(map[string]any)
	if labels["speed"] != "钓速" || labels["double"] != "双钓概率" {
		t.Fatalf("affix labels: %v", labels)
	}

	// Recast: base cost re-rolls every affix, an index adds one pearl per slot.
	mythic := "rod_bamboo#mythic#skl+20,size+30"
	gear("mythic", mythic)
	code, recastResult := do("POST", "/api/workshop/recast", `{"id":"`+mythic+`"}`, token)
	if code != 200 {
		t.Fatalf("recast: %d %v", code, recastResult)
	}
	if recastResult["ok"] != true || recastResult["target"] != float64(-1) || recastResult["pearlNeed"] != float64(1) {
		t.Fatalf("recast result: %v", recastResult)
	}
	item := recastResult["item"].(map[string]any)
	if item["quality"] != "mythic" || len(item["affixes"].([]any)) != 2 {
		t.Fatalf("recast item: %v", item)
	}
	before := recastResult["before"].([]any)
	if len(before) != 2 || before[0].(map[string]any)["type"] != "skill" {
		t.Fatalf("recast before: %v", before)
	}
	if inventory()["dragonpearl"] != float64(5) {
		t.Fatalf("pearls after recast: %v", inventory()["dragonpearl"])
	}
	// A targeted recast keeps the other affix's value and costs one more pearl.
	newID := recastResult["id"].(string)
	firstValue := item["affixes"].([]any)[0].(map[string]any)["value"]
	code, targeted := do("POST", "/api/workshop/recast", `{"id":"`+newID+`","affixIndex":1}`, token)
	if code != 200 {
		t.Fatalf("targeted recast: %d %v", code, targeted)
	}
	if targeted["target"] != float64(1) || targeted["pearlExtra"] != float64(2) || targeted["pearlNeed"] != float64(3) {
		t.Fatalf("targeted recast costs: %v", targeted)
	}
	kept := targeted["item"].(map[string]any)["affixes"].([]any)[0].(map[string]any)["value"]
	if kept != firstValue {
		t.Fatalf("untargeted affix changed: %v -> %v", firstValue, kept)
	}
	if code, body := do("POST", "/api/workshop/recast", `{"id":"`+newID+`","affixIndex":9}`, token); code != 400 || !strings.Contains(body["error"].(string), "指定的词条不存在") {
		t.Fatalf("bad recast index: %d %v", code, body)
	}
	if code, body := do("POST", "/api/workshop/recast", `{"id":"rod_bamboo#common#spd+5"}`, token); code != 400 || body["error"] != "背包中没有该组件（可能已锁定在钓竿上）" {
		t.Fatalf("recast missing component: %d %v", code, body)
	}

	// Forge: add a catalyst affix to a component that still has room.
	plain := "rod_bamboo#common#"
	gear("plain", plain)
	code, forged := do("POST", "/api/workshop/forge", `{"id":"`+plain+`","materialId":"rope"}`, token)
	if code != 200 {
		t.Fatalf("forge: %d %v", code, forged)
	}
	forgedItem := forged["item"].(map[string]any)
	forgedAffixes := forgedItem["affixes"].([]any)
	if forged["changed"] != true || len(forgedAffixes) != 1 || forgedAffixes[0].(map[string]any)["type"] != "size" {
		t.Fatalf("forge item: %v", forgedItem)
	}
	affix := forged["affix"].(map[string]any)
	if affix["type"] != "size" || affix["name"] != "体型" || affix["src"] != "ct" || affix["min"] == nil || affix["max"] == nil {
		t.Fatalf("forge affix: %v", affix)
	}
	if material := forged["material"].(map[string]any); material["id"] != "rope" || material["have"] != float64(4) {
		t.Fatalf("forge material: %v", material)
	}
	if inventory()[forged["id"].(string)] != float64(1) {
		t.Fatalf("forged component missing: %v", inventory())
	}
	// A saturated component reports the cap; a duplicate catalyst type on a
	// component with room reports the duplicate.
	if code, body := do("POST", "/api/workshop/forge", `{"id":"`+forged["id"].(string)+`","materialId":"rope"}`, token); code != 400 || body["error"] != "该组件词条已达上限" {
		t.Fatalf("forge above capacity: %d %v", code, body)
	}
	duplicate := "rod_bamboo#epic#size+5"
	gear("dup", duplicate)
	if code, body := do("POST", "/api/workshop/forge", `{"id":"`+duplicate+`","materialId":"rope"}`, token); code != 400 || body["error"] != "该组件已经拥有这条词条" {
		t.Fatalf("duplicate forge affix: %d %v", code, body)
	}
	if code, body := do("POST", "/api/workshop/forge", `{"id":"`+plain+`","materialId":"chest_wreck"}`, token); code != 400 || body["error"] != "请选择一种催化剂材料" {
		t.Fatalf("bad forge material: %d %v", code, body)
	}

	// Smelt: main affinity plus one catalyst type, with the plan echo.
	mainSig := "rod_bamboo#common#spd+5"
	subSig := "rod_bamboo#epic#skl+7,mat+3"
	gear("smelt-main", mainSig)
	gear("smelt-sub", subSig)
	startCoins := coins()
	payload := `{"mainId":"` + mainSig + `","subId":"` + subSig + `","mainAffix":"speed","subAffix":"skill","materials":[{"id":"rope","qty":2}],"pearl":false,"relics":0}`
	code, smelted := do("POST", "/api/workshop/smelt", payload, token)
	if code != 200 {
		t.Fatalf("smelt: %d %v", code, smelted)
	}
	if smelted["rate"] != float64(46) || smelted["extraRate"] != float64(16) || smelted["gold"] != float64(6800) || smelted["extraType"] != "size" {
		t.Fatalf("smelt plan echo: %v", smelted)
	}
	if smelted["mainId"] != mainSig || smelted["subId"] != subSig || smelted["retainChance"] != float64(0) {
		t.Fatalf("smelt identity: %v", smelted)
	}
	if got := coins(); got != startCoins-6800 {
		t.Fatalf("coins after smelt: %v", got)
	}
	if smelted["success"] == true {
		if smelted["result"] == nil || smelted["mainAfter"] != nil {
			t.Fatalf("smelt success payload: %v", smelted)
		}
		produced := smelted["result"].(map[string]any)
		types := map[string]bool{}
		for _, entry := range produced["affixes"].([]any) {
			types[entry.(map[string]any)["type"].(string)] = true
		}
		if !types["speed"] || !types["skill"] {
			t.Fatalf("smelt affixes: %v", types)
		}
		if types["size"] != (smelted["extraOk"] == true) {
			t.Fatalf("smelt catalyst roll: %v / %v", types, smelted["extraOk"])
		}
	} else {
		if smelted["mainAfter"] == nil || smelted["result"] != nil || smelted["protectAffix"] != false || smelted["removedAffix"] != "speed" {
			t.Fatalf("smelt failure payload: %v", smelted)
		}
	}
	after := inventory()
	if after[subSig] != nil {
		t.Fatalf("sub component survived: %v", after[subSig])
	}
	if after["rope"] != float64(2) {
		t.Fatalf("catalyst materials: %v", after["rope"])
	}
	if code, body := do("POST", "/api/workshop/smelt", `{"mainId":"`+mainSig+`","subId":"`+mainSig+`","mainAffix":"speed","subAffix":"speed","materials":[],"pearl":false,"relics":0}`, token); code != 400 {
		t.Fatalf("same main and sub: %d %v", code, body)
	}
}
