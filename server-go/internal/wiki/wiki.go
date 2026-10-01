// Package wiki holds the official Wiki content snapshot embedded in the Go
// server. The snapshot is generated from frontend/wiki/content/content.json by
// the reviewed source snapshot and checked in, so the binary stays hermetic
// and CI fails when the source changes without a reviewed regeneration.
//
// Only the reviewed official content is served here. Player submissions and the
// operator editor still need a storage decision, so this package deliberately
// has no write path: revisions are derived from the embedded bytes instead of a
// write counter, and every content change therefore requires a new build.
package wiki

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

//go:embed content.json
var defaultContent []byte

// Limits mirror WIKI_OFFICIAL_SECTION_LIMITS and normalizeWikiContent in
// the retired legacy server server (recoverable from Git history). Lengths count runes,
// which matches the UTF-16 unit counts
// of the legacy checker for every character outside the astral planes and is
// marginally more permissive for the rest.
const (
	maxGuides   = 100
	maxUpdates  = 100
	maxSections = 40
	maxHeading  = 100
	maxText     = 5000
	maxItems    = 30
	maxItem     = 1500
)

var (
	idPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,79}$`)
	datePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

	errInvalid = errors.New("invalid wiki content")
)

// Section is one heading with either a paragraph (p, note) or a list (ol, ul),
// matching the section shapes the legacy server stores and returns.
type Section struct {
	Heading string   `json:"h"`
	Type    string   `json:"type"`
	Text    string   `json:"text,omitempty"`
	Items   []string `json:"items,omitempty"`
}

// Guide is one official guide with its full body.
type Guide struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Status    string    `json:"status"`
	Title     string    `json:"title"`
	Category  string    `json:"category"`
	Aliases   []string  `json:"aliases"`
	Tags      []string  `json:"tags"`
	UpdatedAt string    `json:"updatedAt"`
	Summary   string    `json:"summary"`
	Sections  []Section `json:"sections"`
}

// Update is one entry of the public changelog.
type Update struct {
	Date    string `json:"date"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
}

// Bundle is a validated, immutable content snapshot. Accessors copy whatever
// they return, so callers cannot mutate the shared default snapshot.
type Bundle struct {
	Format       int      `json:"format"`
	Source       string   `json:"source"`
	SourceSHA256 string   `json:"sourceSHA256"`
	GuideList    []Guide  `json:"guides"`
	UpdateList   []Update `json:"updates"`

	index     map[string]int
	revision  int64
	updatedAt string
}

var (
	defaultOnce   sync.Once
	defaultBundle *Bundle
	defaultErr    error
)

// Default returns the embedded snapshot. The returned value is shared; use the
// accessors instead of mutating its fields.
func Default() (*Bundle, error) {
	defaultOnce.Do(func() { defaultBundle, defaultErr = Decode(defaultContent) })
	return defaultBundle, defaultErr
}

// Decode validates a snapshot. It rejects unknown top-level fields so that a
// regenerated file with new structure fails loudly instead of being dropped.
func Decode(data []byte) (*Bundle, error) {
	var b Bundle
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&b); err != nil {
		return nil, errInvalid
	}
	if err := b.validate(data); err != nil {
		return nil, err
	}
	return &b, nil
}

func (b *Bundle) validate(raw []byte) error {
	if b.Format != 1 || strings.TrimSpace(b.Source) == "" || len(b.SourceSHA256) != 64 {
		return errInvalid
	}
	if _, err := hex.DecodeString(b.SourceSHA256); err != nil {
		return errInvalid
	}
	if len(b.GuideList) == 0 || len(b.GuideList) > maxGuides || len(b.UpdateList) > maxUpdates {
		return errInvalid
	}
	b.index = make(map[string]int, len(b.GuideList))
	latest := ""
	for i := range b.GuideList {
		g := &b.GuideList[i]
		if !idPattern.MatchString(g.ID) || g.Kind != "official" || g.Status != "published" {
			return errInvalid
		}
		if _, duplicate := b.index[g.ID]; duplicate {
			return errInvalid
		}
		if !textOK(g.Title, 120) || !textOK(g.Category, 40) || !textOK(g.Summary, 300) || !datePattern.MatchString(g.UpdatedAt) {
			return errInvalid
		}
		if !listOK(g.Aliases, 16, 40) || !listOK(g.Tags, 16, 24) {
			return errInvalid
		}
		if len(g.Sections) == 0 || len(g.Sections) > maxSections {
			return errInvalid
		}
		for j := range g.Sections {
			if g.Sections[j].validate() != nil {
				return errInvalid
			}
		}
		b.index[g.ID] = i
		if g.UpdatedAt > latest {
			latest = g.UpdatedAt
		}
	}
	for _, u := range b.UpdateList {
		if !datePattern.MatchString(u.Date) || !textOK(u.Title, 120) || !textOK(u.Summary, 500) {
			return errInvalid
		}
		if u.Date > latest {
			latest = u.Date
		}
	}
	b.updatedAt = latest
	b.revision = revisionOf(raw)
	return nil
}

