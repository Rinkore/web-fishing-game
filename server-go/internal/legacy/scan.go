// Package legacy inventories offline Node save snapshots without normalizing or
// rewriting them. A successful scan is not permission to import or cut over.
package legacy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxJSONBytes = 64 << 20

type Issue struct {
	File string `json:"file"`
	Code string `json:"code"`
}

// Ref intentionally replaces paths, which can contain account names. Reports
// never serialize JSON values, parser errors, credentials, or MFA material.
type File struct {
	Ref    string `json:"ref"`
	Domain string `json:"domain"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256,omitempty"`
}

type Report struct {
	Format        int            `json:"format"`
	SourceVersion string         `json:"sourceVersionDeclared"`
	ImportReady   bool           `json:"importReady"`
	ManifestHash  string         `json:"manifestSha256"`
	Files         []File         `json:"files"`
	Counts        map[string]int `json:"counts"`
	Issues        []Issue        `json:"issues"`
	Pending       []string       `json:"pending"`
}

type account struct {
	ref string
	rec map[string]any
}

var rootDomains = map[string]string{
	"market.json": "market", "records.json": "records", "economy.json": "economy",
	"config.json": "config", "feedback.json": "feedback", "stats.json": "stats",
	"admin.json": "admin", "sessions.json": "sessions", "users.json": "legacy-users",
	"world.json": "legacy-world", "wiki.json": "legacy-wiki", "wiki-guides.json": "legacy-wiki",
	"wiki.db": "wiki-sqlite", "wiki.db-wal": "wiki-sqlite", "wiki.db-shm": "wiki-sqlite",
}

func domain(rel string) string {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) == 2 && parts[0] == "accounts" && strings.HasSuffix(parts[1], ".json") {
		return "account"
	}
	if len(parts) > 1 && parts[0] == "snapshots" {
		return "historical-snapshot"
	}
	if len(parts) == 1 {
		if d, ok := rootDomains[rel]; ok {
			return d
		}
	}
	return "unknown"
}

