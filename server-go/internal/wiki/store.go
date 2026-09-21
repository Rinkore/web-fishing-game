package wiki

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxUserGuides = 10000

var (
	ErrConflict = errors.New("wiki revision conflict")
	ErrLimit    = errors.New("wiki submission limit")
)

// GuideRecord contains the public guide plus moderation fields used by the
// authenticated Wiki views. The gateway deliberately projects these fields.
type GuideRecord struct {
	Guide
	OwnerID     int64
	HasOwner    bool
	AuthorName  string
	SubmittedAt *time.Time
	ReviewedAt  *time.Time
	ReviewedBy  string
	ReviewNote  string
	DeletedAt   *time.Time
	Revision    int64
}

type Limits struct {
	SubmittedIn24h int        `json:"submittedIn24h"`
	Pending        int        `json:"pending"`
	NextAllowedAt  *time.Time `json:"nextAllowedAt"`
}

type Store struct {
	pool   *pgxpool.Pool
	mu     sync.Mutex
	seeded bool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Ensure(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seeded {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var official int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM fishing.wiki_guides WHERE kind='official' AND deleted_at IS NULL`).Scan(&official); err != nil {
		return err
	}
	if official == 0 {
		bundle, e := Default()
		if e != nil {
			return e
		}
		for i, g := range bundle.Guides() {
			if err = insertGuide(ctx, tx, g, 0, "", nil, nil, "", "", i, 1); err != nil {
				return err
			}
		}
		for i, u := range bundle.Updates() {
			if _, err = tx.Exec(ctx, `INSERT INTO fishing.wiki_updates(ordinal,day,title,summary) VALUES($1,$2,$3,$4)`, i, u.Date, u.Title, u.Summary); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_state SET official_revision=$1,official_updated_at=$2 WHERE singleton`, bundle.Revision(), bundle.UpdatedAt()); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.seeded = true
	return nil
}

func marshalJSON(value any) ([]byte, error) { return json.Marshal(value) }

func insertGuide(ctx context.Context, tx pgx.Tx, g Guide, ownerID int64, authorName string, submittedAt, reviewedAt *time.Time, reviewedBy, reviewNote string, sortOrder int, revision int64) error {
	tags, err := marshalJSON(g.Tags)
	if err != nil {
		return err
	}
	aliases, err := marshalJSON(g.Aliases)
	if err != nil {
		return err
	}
	status := g.Status
	if status == "" {
		status = "published"
	}
	kind := g.Kind
	if kind == "" {
		kind = "official"
	}
	var owner any
	if ownerID != 0 {
		owner = ownerID
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.wiki_guides(id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,updated_label,revision,sort_order)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		g.ID, kind, status, g.Title, g.Category, g.Summary, tags, aliases, owner, authorName, submittedAt, reviewedAt, reviewedBy, reviewNote, g.UpdatedAt, revision, sortOrder); err != nil {
		return err
	}
	for i, sec := range g.Sections {
		sectionItems := sec.Items
		if sectionItems == nil {
			sectionItems = []string{}
		}
		items, e := marshalJSON(sectionItems)
		if e != nil {
			return e
		}
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.wiki_sections(guide_id,ordinal,heading,type,body,items) VALUES($1,$2,$3,$4,$5,$6)`, g.ID, i, sec.Heading, sec.Type, sec.Text, items); err != nil {
			return err
		}
	}
	return nil
}

func decodeStrings(raw []byte) []string {
	var out []string
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return []string{}
	}
	return out
}

func (s *Store) state(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (int64, int64, string, error) {
	var official, user int64
	var updated string
	err := q.QueryRow(ctx, `SELECT official_revision,user_revision,official_updated_at FROM fishing.wiki_state WHERE singleton`).Scan(&official, &user, &updated)
	return official, user, updated, err
}

func scanGuide(row pgx.Row) (GuideRecord, error) {
	var r GuideRecord
	var tags, aliases []byte
	var owner *int64
	err := row.Scan(&r.ID, &r.Kind, &r.Status, &r.Title, &r.Category, &r.Summary, &tags, &aliases, &owner, &r.AuthorName, &r.SubmittedAt, &r.ReviewedAt, &r.ReviewedBy, &r.ReviewNote, &r.DeletedAt, &r.UpdatedAt, &r.Revision, new(int), new(time.Time))
	if err != nil {
		return r, err
	}
	r.Tags, r.Aliases = decodeStrings(tags), decodeStrings(aliases)
	if owner != nil {
		r.OwnerID, r.HasOwner = *owner, true
	}
	return r, nil
}

func scanGuideRows(rows pgx.Rows) ([]GuideRecord, error) {
	defer rows.Close()
	out := []GuideRecord{}
	for rows.Next() {
		var r GuideRecord
		var tags, aliases []byte
		var owner *int64
		var sortOrder int
		var created time.Time
		if err := rows.Scan(&r.ID, &r.Kind, &r.Status, &r.Title, &r.Category, &r.Summary, &tags, &aliases, &owner, &r.AuthorName, &r.SubmittedAt, &r.ReviewedAt, &r.ReviewedBy, &r.ReviewNote, &r.DeletedAt, &r.UpdatedAt, &r.Revision, &sortOrder, &created); err != nil {
			return nil, err
		}
		r.Tags, r.Aliases = decodeStrings(tags), decodeStrings(aliases)
		if owner != nil {
			r.OwnerID, r.HasOwner = *owner, true
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) sections(ctx context.Context, id string) ([]Section, error) {
	rows, err := s.pool.Query(ctx, `SELECT heading,type,body,items FROM fishing.wiki_sections WHERE guide_id=$1 ORDER BY ordinal`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Section{}
	for rows.Next() {
		var sec Section
		var items []byte
		if err := rows.Scan(&sec.Heading, &sec.Type, &sec.Text, &items); err != nil {
			return nil, err
		}
		sec.Items = decodeStrings(items)
		if sec.Type == "p" || sec.Type == "note" {
			sec.Items = nil
		}
		out = append(out, sec)
	}
	return out, rows.Err()
}

func (s *Store) withSections(ctx context.Context, guides []GuideRecord) error {
	for i := range guides {
		sections, err := s.sections(ctx, guides[i].ID)
		if err != nil {
			return err
		}
		guides[i].Sections = sections
	}
	return nil
}

func (s *Store) Official(ctx context.Context) (int64, string, []GuideRecord, []Update, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, "", nil, nil, err
	}
	official, _, updated, err := s.state(ctx, s.pool)
	if err != nil {
		return 0, "", nil, nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at FROM fishing.wiki_guides WHERE kind='official' AND deleted_at IS NULL ORDER BY sort_order,id`)
	if err != nil {
		return 0, "", nil, nil, err
	}
	guides, err := scanGuideRows(rows)
	if err != nil {
		return 0, "", nil, nil, err
	}
	if err = s.withSections(ctx, guides); err != nil {
		return 0, "", nil, nil, err
	}
	updates, err := s.updates(ctx)
	return official, updated, guides, updates, err
}

func (s *Store) PublicAll(ctx context.Context) (int64, int64, string, []GuideRecord, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, 0, "", nil, err
	}
	official, user, updated, err := s.state(ctx, s.pool)
	if err != nil {
		return 0, 0, "", nil, err
	}
	_, guides, err := s.Public(ctx, "", "", "", 100000, 0)
	return official, user, updated, guides, err
}

