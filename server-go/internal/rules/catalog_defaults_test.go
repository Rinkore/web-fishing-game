package rules

import (
	"encoding/json"
	"reflect"
	"testing"
)

// legacyRelease rewrites the embedded catalog the way an older binary published
// it: the named constants and default sections are simply absent, because the
// binary that wrote the release did not know about them yet.
func legacyRelease(t *testing.T, dropConstants, dropDefaults []string) []byte {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(defaultCatalog, &doc); err != nil {
		t.Fatal(err)
	}
	drop := func(field string, names []string) {
		entries := map[string]json.RawMessage{}
		if err := json.Unmarshal(doc[field], &entries); err != nil {
			t.Fatal(err)
		}
		for _, name := range names {
			if _, ok := entries[name]; !ok {
				t.Fatalf("built-in catalog has no %s entry %q to drop", field, name)
			}
			delete(entries, name)
		}
		encoded, err := json.Marshal(entries)
		if err != nil {
			t.Fatal(err)
		}
		doc[field] = encoded
	}
	drop("constants", dropConstants)
	drop("defaults", dropDefaults)
	doc["version"] = json.RawMessage(`"v0.23.4"`)
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func cloneRaw(raw map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(raw))
	for name, value := range raw {
		out[name] = append(json.RawMessage(nil), value...)
	}
	return out
}

// TestFillMissingDefaultsRestoresSectionsAnOlderReleaseLacks pins the
// production incident: the live head served a release published before HUT
// existed, so HutConfig reported an empty level curve (every hut command was
// rejected) and the console projection panicked on it.
func TestFillMissingDefaultsRestoresSectionsAnOlderReleaseLacks(t *testing.T) {
	c, err := DecodeCatalog(legacyRelease(t, []string{"HUT"}, []string{"smelt"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.HutConfig().Levels) != 0 || len(c.Defaults["smelt"]) != 0 {
		t.Fatal("precondition: the legacy release already carries the newer sections")
	}
	if err := c.FillMissingDefaults(); err != nil {
		t.Fatal(err)
	}
	want, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if got := c.HutConfig(); !reflect.DeepEqual(got, want.HutConfig()) {
		t.Fatalf("backfilled hut config = %+v, want %+v", got, want.HutConfig())
	}
	if got := c.WorkshopConfig(); !reflect.DeepEqual(got, want.WorkshopConfig()) {
		t.Fatalf("backfilled workshop defaults = %+v, want %+v", got, want.WorkshopConfig())
	}
}

// TestFillMissingDefaultsKeepsThePublishedValues makes sure the rescue cannot
// silently roll operator configuration back: only names the release does not
// carry at all are overlaid.
func TestFillMissingDefaultsKeepsThePublishedValues(t *testing.T) {
	c, err := DecodeCatalog(legacyRelease(t, []string{"GROUNDS"}, []string{"snapshot"}))
	if err != nil {
		t.Fatal(err)
	}
	var hut map[string]any
	if err := json.Unmarshal(c.Constants["HUT"], &hut); err != nil {
		t.Fatal(err)
	}
	hut["capacityHours"] = 6
	hut["levels"] = []float64{5, 6, 7, 8, 9, 10, 11, 12, 13, 14}
	publishedHut, err := json.Marshal(hut)
	if err != nil {
		t.Fatal(err)
	}
	c.Constants["HUT"] = publishedHut
	c.Defaults["mall"] = json.RawMessage(`{"refreshTime":"05:30","items":[]}`)

	if err := c.FillMissingDefaults(); err != nil {
		t.Fatal(err)
	}
	got := c.HutConfig()
	if got.CapacityHours != 6 || len(got.Levels) != 10 || got.Levels[0] != 5 {
		t.Fatalf("published hut rules were overwritten: %+v", got)
	}
	if got := c.MallConfig().RefreshTime; got != "05:30" {
		t.Fatalf("published mall default was overwritten: %q", got)
	}
	want, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	if string(c.Constants["GROUNDS"]) != string(want.Constants["GROUNDS"]) {
		t.Fatal("absent constant was not restored")
	}
	if len(c.Defaults["snapshot"]) == 0 {
		t.Fatal("absent default section was not restored")
	}
}

// TestFillMissingDefaultsLeavesACompleteReleaseAlone covers the normal path: a
// release that already carries every section must come back byte for byte.
func TestFillMissingDefaultsLeavesACompleteReleaseAlone(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	constants, defaults := cloneRaw(c.Constants), cloneRaw(c.Defaults)
	if err := c.FillMissingDefaults(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(constants, c.Constants) || !reflect.DeepEqual(defaults, c.Defaults) {
		t.Fatal("a complete release was rewritten")
	}
}
