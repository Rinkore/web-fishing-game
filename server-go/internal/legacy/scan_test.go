package legacy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func put(t *testing.T, root, name, data string) {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

const validAccount = `{"username":"PrivatePlayer","pwHash":"SECRET_HASH","mfa":{"secret":"SECRET_MFA"},"coins":9007199254740991,"inventory":{"fish":5},"bigfish":{"fish":{"L":2,"G":1}}}`

func fixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	put(t, root, "accounts/privateplayer.json", validAccount)
	put(t, root, "market.json", `{"listingSeq":2,"listings":[{"lid":1,"seller":"privateplayer","id":"fish","qty":2,"price":10}]}`)
	for _, name := range []string{"records", "economy", "config"} {
		put(t, root, name+".json", `{}`)
	}
	return root
}

func hasIssue(r *Report, code string) bool {
	for _, issue := range r.Issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

func TestScanReadOnlyDeterministicAndRedacted(t *testing.T) {
	root := fixture(t)
	first, err := Scan(root, "v0.21.3")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Scan(root, "v0.21.3")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("unstable report")
	}
	if first.ImportReady || len(first.Pending) == 0 || len(first.Issues) != 0 {
		t.Fatalf("unexpected readiness/findings: %+v", first)
	}
	if first.Counts["account"] != 1 || first.Counts["listings"] != 1 {
		t.Fatal(first.Counts)
	}
	data, _ := json.Marshal(first)
	for _, secret := range []string{"PrivatePlayer", "privateplayer", "SECRET_HASH", "SECRET_MFA", root} {
		if strings.Contains(string(data), secret) {
			t.Fatal("private source data leaked")
		}
	}
	stored, err := os.ReadFile(filepath.Join(root, "accounts/privateplayer.json"))
	if err != nil || string(stored) != validAccount {
		t.Fatal("snapshot changed")
	}
	put(t, root, "accounts/privateplayer.json", strings.Replace(validAccount, `"L":2`, `"L":1`, 1))
	changed, _ := Scan(root, "v0.21.3")
	if changed.ManifestHash == first.ManifestHash {
		t.Fatal("manifest ignored source change")
	}
}

func TestAccountAnomalies(t *testing.T) {
	tests := []struct{ name, old, value, issue string }{
		{"negative", `"coins":9007199254740991`, `"coins":-1`, "invalid-coins"},
		{"fraction", `"fish":5`, `"fish":1.5`, "invalid-inventory-quantity"},
		{"string", `"fish":5`, `"fish":"5"`, "invalid-inventory-quantity"},
		{"unsafe", `"coins":9007199254740991`, `"coins":9007199254740992`, "number-outside-js-safe-range"},
		{"reserved", `"L":2`, `"L":5`, "bigfish-exceeds-inventory"},
		{"credential", `"pwHash":"SECRET_HASH"`, `"pwHash":null`, "missing-credential"},
		{"duplicate", `"coins":9007199254740991`, `"coins":1,"coins":2`, "invalid-or-duplicate-key-json"},
		{"exponent", `"coins":9007199254740991`, `"coins":1e999999999`, "number-outside-js-safe-range"},
		{"tiny-exponent", `"coins":9007199254740991`, `"coins":1e-999999999`, "number-outside-js-safe-range"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := fixture(t)
			put(t, root, "accounts/privateplayer.json", strings.Replace(validAccount, tc.old, tc.value, 1))
			r, err := Scan(root, "v0.21.3")
			if err != nil || !hasIssue(r, tc.issue) {
				t.Fatalf("missing %s: %+v %v", tc.issue, r, err)
			}
		})
	}
}

func TestMissingOrAmbiguousData(t *testing.T) {
	root := fixture(t)
	put(t, root, "accounts/duplicate.json", validAccount)
	put(t, root, "users.json", `{}`)
	put(t, root, "unknown.json", `{}`)
	put(t, root, "wiki.db-wal", `opaque`)
	put(t, root, "market.json", `{"listings":[{"lid":1,"seller":"absent","id":"fish","qty":1,"price":10},{"lid":1,"seller":"privateplayer","id":"fish","qty":0,"price":-1}]}`)
	r, err := Scan(root, "v0.21.3")
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"duplicate-normalized-account", "legacy-monolith-requires-versioned-review", "unclassified-file", "orphan-listing-seller", "duplicate-listing-id", "invalid-listing-qty", "invalid-listing-price"} {
		if !hasIssue(r, code) {
			t.Error("missing", code)
		}
	}
	r, err = Scan(t.TempDir(), "unknown")
	if err != nil || !hasIssue(r, "no-split-accounts") || !hasIssue(r, "missing-config") {
		t.Fatal("empty snapshot accepted")
	}
	if _, err = Scan(root, ""); err == nil {
		t.Fatal("version required")
	}
}

func TestMalformedJSON(t *testing.T) {
	for _, input := range []string{`{"token":"DO_NOT_LOG",`, `{} {}`, `{"x":{"x":1,"x":2}}`, "{\"x\":\"\xff\"}", strings.Repeat("[", 130) + strings.Repeat("]", 130)} {
		root := fixture(t)
		put(t, root, "sessions.json", input)
		r, err := Scan(root, "test")
		if err != nil || !hasIssue(r, "invalid-or-duplicate-key-json") {
			t.Fatal("malformed JSON accepted")
		}
		encoded, _ := json.Marshal(r)
		if strings.Contains(string(encoded), "DO_NOT_LOG") {
			t.Fatal("parser leaked value")
		}
	}
}

func TestExactIntegerNotation(t *testing.T) {
	for _, value := range []string{"5.0", "5e0", "0", "9007199254740991"} {
		if _, ok := nonnegative(json.Number(value)); !ok {
			t.Errorf("rejected exact integer %s", value)
		}
	}
	for _, value := range []string{"-1", "0.1", "9007199254740992", "9007199254740991.1"} {
		if _, ok := nonnegative(json.Number(value)); ok {
			t.Errorf("accepted invalid integer %s", value)
		}
	}
}

func TestSymlinkNotFollowed(t *testing.T) {
	root := fixture(t)
	target := filepath.Join(t.TempDir(), "secret.json")
	if err := os.WriteFile(target, []byte(`{"private":"not-read"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "accounts", "linked.json")); err != nil {
		t.Skip("symlink unavailable on this host")
	}
	r, err := Scan(root, "test")
	if err != nil || !hasIssue(r, "symlink-not-read") {
		t.Fatal("symlink accepted")
	}
}