func (s *Store) Updates(ctx context.Context) []Update {
	updates, err := s.updates(ctx)
	if err != nil {
		return []Update{}
	}
	return updates
}

func (s *Store) updates(ctx context.Context) ([]Update, error) {
	rows, err := s.pool.Query(ctx, `SELECT day,title,summary FROM fishing.wiki_updates ORDER BY ordinal`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Update{}
	for rows.Next() {
		var u Update
		if err := rows.Scan(&u.Date, &u.Title, &u.Summary); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) revisions(ctx context.Context) (int64, int64, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, 0, err
	}
	o, u, _, err := s.state(ctx, s.pool)
	return o, u, err
}

func (s *Store) Revisions(ctx context.Context) (int64, int64, error) {
	return s.revisions(ctx)
}

func (s *Store) Public(ctx context.Context, q, kind, category string, limit, offset int) (int, []GuideRecord, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, nil, err
	}
	where := []string{`deleted_at IS NULL`, `(kind='official' OR (kind='user' AND status='approved'))`}
	args := []any{}
	if kind != "" {
		where = append(where, "kind=$"+fmt.Sprint(len(args)+1))
		args = append(args, kind)
	}
	if category != "" {
		where = append(where, "category=$"+fmt.Sprint(len(args)+1))
		args = append(args, category)
	}
	if q != "" {
		pattern := "%" + strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(q, "\\", "\\\\"), "%", "\\%"), "_", "\\_") + "%"
		p := fmt.Sprint(len(args) + 1)
		where = append(where, `(title ILIKE $`+p+` ESCAPE '\\' OR summary ILIKE $`+p+` ESCAPE '\\' OR tags::text ILIKE $`+p+` ESCAPE '\\' OR aliases::text ILIKE $`+p+` ESCAPE '\\' OR EXISTS(SELECT 1 FROM fishing.wiki_sections s WHERE s.guide_id=wiki_guides.id AND (s.heading ILIKE $`+p+` ESCAPE '\\' OR s.body ILIKE $`+p+` ESCAPE '\\' OR s.items::text ILIKE $`+p+` ESCAPE '\\'))`)
		args = append(args, pattern)
	}
	base := ` FROM fishing.wiki_guides WHERE ` + strings.Join(where, " AND ")
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*)`+base, args...).Scan(&total); err != nil {
		return 0, nil, err
	}
	args = append(args, limit, offset)
	rows, err := s.pool.Query(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at`+base+` ORDER BY CASE WHEN kind='official' THEN 0 ELSE 1 END,sort_order,created_at,id LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return 0, nil, err
	}
	guides, err := scanGuideRows(rows)
	return total, guides, err
}

func (s *Store) PublicOne(ctx context.Context, id string) (*GuideRecord, error) {
	if err := s.Ensure(ctx); err != nil {
		return nil, err
	}
	row := s.pool.QueryRow(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at FROM fishing.wiki_guides WHERE id=$1 AND deleted_at IS NULL AND (kind='official' OR (kind='user' AND status='approved'))`, id)
	g, err := scanGuide(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g.Sections, err = s.sections(ctx, id)
	return &g, err
}

