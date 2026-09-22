package wiki

import (
	"reflect"
	"strings"
	"testing"
)

const testGuide = `{"id":"guide-one","kind":"official","status":"published","title":"标题","category":"分类",` +
	`"aliases":["别名"],"tags":["标签"],"updatedAt":"2026-09-20","summary":"摘要",` +
	`"sections":[{"h":"小节","type":"p","text":"正文"}]}`

func snapshot(guides, updates string) string {
	return `{"format":1,"source":"frontend/wiki/content/content.json","sourceSHA256":"` +
		strings.Repeat("a", 64) + `","guides":` + guides + `,"updates":` + updates + `}`
}

func decode(t *testing.T, data string) *Bundle {
	t.Helper()
	bundle, err := Decode([]byte(data))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return bundle
}

func TestDefaultSnapshotLoads(t *testing.T) {
	bundle, err := Default()
	if err != nil {
		t.Fatalf("embedded snapshot: %v", err)
	}
	if bundle.Format != 1 || bundle.Source != "frontend/wiki/content/content.json" {
		t.Fatalf("metadata: %+v", bundle)
	}
	if len(bundle.SourceSHA256) != 64 {
		t.Fatalf("source digest: %q", bundle.SourceSHA256)
	}
	guides := bundle.Guides()
	if len(guides) == 0 {
		t.Fatal("snapshot has no guides")
	}
	seen := map[string]bool{}
	for _, guide := range guides {
		if guide.Kind != "official" || guide.Status != "published" {
			t.Fatalf("guide %s is not a published official entry", guide.ID)
		}
		if seen[guide.ID] {
			t.Fatalf("duplicate guide id %s", guide.ID)
		}
		seen[guide.ID] = true
		if len(guide.Sections) == 0 || guide.UpdatedAt == "" {
			t.Fatalf("guide %s is incomplete", guide.ID)
		}
		if _, found := bundle.Guide(guide.ID); !found {
			t.Fatalf("guide %s is not indexed", guide.ID)
		}
	}
	if _, found := bundle.Guide("no-such-guide"); found {
		t.Fatal("unknown id resolved")
	}
	if bundle.Revision() < 1 || bundle.UpdatedAt() == "" {
		t.Fatalf("revision %d updatedAt %q", bundle.Revision(), bundle.UpdatedAt())
	}
	if len(bundle.Updates()) == 0 {
		t.Fatal("snapshot has no changelog entries")
	}
}

func TestAccessorsCopySnapshot(t *testing.T) {
	bundle := decode(t, snapshot("["+testGuide+"]", "[]"))
	before := bundle.Guides()

	touched := bundle.Guides()
	touched[0].Title = "改过的标题"
	touched[0].Tags = append(touched[0].Tags, "改过的标签")
	touched[0].Sections[0].Heading = "改过的小节"
	touched[0].Sections[0].Text = "改过的正文"
	looked, found := bundle.Guide("guide-one")
	if !found {
		t.Fatal("guide lookup failed")
	}
	looked.Sections[0].Heading = "通过 Guide 改过"

	if again := bundle.Guides(); !reflect.DeepEqual(again, before) {
		t.Fatalf("snapshot mutated: %+v", again)
	}
}

