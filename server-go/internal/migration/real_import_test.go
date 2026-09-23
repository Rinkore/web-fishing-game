package migration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestDeterministicRunIDIsUUID(t *testing.T) {
	a := deterministicRunID("manifest", "v1")
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(a) {
		t.Fatal("run ID is not a valid versioned UUID")
	}
	if a != deterministicRunID("manifest", "v1") || a == deterministicRunID("other", "v1") {
		t.Fatal("run identity does not follow source digest")
	}
}

func preparedFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	content := map[string]string{"accounts/synthetic.json": `{"username":"synthetic"}`, "wiki.db": "fixture-only"}
	for _, name := range []string{"config", "market", "economy", "records", "admin", "feedback", "stats", "sessions", "wiki-export"} {
		content[name+".json"] = `{}`
	}
	var manifest []realFile
	for name, text := range content {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256([]byte(text))
		manifest = append(manifest, realFile{name, int64(len(text)), hex.EncodeToString(h[:])})
	}
	b, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(root, "snapshot-manifest.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestInspectRealRejectsChangedAndUnlistedSource(t *testing.T) {
	for _, attack := range []string{"changed", "unlisted", "traversal", "duplicate"} {
		t.Run(attack, func(t *testing.T) {
			root := preparedFixture(t)
			if _, a, _, err := InspectReal(root); err != nil || len(a) != 1 {
				t.Fatal("fixture failed inspection", err)
			}
			switch attack {
			case "changed":
				_ = os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"changed":true}`), 0600)
			case "unlisted":
				_ = os.WriteFile(filepath.Join(root, "extra.json"), []byte(`{}`), 0600)
			default:
				p := filepath.Join(root, "snapshot-manifest.json")
				b, _ := os.ReadFile(p)
				var m []realFile
				_ = json.Unmarshal(b, &m)
				if attack == "traversal" {
					m[0].Path = "../outside.json"
				} else {
					m = append(m, m[0])
				}
				b, _ = json.Marshal(m)
				_ = os.WriteFile(p, b, 0600)
			}
			if _, _, _, err := InspectReal(root); err == nil {
				t.Fatal("unsafe snapshot accepted")
			}
		})
	}
}