func (s *Store) Mine(ctx context.Context, ownerID int64) ([]GuideRecord, Limits, error) {
	if err := s.Ensure(ctx); err != nil {
		return nil, Limits{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at FROM fishing.wiki_guides WHERE kind='user' AND owner_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC,id DESC`, ownerID)
	if err != nil {
		return nil, Limits{}, err
	}
	guides, err := scanGuideRows(rows)
	if err != nil {
		return nil, Limits{}, err
	}
	if err = s.withSections(ctx, guides); err != nil {
		return nil, Limits{}, err
	}
	limits, err := s.Limits(ctx, ownerID)
	return guides, limits, err
}

func (s *Store) Limits(ctx context.Context, ownerID int64) (Limits, error) {
	if err := s.Ensure(ctx); err != nil {
		return Limits{}, err
	}
	var out Limits
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE submitted_at>=clock_timestamp()-interval '24 hours'),count(*) FILTER(WHERE status='pending'),min(submitted_at+interval '10 minutes') FILTER(WHERE submitted_at+interval '10 minutes'>clock_timestamp()) FROM fishing.wiki_guides WHERE kind='user' AND owner_id=$1 AND deleted_at IS NULL`, ownerID).Scan(&out.SubmittedIn24h, &out.Pending, &out.NextAllowedAt); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Store) ListUsers(ctx context.Context, status string) ([]GuideRecord, int64, map[string]int64, error) {
	if err := s.Ensure(ctx); err != nil {
		return nil, 0, nil, err
	}
	where := `kind='user' AND deleted_at IS NULL`
	args := []any{}
	if status != "" {
		where += ` AND status=$1`
		args = append(args, status)
	}
	rows, err := s.pool.Query(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at FROM fishing.wiki_guides WHERE `+where+` ORDER BY created_at DESC,id DESC`, args...)
	if err != nil {
		return nil, 0, nil, err
	}
	guides, err := scanGuideRows(rows)
	if err != nil {
		return nil, 0, nil, err
	}
	if err = s.withSections(ctx, guides); err != nil {
		return nil, 0, nil, err
	}
	var revision int64
	if err = s.pool.QueryRow(ctx, `SELECT user_revision FROM fishing.wiki_state WHERE singleton`).Scan(&revision); err != nil {
		return nil, 0, nil, err
	}
	counts := map[string]int64{"pending": 0, "approved": 0, "rejected": 0}
	countRows, err := s.pool.Query(ctx, `SELECT status,count(*) FROM fishing.wiki_guides WHERE kind='user' AND deleted_at IS NULL GROUP BY status`)
	if err != nil {
		return nil, 0, nil, err
	}
	for countRows.Next() {
		var key string
		var n int64
		if err := countRows.Scan(&key, &n); err != nil {
			countRows.Close()
			return nil, 0, nil, err
		}
		counts[key] = n
	}
	countRows.Close()
	return guides, revision, counts, countRows.Err()
}

func (s *Store) InsertUser(ctx context.Context, ownerID int64, authorName string, sub Submission, auto bool) (string, string, Limits, error) {
	if err := s.Ensure(ctx); err != nil {
		return "", "", Limits{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", "", Limits{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT singleton FROM fishing.wiki_state WHERE singleton FOR UPDATE`); err != nil {
		return "", "", Limits{}, err
	}
	var total int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM fishing.wiki_guides WHERE kind='user'`).Scan(&total); err != nil {
		return "", "", Limits{}, err
	}
	if total >= maxUserGuides {
		return "", "", Limits{}, fmt.Errorf("投稿总量已达上限（%d 篇），请联系管理员清理", maxUserGuides)
	}
	var limits Limits
	if err = tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE submitted_at>=clock_timestamp()-interval '24 hours'),count(*) FILTER(WHERE status='pending'),min(submitted_at+interval '10 minutes') FILTER(WHERE submitted_at+interval '10 minutes'>clock_timestamp()) FROM fishing.wiki_guides WHERE kind='user' AND owner_id=$1 AND deleted_at IS NULL`, ownerID).Scan(&limits.SubmittedIn24h, &limits.Pending, &limits.NextAllowedAt); err != nil {
		return "", "", Limits{}, err
	}
	if limits.SubmittedIn24h >= 3 {
		return "", "", limits, fmt.Errorf("%w:24 小时内最多提交 3 篇攻略", ErrLimit)
	}
	if limits.Pending >= 3 {
		return "", "", limits, fmt.Errorf("%w:待审核攻略最多 3 篇", ErrLimit)
	}
	if limits.NextAllowedAt != nil {
		return "", "", limits, fmt.Errorf("%w:提交过于频繁，请稍后再试", ErrLimit)
	}
	id := fmt.Sprintf("ug_%d", time.Now().UnixNano())
	for {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.wiki_guides WHERE id=$1)`, id).Scan(&exists); err != nil {
			return "", "", limits, err
		}
		if !exists {
			break
		}
		id = fmt.Sprintf("ug_%d", time.Now().UnixNano()+int64(len(id)))
	}
	now := time.Now().UTC()
	status, reviewedBy, note := "pending", "", ""
	var reviewedAt *time.Time
	if auto {
		status, reviewedBy, note, reviewedAt = "approved", "auto", "自动通过（当前未启用人工审核）", &now
	}
	g := Guide{ID: id, Kind: "user", Status: status, Title: sub.Title, Category: sub.Category, Summary: sub.Summary, Tags: sub.Tags, Aliases: []string{}, Sections: sub.Sections}
	if err = insertGuide(ctx, tx, g, ownerID, authorName, &now, reviewedAt, reviewedBy, note, 0, 1); err != nil {
		return "", "", limits, err
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_state SET user_revision=user_revision+1 WHERE singleton`); err != nil {
		return "", "", limits, err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", "", limits, err
	}
	limits, err = s.Limits(ctx, ownerID)
	return id, status, limits, err
}