// Scan requires a caller-supplied, immutable offline copy. It detects some
// concurrent changes, but cannot prove cross-file consistency of a live copy.
func Scan(root, version string) (*Report, error) {
	if strings.TrimSpace(version) == "" {
		return nil, errors.New("source version is required")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("snapshot must be an existing directory, not a symlink")
	}
	r := &Report{Format: 1, SourceVersion: version, Files: []File{}, Issues: []Issue{}, Counts: map[string]int{},
		Pending: []string{"verify-source-version-and-offline-consistency", "review-all-fields-and-equipment-references", "review-world-and-companion-services", "trial-import-and-field-by-field-reconciliation"}}
	issue := func(ref, code string) { r.Issues = append(r.Issues, Issue{ref, code}) }
	manifest := sha256.New()
	accounts := map[string]account{}
	var listings []account
	seenDomains := map[string]bool{}
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return errors.New("snapshot directory cannot be enumerated")
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return errors.New("invalid snapshot path")
		}
		if entry.IsDir() {
			return nil
		}
		ref := fmt.Sprintf("file-%06d", len(r.Files)+1)
		d := domain(rel)
		item := File{Ref: ref, Domain: d}
		defer func() { r.Files = append(r.Files, item) }()
		r.Counts[d]++
		seenDomains[d] = true
		if entry.Type()&os.ModeSymlink != 0 {
			issue(ref, "symlink-not-read")
			return nil
		}
		before, err := entry.Info()
		if err != nil || !before.Mode().IsRegular() {
			issue(ref, "not-readable-regular-file")
			return nil
		}
		item.Bytes = before.Size()
		if d == "unknown" {
			issue(ref, "unclassified-file")
		}
		f, err := os.Open(path)
		if err != nil {
			issue(ref, "read-failed")
			return nil
		}
		defer f.Close()
		opened, err := f.Stat()
		if err != nil || !os.SameFile(before, opened) {
			issue(ref, "file-changed-during-scan")
			return nil
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		if err != nil {
			issue(ref, "read-failed")
			return nil
		}
		item.SHA256 = hex.EncodeToString(h.Sum(nil))
		// Encode path length/content unambiguously; names appear only inside hash.
		fmt.Fprintf(manifest, "%d:%s:%d:%s\n", len(filepath.ToSlash(rel)), filepath.ToSlash(rel), n, item.SHA256)
		if strings.HasSuffix(rel, ".json") {
			if n > MaxJSONBytes {
				issue(ref, "json-size-limit")
				return nil
			}
			if _, err = f.Seek(0, io.SeekStart); err != nil {
				issue(ref, "read-failed")
				return nil
			}
			parseHash := sha256.New()
			value, parseErr := decode(io.TeeReader(io.LimitReader(f, MaxJSONBytes+1), parseHash))
			if parseErr != nil {
				issue(ref, "invalid-or-duplicate-key-json")
			} else {
				if hex.EncodeToString(parseHash.Sum(nil)) != item.SHA256 {
					issue(ref, "file-changed-during-scan")
				}
				if unsafeNumber(value) {
					issue(ref, "number-outside-js-safe-range")
				}
				rec, ok := value.(map[string]any)
				if d == "account" {
					if !ok {
						issue(ref, "invalid-account-shape")
					} else {
						name, _ := rec["username"].(string)
						key := strings.ToLower(name)
						if key == "" {
							issue(ref, "missing-account-name")
						} else if _, exists := accounts[key]; exists {
							issue(ref, "duplicate-normalized-account")
						} else {
							accounts[key] = account{ref, rec}
						}
						checkAccount(rec, ref, issue)
					}
				}
				if d == "market" {
					rows, valid := rec["listings"].([]any)
					if !ok || !valid {
						issue(ref, "invalid-market-shape")
					} else {
						for _, row := range rows {
							listing, valid := row.(map[string]any)
							if !valid {
								issue(ref, "invalid-listing-shape")
							} else {
								listings = append(listings, account{ref, listing})
							}
						}
					}
				}
			}
		}
		after, err := os.Lstat(path)
		if err != nil || !os.SameFile(before, after) || n != before.Size() || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
			issue(ref, "file-changed-during-scan")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !seenDomains["account"] {
		issue("snapshot", "no-split-accounts")
	}
	for _, d := range []string{"market", "records", "economy", "config"} {
		if !seenDomains[d] {
			issue("snapshot", "missing-"+d)
		}
	}
	if seenDomains["legacy-users"] || seenDomains["legacy-world"] {
		issue("snapshot", "legacy-monolith-requires-versioned-review")
	}
	if seenDomains["wiki-sqlite"] {
		r.Pending = append(r.Pending, "verify-sqlite-backup-and-wal-consistency")
	}
	ids := map[string]bool{}
	for _, row := range listings {
		l := row.rec
		seller, _ := l["seller"].(string)
		if _, ok := accounts[seller]; !ok {
			issue(row.ref, "orphan-listing-seller")
		}
		id, idOK := l["id"].(string)
		if !idOK || id == "" {
			issue(row.ref, "missing-listing-item")
		}
		lid, ok := nonnegative(l["lid"])
		if !ok {
			issue(row.ref, "invalid-listing-id")
		} else {
			if ids[lid.String()] {
				issue(row.ref, "duplicate-listing-id")
			}
			ids[lid.String()] = true
		}
		for _, field := range []string{"qty", "price"} {
			n, ok := nonnegative(l[field])
			if !ok || n.Sign() == 0 {
				issue(row.ref, "invalid-listing-"+field)
			}
		}
	}
	r.Counts["listings"] = len(listings)
	r.ManifestHash = hex.EncodeToString(manifest.Sum(nil))
	sort.SliceStable(r.Issues, func(i, j int) bool {
		if r.Issues[i].File == r.Issues[j].File {
			return r.Issues[i].Code < r.Issues[j].Code
		}
		return r.Issues[i].File < r.Issues[j].File
	})
	return r, nil
}

