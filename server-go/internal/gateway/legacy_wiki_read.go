package gateway

import (
	"errors"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/wiki"

	"github.com/go-chi/chi/v5"
)

// Legacy Wiki public reads and the simulator's read-only inventory projection.

var legacyWikiIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)

// legacyWikiGuideView is the public guide projection. Lists omit sections,
// exactly like publicGuideMeta in the retired legacy server server.
type legacyWikiGuideView struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Status      string         `json:"status"`
	Title       string         `json:"title"`
	Category    string         `json:"category"`
	Summary     string         `json:"summary"`
	Sections    []wiki.Section `json:"sections,omitempty"`
	Tags        []string       `json:"tags"`
	Aliases     []string       `json:"aliases"`
	UpdatedAt   string         `json:"updatedAt"`
	AuthorName  string         `json:"authorName,omitempty"`
	SubmittedAt *time.Time     `json:"submittedAt,omitempty"`
}

func legacyWikiView(guide *wiki.GuideRecord, withSections bool) legacyWikiGuideView {
	view := legacyWikiGuideView{
		ID: guide.ID, Kind: guide.Kind, Status: guide.Status, Title: guide.Title,
		Category: guide.Category, Summary: guide.Summary,
		Tags: guide.Tags, Aliases: guide.Aliases, UpdatedAt: guide.UpdatedAt,
	}
	if guide.Kind == "user" {
		view.AuthorName = guide.AuthorName
		view.SubmittedAt = guide.SubmittedAt
		if guide.ReviewedAt != nil {
			view.UpdatedAt = guide.ReviewedAt.Format(time.RFC3339Nano)
		} else if guide.SubmittedAt != nil {
			view.UpdatedAt = guide.SubmittedAt.Format(time.RFC3339Nano)
		}
	}
	if withSections {
		view.Sections = guide.Sections
	}
	return view
}

func legacyWikiMetaList(guides []wiki.GuideRecord) []legacyWikiGuideView {
	metas := make([]legacyWikiGuideView, 0, len(guides))
	for i := range guides {
		metas = append(metas, legacyWikiView(&guides[i], false))
	}
	return metas
}

func legacyWikiETagPair(official, user int64) string {
	return `"wiki-content-` + strconv.FormatInt(official, 10) + `-` + strconv.FormatInt(user, 10) + `"`
}

// legacyWikiETagMatches mirrors etagMatches in the retired legacy server server: a comma
// separated list of exact validators, weak validators included. A wildcard is
// not part of the legacy contract.
func legacyWikiETagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, value := range strings.Split(header, ",") {
		value = strings.TrimSpace(value)
		if value == etag || value == "W/"+etag {
			return true
		}
	}
	return false
}

func (a *API) legacyWikiContent(w http.ResponseWriter, r *http.Request) {
	official, user, updatedAt, guides, err := a.wikiStore.PublicAll(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	etag := legacyWikiETagPair(official, user)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	if legacyWikiETagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	var updated any
	if updatedAt != "" {
		updated = updatedAt
	}
	write(w, 200, map[string]any{
		"revision":         "official:" + strconv.FormatInt(official, 10) + ":user:" + strconv.FormatInt(user, 10),
		"officialRevision": official,
		"userRevision":     user,
		"updatedAt":        updated,
		"guides":           legacyWikiMetaList(guides),
		"updates":          a.wikiStore.Updates(r.Context()),
	})
}

func (a *API) legacyWikiGuides(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page := legacyWikiPageNumber(query.Get("page"))
	pageSize := legacyWikiPageSize(query.Get("pageSize"))
	kind := query.Get("kind")
	if kind != "official" && kind != "user" {
		kind = ""
	}
	total, guides, err := a.wikiStore.Public(r.Context(), legacyWikiTruncate(query.Get("q"), 80), kind, legacyWikiTruncate(query.Get("category"), 40), pageSize, (page-1)*pageSize)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	write(w, 200, map[string]any{
		"ok":       true,
		"page":     page,
		"pageSize": pageSize,
		"total":    total,
		"guides":   legacyWikiMetaList(guides),
	})
}

func (a *API) legacyWikiGuideDetail(w http.ResponseWriter, r *http.Request) {
	guide, err := a.wikiStore.PublicOne(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	id := chi.URLParam(r, "id")
	if !legacyWikiIDPattern.MatchString(id) {
		write(w, 404, map[string]any{"error": "攻略不存在或未公开"})
		return
	}
	if guide == nil {
		write(w, 404, map[string]any{"error": "攻略不存在或未公开"})
		return
	}
	write(w, 200, map[string]any{"ok": true, "guide": legacyWikiView(guide, true)})
}

// legacyWikiGuideSession reports whether the caller holds a player session. It
// is the probe the Wiki uses before offering the submission tools, so a missing
// or expired token is a normal answer rather than an error.
func (a *API) legacyWikiGuideSession(w http.ResponseWriter, r *http.Request) {
	authenticated := false
	if _, err := a.identity.Authenticate(r.Context(), token(r, false), false); err == nil {
		authenticated = true
	} else if errors.Is(err, identity.ErrStorage) {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "authenticated": authenticated})
}

// legacyWikiSimulatorInventory serves the simulator's read-only copy of the
// player's inventory and rod views. It never triggers autoSellCheck or any other
// gameplay side effect, which is why it does not reuse /api/me.
func (a *API) legacyWikiSimulatorInventory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie, Authorization")
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	var name, username string
	var coins, revision int64
	var capacity int
	if err := a.pool.QueryRow(r.Context(), `SELECT i.display_name,i.username,w.coins,p.assets_rev,p.rod_capacity
 FROM fishing.identities i JOIN fishing.wallets w ON w.account_id=i.account_id JOIN fishing.player_state p ON p.account_id=i.account_id WHERE i.account_id=$1`, session.AccountID).
		Scan(&name, &username, &coins, &revision, &capacity); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	inventory, _, err := a.legacyInventory(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	bd, slots, _, _, locked, err := a.legacyRod(r.Context(), c, session.AccountID, capacity)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if strings.TrimSpace(name) == "" {
		name = username
	}
	write(w, 200, map[string]any{
		"schemaVersion": 1,
		"readOnly":      true,
		"fetchedAt":     time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"name":          name,
		"coins":         coins,
		"invRev":        strconv.FormatInt(revision, 10),
		"inventory":     inventory,
		"bd":            bd,
		"rodSlots":      slots,
		"rodLocked":     locked,
	})
}

// legacyWikiPageNumber mirrors Math.max(1, Math.floor(Number(page) || 1)): a
// missing, malformed or non-positive page is page 1.
func legacyWikiPageNumber(raw string) int {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) {
		return 1
	}
	return int(math.Max(1, math.Floor(math.Min(value, 1e9))))
}

// legacyWikiPageSize mirrors Math.max(1, Math.min(50, Math.floor(Number(pageSize) || 20))),
// where 0 and NaN both fall back to the default of 20.
func legacyWikiPageSize(raw string) int {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || value == 0 {
		return 20
	}
	return int(math.Floor(math.Min(math.Max(value, 1), 50)))
}

// legacyWikiTruncate bounds a query string the way String(...).trim().slice(0, max)
// does, counted in runes.
func legacyWikiTruncate(raw string, max int) string {
	value := strings.TrimSpace(raw)
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}