func (s *Store) Review(ctx context.Context, id, action, note string, actorID int64, actorName string, expected string) (GuideRecord, int64, error) {
	if err := s.Ensure(ctx); err != nil {
		return GuideRecord{}, 0, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return GuideRecord{}, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current, author string
	var owner int64
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT status,author_name,owner_id,revision FROM fishing.wiki_guides WHERE id=$1 AND kind='user' AND deleted_at IS NULL FOR UPDATE`, id).Scan(&current, &author, &owner, &revision); errors.Is(err, pgx.ErrNoRows) {
		return GuideRecord{}, 0, pgx.ErrNoRows
	} else if err != nil {
		return GuideRecord{}, 0, err
	}
	if expected != current {
		return GuideRecord{}, 0, fmt.Errorf("%w:%s", ErrConflict, current)
	}
	status := "rejected"
	if action == "approve" {
		status = "approved"
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_guides SET status=$2,reviewed_at=clock_timestamp(),reviewed_by=$3,review_note=$4,revision=revision+1 WHERE id=$1`, id, status, actorName, note); err != nil {
		return GuideRecord{}, 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_state SET user_revision=user_revision+1 WHERE singleton`); err != nil {
		return GuideRecord{}, 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,$4,$5,$6)`, actorID, actorName, owner, map[string]string{"approved": "wiki_guide_approve", "rejected": "wiki_guide_reject"}[status], id, note); err != nil {
		return GuideRecord{}, 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return GuideRecord{}, 0, err
	}
	g, err := s.userByID(ctx, id, true)
	if err != nil {
		return GuideRecord{}, 0, err
	}
	var userRevision int64
	_ = s.pool.QueryRow(ctx, `SELECT user_revision FROM fishing.wiki_state WHERE singleton`).Scan(&userRevision)
	_ = owner
	_ = author
	_ = revision
	return g, userRevision, nil
}