func exactNumber(n json.Number) (*big.Rat, bool) {
	text := string(n)
	if len(text) > 256 {
		return nil, false
	}
	if i := strings.IndexAny(text, "eE"); i >= 0 {
		exponent, err := strconv.Atoi(text[i+1:])
		if err != nil || exponent < -400 || exponent > 400 {
			return nil, false
		}
	}
	return new(big.Rat).SetString(text)
}

func nonnegative(v any) (*big.Int, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return nil, false
	}
	r, ok := exactNumber(n)
	if !ok || !r.IsInt() || r.Sign() < 0 || r.Num().Cmp(big.NewInt(9007199254740991)) > 0 {
		return nil, false
	}
	return r.Num(), true
}

func checkAccount(rec map[string]any, ref string, issue func(string, string)) {
	if _, ok := nonnegative(rec["coins"]); !ok {
		issue(ref, "invalid-coins")
	}
	if hash, ok := rec["pwHash"].(string); !ok || hash == "" {
		issue(ref, "missing-credential")
	}
	inv, ok := rec["inventory"].(map[string]any)
	if !ok {
		issue(ref, "invalid-inventory")
		return
	}
	for _, qty := range inv {
		if _, ok := nonnegative(qty); !ok {
			issue(ref, "invalid-inventory-quantity")
		}
	}
	if raw, exists := rec["bigfish"]; exists && raw != nil {
		fish, valid := raw.(map[string]any)
		if !valid {
			issue(ref, "invalid-bigfish")
			return
		}
		for id, rawTiers := range fish {
			tiers, valid := rawTiers.(map[string]any)
			if !valid {
				issue(ref, "invalid-bigfish")
				continue
			}
			total := new(big.Int)
			for _, tier := range []string{"L", "G"} {
				n, valid := nonnegative(tiers[tier])
				if !valid {
					issue(ref, "invalid-bigfish-quantity")
				} else {
					total.Add(total, n)
				}
			}
			qty, valid := nonnegative(inv[id])
			if !valid || total.Cmp(qty) > 0 {
				issue(ref, "bigfish-exceeds-inventory")
			}
		}
	}
}

func unsafeNumber(v any) bool {
	switch v := v.(type) {
	case json.Number:
		r, ok := exactNumber(v)
		return !ok || new(big.Rat).Abs(r).Cmp(new(big.Rat).SetInt64(9007199254740991)) > 0
	case map[string]any:
		for _, child := range v {
			if unsafeNumber(child) {
				return true
			}
		}
	case []any:
		for _, child := range v {
			if unsafeNumber(child) {
				return true
			}
		}
	}
	return false
}

// Decode numbers exactly and reject duplicate keys instead of silently letting
// a later credential, balance or inventory replace an earlier value.
func decode(reader io.Reader) (any, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxJSONBytes+1))
	if err != nil || len(data) > MaxJSONBytes || !utf8.Valid(data) {
		return nil, errors.New("invalid JSON encoding or size")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := readValue(d, 0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON data")
	}
	return v, nil
}

func readValue(d *json.Decoder, depth int) (any, error) {
	if depth > 128 {
		return nil, errors.New("JSON depth limit")
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, compound := t.(json.Delim)
	if !compound {
		return t, nil
	}
	switch delim {
	case '{':
		m := map[string]any{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, err
			}
			k, ok := key.(string)
			if !ok {
				return nil, errors.New("invalid key")
			}
			if _, exists := m[k]; exists {
				return nil, errors.New("duplicate key")
			}
			m[k], err = readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
		}
		_, err := d.Token()
		return m, err
	case '[':
		a := []any{}
		for d.More() {
			v, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
		_, err := d.Token()
		return a, err
	default:
		return nil, errors.New("unexpected delimiter")
	}
}
