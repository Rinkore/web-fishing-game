package migrations

import "testing"

func TestStepsUseFullFilenameOrderAndPreserveMerged0027(t *testing.T) {
	all := steps()
	indices := make(map[string]int, len(all))
	for i, step := range all {
		if i > 0 && all[i-1].name >= step.name {
			t.Fatalf("migration filenames not strictly ordered: %q then %q", all[i-1].name, step.name)
		}
		indices[step.name] = i
	}
	checksums := map[string]string{
		"0027_admin_market.sql": "049cc5f42a795a0aa4db2aff59ba0cd9d3cbb70eac7e01b150115e77281fe241",
		"0027_record_hides.sql": "7796ef29efd46af97622cd2b25b9bfcc5f92271ca0e9c112dff1b27c84ab8b84",
	}
	for name, checksum := range checksums {
		i, exists := indices[name]
		if !exists || all[i].checksum != checksum {
			t.Fatalf("published migration %s renamed or changed", name)
		}
	}
	if indices["0027_admin_market.sql"]+1 != indices["0027_record_hides.sql"] {
		t.Fatal("merged 0027 migrations must retain full-filename order")
	}
}

func TestCompatibleHistoricalRecordBranchIsNarrow(t *testing.T) {
	expected := steps()
	// Include a future step so the historical exception cannot accidentally
	// permit holes after later migrations have already been applied.
	expected = append(expected, step{name: "9999_future.sql", checksum: "future"})
	base := make(map[string]string)
	for _, step := range expected {
		if step.name <= "0027_record_hides.sql" && step.name != "0027_admin_market.sql" {
			base[step.name] = step.checksum
		}
	}
	for _, test := range []struct {
		name       string
		change     func(map[string]string)
		requireAll bool
		want       bool
	}{
		{name: "record branch", want: true},
		{name: "startup requires all", requireAll: true},
		{name: "earlier gap", change: func(seen map[string]string) { delete(seen, "0026_wiki_store.sql") }},
		{name: "unknown filename", change: func(seen map[string]string) { seen["0027_unknown.sql"] = "unknown" }},
		{name: "renamed record migration", change: func(seen map[string]string) {
			delete(seen, "0027_record_hides.sql")
			seen["0028_record_hides.sql"] = "renamed"
		}},
		{name: "changed earlier checksum", change: func(seen map[string]string) { seen["0001_asset_core.sql"] = "tampered" }},
		{name: "changed record checksum", change: func(seen map[string]string) { seen["0027_record_hides.sql"] = "tampered" }},
		{name: "later migration with gap", change: func(seen map[string]string) { seen["9999_future.sql"] = "future" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			seen := make(map[string]string, len(base))
			for name, checksum := range base {
				seen[name] = checksum
			}
			if test.change != nil {
				test.change(seen)
			}
			if got := compatible(seen, expected, test.requireAll); got != test.want {
				t.Fatalf("compatible = %v, want %v", got, test.want)
			}
		})
	}
}