func (s *Store) Delete(ctx context.Context, id string, actorID int64, actorName, reason string, ownerOnly bool, ownerID int64) (int64, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner int64
	var status, reviewedBy string
	q := `SELECT owner_id,status,reviewed_by FROM fishing.wiki_guides WHERE id=$1 AND kind='user' AND deleted_at IS NULL FOR UPDATE`
	if err = tx.QueryRow(ctx, q, id).Scan(&owner, &status, &reviewedBy); errors.Is(err, pgx.ErrNoRows) {
		return 0, pgx.ErrNoRows
	} else if err != nil {
		return 0, err
	}
	if ownerOnly && owner != ownerID {
		return 0, pgx.ErrNoRows
	}
	if ownerOnly && status != "pending" && !(status == "approved" && reviewedBy == "auto") {
		return 0, fmt.Errorf("只有待审核或自动通过的攻略可以由作者删除")
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_guides SET deleted_at=clock_timestamp(),deleted_by=$2,delete_reason=$3,revision=revision+1 WHERE id=$1`, id, actorName, reason); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_state SET user_revision=user_revision+1 WHERE singleton`); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,$4,$5,$6)`, actorID, actorName, owner, "wiki_guide_delete", id, reason); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	var rev int64
	err = s.pool.QueryRow(ctx, `SELECT user_revision FROM fishing.wiki_state WHERE singleton`).Scan(&rev)
	return rev, err
}

func (s *Store) ReplaceOfficial(ctx context.Context, content Content, expected, actorID int64, actorName string) (int64, error) {
	if err := s.Ensure(ctx); err != nil {
		return 0, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current int64
	if err = tx.QueryRow(ctx, `SELECT official_revision FROM fishing.wiki_state WHERE singleton FOR UPDATE`).Scan(&current); err != nil {
		return 0, err
	}
	if current != expected {
		return current, ErrConflict
	}
	if _, err = tx.Exec(ctx, `DELETE FROM fishing.wiki_guides WHERE kind='official'`); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM fishing.wiki_updates`); err != nil {
		return 0, err
	}
	revision := current + 1
	for i, g := range content.Guides {
		g.Kind, g.Status = "official", "published"
		if err = insertGuide(ctx, tx, g, 0, "", nil, nil, "", "", i, revision); err != nil {
			return 0, err
		}
	}
	for i, u := range content.Updates {
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.wiki_updates(ordinal,day,title,summary) VALUES($1,$2,$3,$4)`, i, u.Date, u.Title, u.Summary); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.wiki_state SET official_revision=$1,official_updated_at=$2 WHERE singleton`, revision, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,action,target,detail) VALUES($1,$2,'wiki_content_save','official', $3)`, actorID, actorName, fmt.Sprintf("revision=%d", revision)); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	s.mu.Lock()
	s.seeded = true
	s.mu.Unlock()
	return revision, nil
}

func (s *Store) userByID(ctx context.Context, id string, sections bool) (GuideRecord, error) {
	row := s.pool.QueryRow(ctx, `SELECT id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,updated_label,revision,sort_order,created_at FROM fishing.wiki_guides WHERE id=$1`, id)
	g, err := scanGuide(row)
	if err != nil {
		return g, err
	}
	if sections {
		g.Sections, err = s.sections(ctx, id)
	}
	return g, err
}