func TestDecodeRejectsInvalidSnapshots(t *testing.T) {
	base := snapshot("["+testGuide+"]", "[]")
	if _, err := Decode([]byte(base)); err != nil {
		t.Fatalf("baseline snapshot rejected: %v", err)
	}
	cases := map[string]string{
		"unknown top level field": strings.Replace(base, `"updates":[]`, `"updates":[],"extra":1`, 1),
		"wrong format":            strings.Replace(base, `"format":1`, `"format":2`, 1),
		"short digest":            strings.Replace(base, strings.Repeat("a", 64), "abc", 1),
		"uppercase id":            strings.Replace(base, `"id":"guide-one"`, `"id":"Guide-One"`, 1),
		"duplicate id":            snapshot("["+testGuide+","+testGuide+"]", "[]"),
		"empty guide list":        snapshot("[]", "[]"),
		"unknown section type":    strings.Replace(base, `"type":"p"`, `"type":"table"`, 1),
		"dated wrong":             strings.Replace(base, `"updatedAt":"2026-09-20"`, `"updatedAt":"2026/09/20"`, 1),
		"empty title":             strings.Replace(base, `"title":"标题"`, `"title":"  "`, 1),
		"list section with text":  strings.Replace(base, `"type":"p","text":"正文"`, `"type":"ul","text":"正文"`, 1),
		"empty list section":      strings.Replace(base, `"type":"p","text":"正文"`, `"type":"ul","items":[]`, 1),
		"bad update date":         snapshot("["+testGuide+"]", `[{"date":"昨天","title":"标题","summary":"摘要"}]`),
	}
	for name, data := range cases {
		if _, err := Decode([]byte(data)); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestSearchFiltersAndPages(t *testing.T) {
	bundle := decode(t, snapshot(`[
	{"id":"alpha-guide","kind":"official","status":"published","title":"甲的攻略","category":"机制说明",
	 "aliases":["甲"],"tags":["机制"],"updatedAt":"2026-09-20","summary":"第一份摘要",
	 "sections":[{"h":"入口","type":"p","text":"钓速与技巧"},{"h":"清单","type":"ul","items":["双钓","稀有度"]}]},
	{"id":"beta-guide","kind":"official","status":"published","title":"乙的攻略","category":"工坊指南",
	 "aliases":["乙"],"tags":["熔炼"],"updatedAt":"2026-09-19","summary":"第二份摘要",
	 "sections":[{"h":"入口","type":"note","text":"残片保留"}]},
	{"id":"gamma-guide","kind":"official","status":"published","title":"丙的攻略","category":"机制说明",
	 "aliases":["丙"],"tags":["机制"],"updatedAt":"2026-09-18","summary":"第三份摘要",
	 "sections":[{"h":"入口","type":"p","text":"海图与远洋"}]}]`, "[]"))

	total, items := bundle.Search("", "", "", 2, 0)
	if total != 3 || len(items) != 2 || items[0].ID != "alpha-guide" || items[1].ID != "beta-guide" {
		t.Fatalf("first page: total=%d items=%v", total, ids(items))
	}
	total, items = bundle.Search("", "", "", 2, 2)
	if total != 3 || len(items) != 1 || items[0].ID != "gamma-guide" {
		t.Fatalf("second page: total=%d items=%v", total, ids(items))
	}
	total, items = bundle.Search("", "", "", 2, 99)
	if total != 3 || len(items) != 0 {
		t.Fatalf("offset past the end: total=%d items=%v", total, ids(items))
	}
	if total, items = bundle.Search("", "official", "", 0, 0); total != 3 || len(items) != 3 {
		t.Fatalf("official filter: total=%d", total)
	}
	if total, items = bundle.Search("", "user", "", 0, 0); total != 0 || len(items) != 0 {
		t.Fatalf("user filter should stay empty: %d", total)
	}
	if total, items = bundle.Search("", "", "机制说明", 0, 0); total != 2 || len(items) != 2 {
		t.Fatalf("category filter: total=%d items=%v", total, ids(items))
	}
	if total, _ = bundle.Search("", "", "没有这个分类", 0, 0); total != 0 {
		t.Fatalf("unknown category matched: %d", total)
	}
	// The needle covers the summary, tags, aliases, section text and list items.
	for _, needle := range []string{"第二份", "熔炼", "双钓", "远洋", "甲"} {
		if total, _ = bundle.Search(needle, "", "", 0, 0); total != 1 {
			t.Fatalf("needle %q matched %d guides", needle, total)
		}
	}
	if total, _ = bundle.Search("  钓速  ", "", "", 0, 0); total != 1 {
		t.Fatalf("trimmed needle matched %d guides", total)
	}
	if total, items = bundle.Search("", "", "", 0, 0); total != 3 || len(items) != 3 {
		t.Fatalf("non-positive limit should return everything: %d", total)
	}
}

func TestRevisionTracksBytes(t *testing.T) {
	base := snapshot("["+testGuide+"]", "[]")
	first := decode(t, base)
	same := decode(t, base)
	if first.Revision() != same.Revision() {
		t.Fatalf("identical snapshots produced different revisions: %d vs %d", first.Revision(), same.Revision())
	}
	changed := decode(t, strings.Replace(base, "正文", "改过的正文", 1))
	if changed.Revision() == first.Revision() {
		t.Fatalf("changed content kept revision %d", first.Revision())
	}
	if first.UpdatedAt() != "2026-09-20" {
		t.Fatalf("updatedAt: %q", first.UpdatedAt())
	}
	newer := decode(t, snapshot("["+testGuide+"]", `[{"date":"2026-09-21","title":"标题","summary":"摘要"}]`))
	if newer.UpdatedAt() != "2026-09-21" {
		t.Fatalf("changelog date should win when newer: %q", newer.UpdatedAt())
	}
}

func ids(guides []Guide) []string {
	out := make([]string, 0, len(guides))
	for _, guide := range guides {
		out = append(out, guide.ID)
	}
	return out
}