func (s *Section) validate() error {
	if !textOK(s.Heading, maxHeading) {
		return errInvalid
	}
	switch s.Type {
	case "p", "note":
		if !textOK(s.Text, maxText) || len(s.Items) != 0 {
			return errInvalid
		}
	case "ol", "ul":
		if s.Text != "" || !listOK(s.Items, maxItems, maxItem) || len(s.Items) == 0 {
			return errInvalid
		}
	default:
		return errInvalid
	}
	return nil
}

func textOK(value string, max int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && utf8.RuneCountInString(trimmed) <= max
}

func listOK(values []string, maxItems, maxLen int) bool {
	if len(values) > maxItems {
		return false
	}
	for _, value := range values {
		if !textOK(value, maxLen) {
			return false
		}
	}
	return true
}

// revisionOf derives the official revision from the served bytes: the value is
// stable for a given snapshot and changes whenever the snapshot changes, which
// is the property the ETag and the five-second client poll rely on.
func revisionOf(raw []byte) int64 {
	sum := sha256.Sum256(raw)
	value := binary.BigEndian.Uint64(sum[:8]) % (1 << 31)
	if value == 0 {
		value = 1
	}
	return int64(value)
}

// Revision reports the official content revision.
func (b *Bundle) Revision() int64 { return b.revision }

// UpdatedAt reports the newest date found in the snapshot (guides and changelog
// entries both carry YYYY-MM-DD), or "" when the snapshot has no dates.
func (b *Bundle) UpdatedAt() string { return b.updatedAt }

// Guides returns the guides in source order, which is the order the legacy list
// uses for official content.
func (b *Bundle) Guides() []Guide {
	out := make([]Guide, 0, len(b.GuideList))
	for i := range b.GuideList {
		out = append(out, copyGuide(&b.GuideList[i]))
	}
	return out
}

// Guide returns one guide by id.
func (b *Bundle) Guide(id string) (Guide, bool) {
	i, ok := b.index[id]
	if !ok {
		return Guide{}, false
	}
	return copyGuide(&b.GuideList[i]), true
}

// Updates returns the changelog in source order.
func (b *Bundle) Updates() []Update {
	return append([]Update(nil), b.UpdateList...)
}

// Search reproduces the legacy public list query: the optional filters are an
// exact kind, an exact category and a substring match over the title, summary,
// tags, aliases and section bodies. The needle is compared case-insensitively,
// which matches SQLite's ASCII-insensitive LIKE for the Chinese content this
// snapshot holds. It returns the total number of matches plus the requested
// page; a non-positive limit means "everything left".
func (b *Bundle) Search(needle, kind, category string, limit, offset int) (int, []Guide) {
	needle = strings.ToLower(strings.TrimSpace(needle))
	matched := make([]int, 0, len(b.GuideList))
	for i := range b.GuideList {
		g := &b.GuideList[i]
		if kind != "" && g.Kind != kind {
			continue
		}
		if category != "" && g.Category != category {
			continue
		}
		if needle != "" && !g.matches(needle) {
			continue
		}
		matched = append(matched, i)
	}
	start, end := offset, len(matched)
	if start < 0 {
		start = 0
	}
	if start > end {
		start = end
	}
	if limit > 0 && start+limit < end {
		end = start + limit
	}
	out := make([]Guide, 0, end-start)
	for _, i := range matched[start:end] {
		out = append(out, copyGuide(&b.GuideList[i]))
	}
	return len(matched), out
}

func (g *Guide) matches(needle string) bool {
	if containsFold(g.Title, needle) || containsFold(g.Summary, needle) {
		return true
	}
	for _, value := range g.Tags {
		if containsFold(value, needle) {
			return true
		}
	}
	for _, value := range g.Aliases {
		if containsFold(value, needle) {
			return true
		}
	}
	for i := range g.Sections {
		section := &g.Sections[i]
		if containsFold(section.Heading, needle) || containsFold(section.Text, needle) {
			return true
		}
		for _, item := range section.Items {
			if containsFold(item, needle) {
				return true
			}
		}
	}
	return false
}

func containsFold(value, needle string) bool {
	return strings.Contains(strings.ToLower(value), needle)
}

func copyGuide(source *Guide) Guide {
	out := *source
	out.Tags = append([]string(nil), source.Tags...)
	out.Aliases = append([]string(nil), source.Aliases...)
	out.Sections = make([]Section, len(source.Sections))
	for i, section := range source.Sections {
		out.Sections[i] = section
		out.Sections[i].Items = append([]string(nil), section.Items...)
	}
	return out
}
