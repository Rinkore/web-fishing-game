// Command repo-tool supplies repository and release metadata without executing browser code.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"fishing.local/server/internal/rules"
	"fishing.local/server/internal/wiki"
)

type manifest struct {
	Version          string `json:"version"`
	SourceCommit     string `json:"sourceCommit"`
	MigrationsSHA256 string `json:"migrationsSha256"`
	Asset            string `json:"asset"`
	SHA256           string `json:"sha256"`
}

var versionPattern = regexp.MustCompile(`(?m)^\s*const\s+VERSION\s*=\s*['"](v[0-9]+\.[0-9]+\.[0-9]+)['"]\s*;`)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func repositoryRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "server-go", "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("repository root not found")
		}
		dir = parent
	}
}

func readVersion(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	matches := versionPattern.FindAllSubmatch(data, -1)
	if len(matches) != 1 {
		return "", errors.New("expected exactly one stable VERSION declaration")
	}
	return string(matches[0][1]), nil
}

// migrationHash preserves the deployed digest protocol: sorted filenames, each
// followed by its raw-byte SHA-256 and a newline, then hashed as a single list.
func migrationHash(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return "", errors.New("no SQL migrations found")
	}
	sort.Strings(names)
	list := sha256.New()
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(list, "%s:%x\n", name, sum)
	}
	return hex.EncodeToString(list.Sum(nil)), nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func sourceDigest(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(strings.ReplaceAll(string(data), "\r\n", "\n")))
	return hex.EncodeToString(sum[:]), nil
}

func checkSnapshots(root string) error {
	catalog, err := rules.Default()
	if err != nil {
		return err
	}
	digest, err := sourceDigest(filepath.Join(root, "frontend/js/data.js"))
	if err != nil {
		return err
	}
	version, err := readVersion(filepath.Join(root, "frontend/js/data.js"))
	if err != nil {
		return err
	}
	if catalog.SourceSHA256 != digest || catalog.Version != version {
		return errors.New("Go catalog and browser data differ; review and update both sources")
	}
	content, err := wiki.Default()
	if err != nil {
		return err
	}
	digest, err = sourceDigest(filepath.Join(root, "frontend/wiki/content/content.json"))
	if err != nil {
		return err
	}
	if content.SourceSHA256 != digest {
		return errors.New("Wiki snapshot differs; run repo-tool sync-wiki after reviewing content")
	}
	return nil
}

func syncWiki(root string) error {
	data, err := os.ReadFile(filepath.Join(root, "frontend/wiki/content/content.json"))
	if err != nil {
		return err
	}
	var source struct {
		Guides  []wiki.Guide  `json:"guides"`
		Updates []wiki.Update `json:"updates"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&source); err != nil {
		return err
	}
	for i := range source.Guides {
		source.Guides[i].Kind = "official"
		source.Guides[i].Status = "published"
	}
	digest, err := sourceDigest(filepath.Join(root, "frontend/wiki/content/content.json"))
	if err != nil {
		return err
	}
	bundle := wiki.Bundle{Format: 1, Source: "frontend/wiki/content/content.json", SourceSHA256: digest, GuideList: source.Guides, UpdateList: source.Updates}
	encoded, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	if _, err = wiki.Decode(encoded); err != nil {
		return err
	}
	return writeJSON(filepath.Join(root, "server-go/internal/wiki/content.json"), bundle)
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: repo-tool version|migration-hash|check|sync-wiki|sync-versions|manifest|manifest-outputs")
	}
	root, err := repositoryRoot()
	if err != nil {
		return err
	}
	switch args[0] {
	case "version":
		path := filepath.Join(root, "frontend/js/data.js")
		if len(args) == 2 {
			path = args[1]
		}
		v, err := readVersion(path)
		if err != nil {
			return err
		}
		fmt.Println(v)
	case "migration-hash":
		path := filepath.Join(root, "server-go/migrations")
		if len(args) == 2 {
			path = args[1]
		}
		v, err := migrationHash(path)
		if err != nil {
			return err
		}
		fmt.Println(v)
	case "check":
		if err := checkSnapshots(root); err != nil {
			return err
		}
		fmt.Println("Catalog and Wiki snapshots match their sources")
	case "sync-wiki":
		return syncWiki(root)
	case "sync-versions":
		return syncVersions(root)
	case "manifest":
		m := manifest{os.Getenv("RELEASE_VERSION"), os.Getenv("SOURCE_COMMIT"), os.Getenv("MIGRATIONS_SHA256"), os.Getenv("RELEASE_ASSET"), os.Getenv("ASSET_SHA256")}
		if err := validateManifest(m); err != nil {
			return err
		}
		return writeJSON(os.Getenv("MANIFEST_PATH"), m)
	case "manifest-outputs":
		if len(args) != 2 {
			return errors.New("manifest-outputs requires a manifest path")
		}
		data, err := os.ReadFile(args[1])
		if err != nil {
			return err
		}
		var m manifest
		if err = json.Unmarshal(data, &m); err != nil {
			return err
		}
		if err = validateManifest(m); err != nil {
			return err
		}
		f, err := os.OpenFile(os.Getenv("GITHUB_OUTPUT"), os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, writeErr := fmt.Fprintf(f, "sha256=%s\nmigrationsSha256=%s\n", m.SHA256, m.MigrationsSHA256)
		closeErr := f.Close()
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
	return nil
}

func validateManifest(m manifest) error {
	version := regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
	commit := regexp.MustCompile(`^[0-9a-f]{40}$`)
	digest := regexp.MustCompile(`^[0-9a-f]{64}$`)
	if !version.MatchString(m.Version) || !commit.MatchString(m.SourceCommit) || !digest.MatchString(m.MigrationsSHA256) || !digest.MatchString(m.SHA256) || m.Asset != "web-fishing-game-linux-amd64.tar.gz" {
		return errors.New("invalid release manifest")
	}
	return nil
}

func syncVersions(root string) error {
	data, err := os.ReadFile(filepath.Join(root, "VERSIONS.md"))
	if err != nil {
		return err
	}
	type entry struct {
		Version string `json:"version"`
		Date    string `json:"date"`
		Summary string `json:"summary"`
	}
	pattern := regexp.MustCompile(`^\|\s*(v[0-9][0-9.]*)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$`)
	var entries []entry
	for _, line := range strings.Split(string(data), "\n") {
		m := pattern.FindStringSubmatch(strings.TrimSpace(line))
		if len(m) != 0 {
			entries = append(entries, entry{m[1], strings.TrimSpace(m[2]), strings.ReplaceAll(strings.TrimSpace(m[3]), "**", "")})
		}
	}
	if len(entries) == 0 {
		return errors.New("no version records found")
	}
	return writeJSON(filepath.Join(root, "frontend/wiki/content/versions.json"), struct {
		Source   string  `json:"source"`
		Count    int     `json:"count"`
		Versions []entry `json:"versions"`
	}{"VERSIONS.md", len(entries), entries})
}
