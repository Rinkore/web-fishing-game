package migration

import (
	"os"
	"testing"
)

func TestRealDomainNestedGates(t *testing.T) {
	root := completeRealSafetyFixture(t, false, false)
	if err := ValidateRealDomains(root); err != nil {
		t.Fatal(err)
	}
	feedback, err := rwRead(root, "feedback.json")
	if err != nil {
		t.Fatal(err)
	}
	rwMap(rwList(feedback["feedback"])[0])["unmappedAttachment"] = "synthetic"
	rwFixtureFile(t, root, "feedback.json", feedback)
	if err = ValidateRealDomains(root); err == nil {
		t.Fatal("unknown feedback field accepted")
	}
	delete(rwMap(rwList(feedback["feedback"])[0]), "unmappedAttachment")
	rwFixtureFile(t, root, "feedback.json", feedback)
	wiki, err := rwRead(root, "wiki-export.json")
	if err != nil {
		t.Fatal(err)
	}
	tables := rwMap(wiki["tables"])
	tables["guide_sections"] = []any{map[string]any{"guide_id": "synthetic", "ord": 0, "heading": "heading", "type": "p", "text": "body", "items_json": nil}}
	rwFixtureFile(t, root, "wiki-export.json", wiki)
	if err = ValidateRealDomains(root); err != nil {
		t.Fatal("nullable SQLite paragraph items rejected", err)
	}
	if got, err := rwWikiJSON(nil, true); err != nil || string(got) != "[]" {
		t.Fatal("nullable paragraph items not normalized", err)
	}
	rwMap(rwList(tables["guide_sections"])[0])["newColumn"] = "synthetic"
	rwFixtureFile(t, root, "wiki-export.json", wiki)
	if err = ValidateRealDomains(root); err == nil {
		t.Fatal("unknown SQLite column accepted")
	}
}

// Optional, read-only verification of an operator-prepared snapshot. Never
// prints private records or connects to a database.
func TestRealDomainsPreparedSnapshot(t *testing.T) {
	root := os.Getenv("FISHING_REAL_VALIDATE_ROOT")
	if root == "" {
		t.Skip("operator-prepared source is optional")
	}
	if err := ValidateRealDomains(root); err != nil {
		t.Fatal(err)
	}
}
