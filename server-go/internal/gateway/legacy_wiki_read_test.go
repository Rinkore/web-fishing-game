package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/testdb"
)

func TestIntegrationLegacyWikiRead(t *testing.T) {
	db := testdb.New(t, true)
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err := workshop.SeedDefinitions(context.Background(), db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(New(db.App, nil))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second

	call := func(path, token string, headers map[string]string) *http.Response {
		t.Helper()
		request, err := http.NewRequest("GET", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		res, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	decode := func(res *http.Response, out any) {
		t.Helper()
		defer res.Body.Close()
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatalf("decode body: %v", err)
		}
	}
	post := func(path, body string) map[string]any {
		t.Helper()
		request, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		res, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if res.StatusCode != 200 {
			t.Fatalf("%s: %d %v", path, res.StatusCode, out)
		}
		return out
	}

	registered := post("/api/register",
		`{"username":"legacy_wiki","password":"Synthetic-Pass42","qq":"654321","name":"Wiki"}`)
	token, _ := registered["token"].(string)
	if token == "" {
		t.Fatalf("registration failed: %v", registered)
	}
	session, err := identity.New(db.App, nil).Authenticate(context.Background(), token, false)
	if err != nil {
		t.Fatal(err)
	}
	seeded, err := assets.New(db.App).ApplyChange(context.Background(), assets.Change{
		ActorID: session.AccountID, RequestKey: "wiki-seed", Reason: "reward", RuleVersion: "test-v1",
		Stacks: []assets.StackDelta{
			{ItemID: "crucian", Tier: "normal", Quantity: 3},
			{ItemID: "crucian", Tier: "large", Quantity: 2},
			{ItemID: "bait_pack", Tier: "normal", Quantity: 5},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if seeded.Status != "applied" {
		t.Fatalf("seeding was rejected: %+v", seeded)
	}

	// ---- public content: ETag, 304 and the metadata-only guide list ----
	res := call("/api/wiki/content", "", nil)
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("content status: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("content is missing an ETag")
	}
	var content struct {
		Revision         string           `json:"revision"`
		OfficialRevision int64            `json:"officialRevision"`
		UserRevision     int64            `json:"userRevision"`
		UpdatedAt        string           `json:"updatedAt"`
		Guides           []map[string]any `json:"guides"`
		Updates          []map[string]any `json:"updates"`
	}
	decode(res, &content)
	if len(content.Guides) == 0 || len(content.Updates) == 0 {
		t.Fatalf("content payload: %+v", content)
	}
	if content.OfficialRevision < 1 || content.UserRevision != 0 ||
		content.Revision != "official:"+strconv.FormatInt(content.OfficialRevision, 10)+":user:0" {
		t.Fatalf("revision fields: %+v", content)
	}
	if content.UpdatedAt == "" {
		t.Fatal("content timestamp is empty")
	}
	for _, guide := range content.Guides {
		if _, leak := guide["sections"]; leak {
			t.Fatalf("content list leaked sections: %v", guide)
		}
		if guide["kind"] != "official" || guide["status"] != "published" {
			t.Fatalf("official metadata: %v", guide)
		}
	}

	res = call("/api/wiki/content", "", map[string]string{"If-None-Match": "W/" + etag})
	if res.StatusCode != 304 || res.Header.Get("ETag") != etag || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("revalidation: %d %v", res.StatusCode, res.Header)
	}
	_ = res.Body.Close()

	res = call("/api/wiki/content", "", map[string]string{"If-None-Match": `"stale-validator"`})
	if res.StatusCode != 200 {
		t.Fatalf("stale validator should be re-sent: %d", res.StatusCode)
	}
	_ = res.Body.Close()

	// ---- public guide list: defaults, clamping, filters and paging ----
	res = call("/api/wiki/guides", "", nil)
	var list struct {
		OK       bool             `json:"ok"`
		Page     int              `json:"page"`
		PageSize int              `json:"pageSize"`
		Total    int              `json:"total"`
		Guides   []map[string]any `json:"guides"`
	}
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("guide list status: %d", res.StatusCode)
	}
	decode(res, &list)
	if !list.OK || list.Page != 1 || list.PageSize != 20 || list.Total != len(content.Guides) {
		t.Fatalf("guide list header: %+v", list)
	}
	if len(list.Guides) != len(content.Guides) {
		t.Fatalf("guide list length: %d", len(list.Guides))
	}
	for _, guide := range list.Guides {
		if _, leak := guide["sections"]; leak {
			t.Fatalf("guide list leaked sections: %v", guide)
		}
	}

	res = call("/api/wiki/guides?pageSize=0&page=abc", "", nil)
	decode(res, &list)
	if list.Page != 1 || list.PageSize != 20 {
		t.Fatalf("malformed paging: %+v", list)
	}
	res = call("/api/wiki/guides?pageSize=999", "", nil)
	decode(res, &list)
	if list.PageSize != 50 {
		t.Fatalf("pageSize clamp: %d", list.PageSize)
	}
	res = call("/api/wiki/guides?kind=user", "", nil)
	decode(res, &list)
	if list.Total != 0 || len(list.Guides) != 0 {
		t.Fatalf("user guides should stay empty: %+v", list)
	}
	res = call("/api/wiki/guides?kind=unsupported", "", nil)
	decode(res, &list)
	if list.Total != len(content.Guides) {
		t.Fatalf("unknown kind should not filter: %+v", list)
	}

	firstID, _ := content.Guides[0]["id"].(string)
	firstTitle, _ := content.Guides[0]["title"].(string)
	firstCategory, _ := content.Guides[0]["category"].(string)
	if firstID == "" || firstTitle == "" || firstCategory == "" {
		t.Fatalf("first guide metadata: %v", content.Guides[0])
	}
	res = call("/api/wiki/guides?q="+url.QueryEscape(firstTitle), "", nil)
	decode(res, &list)
	if list.Total < 1 || list.Total != len(list.Guides) {
		t.Fatalf("title search: %+v", list)
	}
	found := false
	for _, guide := range list.Guides {
		if guide["id"] == firstID {
			found = true
		}
	}
	if !found {
		t.Fatalf("title search lost %s: %v", firstID, list.Guides)
	}
	res = call("/api/wiki/guides?category="+url.QueryEscape(firstCategory), "", nil)
	decode(res, &list)
	if list.Total < 1 {
		t.Fatalf("category search: %+v", list)
	}
	for _, guide := range list.Guides {
		if guide["category"] != firstCategory {
			t.Fatalf("category filter leaked %v", guide)
		}
	}
	res = call("/api/wiki/guides?pageSize=1&page=1", "", nil)
	var firstPage struct {
		Total  int              `json:"total"`
		Guides []map[string]any `json:"guides"`
	}
	decode(res, &firstPage)
	res = call("/api/wiki/guides?pageSize=1&page=2", "", nil)
	var secondPage struct {
		Total  int              `json:"total"`
		Guides []map[string]any `json:"guides"`
	}
	decode(res, &secondPage)
	if len(firstPage.Guides) != 1 || len(secondPage.Guides) != 1 {
		t.Fatalf("paging: %+v %+v", firstPage, secondPage)
	}
	if firstPage.Guides[0]["id"] == secondPage.Guides[0]["id"] {
		t.Fatalf("pages repeat %v", firstPage.Guides[0]["id"])
	}

	// ---- guide detail, including the body that the list omits ----
	res = call("/api/wiki/guides/"+firstID, "", nil)
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("detail status: %d", res.StatusCode)
	}
	var detail struct {
		OK    bool           `json:"ok"`
		Guide map[string]any `json:"guide"`
	}
	decode(res, &detail)
	if !detail.OK || detail.Guide["id"] != firstID {
		t.Fatalf("detail payload: %+v", detail)
	}
	sections, ok := detail.Guide["sections"].([]any)
	if !ok || len(sections) == 0 {
		t.Fatalf("detail sections: %v", detail.Guide["sections"])
	}
	for _, raw := range sections {
		section, ok := raw.(map[string]any)
		if !ok || section["h"] == "" || section["type"] == nil {
			t.Fatalf("section shape: %v", raw)
		}
	}
	for _, id := range []string{"no-such-guide", "-leading-dash", strings.Repeat("x", 81)} {
		res = call("/api/wiki/guides/"+id, "", nil)
		var missing map[string]any
		decode(res, &missing)
		if res.StatusCode != 404 || missing["error"] != "攻略不存在或未公开" {
			t.Fatalf("unknown id %q: %d %v", id, res.StatusCode, missing)
		}
	}

	// ---- session probe: anonymous is a normal answer, a token is true ----
	res = call("/api/wiki/guides/session", "", nil)
	var probe map[string]any
	decode(res, &probe)
	if res.StatusCode != 200 || probe["ok"] != true || probe["authenticated"] != false {
		t.Fatalf("anonymous session: %d %v", res.StatusCode, probe)
	}
	res = call("/api/wiki/guides/session", token, nil)
	decode(res, &probe)
	if res.StatusCode != 200 || probe["authenticated"] != true {
		t.Fatalf("authenticated session: %d %v", res.StatusCode, probe)
	}
	res = call("/api/wiki/guides/session", "not-a-real-token", nil)
	decode(res, &probe)
	if res.StatusCode != 200 || probe["authenticated"] != false {
		t.Fatalf("invalid token session: %d %v", res.StatusCode, probe)
	}

	// ---- simulator inventory: private, read-only projection ----
	res = call("/api/wiki/simulator/inventory", "", nil)
	if res.StatusCode != 401 {
		t.Fatalf("anonymous simulator read: %d", res.StatusCode)
	}
	_ = res.Body.Close()

	res = call("/api/wiki/simulator/inventory", token, nil)
	if res.StatusCode != 200 {
		t.Fatalf("simulator status: %d", res.StatusCode)
	}
	if got := res.Header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("simulator cache control: %q", got)
	}
	if got := res.Header.Get("Vary"); !strings.Contains(got, "Cookie") || !strings.Contains(got, "Authorization") {
		t.Fatalf("simulator vary: %q", got)
	}
	var snapshot struct {
		SchemaVersion int              `json:"schemaVersion"`
		ReadOnly      bool             `json:"readOnly"`
		FetchedAt     string           `json:"fetchedAt"`
		Name          string           `json:"name"`
		Coins         int64            `json:"coins"`
		InvRev        string           `json:"invRev"`
		Inventory     map[string]int64 `json:"inventory"`
		BD            map[string]any   `json:"bd"`
		RodSlots      []any            `json:"rodSlots"`
		RodLocked     map[string]int64 `json:"rodLocked"`
	}
	decode(res, &snapshot)
	if snapshot.SchemaVersion != 1 || !snapshot.ReadOnly {
		t.Fatalf("simulator metadata: %+v", snapshot)
	}
	if snapshot.Name != "Wiki" || snapshot.Coins != 500 || snapshot.InvRev == "" {
		t.Fatalf("simulator identity: %+v", snapshot)
	}
	if snapshot.Inventory["crucian"] != 5 || snapshot.Inventory["bait_pack"] != 5 {
		t.Fatalf("simulator inventory: %v", snapshot.Inventory)
	}
	if snapshot.BD == nil || snapshot.RodSlots == nil || snapshot.RodLocked == nil {
		t.Fatalf("simulator rod views: %+v", snapshot)
	}
	if len(snapshot.RodSlots) != 8 {
		t.Fatalf("simulator rod slot count: %d", len(snapshot.RodSlots))
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", snapshot.FetchedAt); err != nil {
		t.Fatalf("fetchedAt %q: %v", snapshot.FetchedAt, err)
	}
}
