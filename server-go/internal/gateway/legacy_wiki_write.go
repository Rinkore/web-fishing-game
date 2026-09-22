package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/wiki"
	"github.com/jackc/pgx/v5"
)

func wikiAutoApprove() bool {
	return strings.TrimSpace(os.Getenv("WIKI_GUIDE_AUTO_APPROVE")) != "0"
}

func decodeWikiRaw(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 80<<10)
	var raw json.RawMessage
	d := json.NewDecoder(r.Body)
	if err := d.Decode(&raw); err != nil {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		failure(w, identity.ErrInvalid)
		return nil, false
	}
	return raw, true
}

func wikiLimitsPayload(l wiki.Limits) map[string]any {
	return map[string]any{"submittedIn24h": l.SubmittedIn24h, "pending": l.Pending, "nextAllowedAt": l.NextAllowedAt, "autoApprove": wikiAutoApprove()}
}

func wikiGuideMineView(g wiki.GuideRecord) map[string]any {
	return map[string]any{
		"id": g.ID, "title": g.Title, "category": g.Category, "summary": g.Summary,
		"sections": g.Sections, "tags": g.Tags, "status": g.Status,
		"autoApproved": g.ReviewedBy == "auto", "submittedAt": g.SubmittedAt,
		"reviewedAt": g.ReviewedAt, "reviewNote": g.ReviewNote,
	}
}

func wikiGuideAdminView(g wiki.GuideRecord) map[string]any {
	return map[string]any{
		"id": g.ID, "title": g.Title, "category": g.Category, "summary": g.Summary,
		"sections": g.Sections, "tags": g.Tags, "status": g.Status,
		"autoApproved": g.ReviewedBy == "auto", "authorName": g.AuthorName,
		"submittedAt": g.SubmittedAt, "reviewedAt": g.ReviewedAt,
		"reviewedBy": g.ReviewedBy, "reviewNote": g.ReviewNote,
	}
}

func (a *API) legacyWikiGuideSubmit(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	raw, ok := decodeWikiRaw(w, r)
	if !ok {
		return
	}
	sub, err := wiki.NormalizeSubmission(raw)
	if err != nil {
		write(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	id, status, limits, err := a.wikiStore.InsertUser(r.Context(), session.AccountID, session.Name, sub, wikiAutoApprove())
	if err != nil {
		if errors.Is(err, wiki.ErrLimit) {
			write(w, http.StatusTooManyRequests, map[string]any{"error": strings.TrimSpace(strings.TrimPrefix(err.Error(), wiki.ErrLimit.Error()+":")), "limits": wikiLimitsPayload(limits)})
			return
		}
		failure(w, identity.ErrStorage)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "guideId": id, "status": status, "autoApproved": status == "approved", "limits": wikiLimitsPayload(limits)})
}

func (a *API) legacyWikiGuideMine(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	guides, limits, err := a.wikiStore.Mine(r.Context(), session.AccountID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	out := make([]map[string]any, 0, len(guides))
	for _, g := range guides {
		out = append(out, wikiGuideMineView(g))
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "guides": out, "limits": wikiLimitsPayload(limits)})
}

func (a *API) legacyWikiGuideDelete(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	raw, ok := decodeWikiRaw(w, r)
	if !ok {
		return
	}
	var in struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &in) != nil || strings.TrimSpace(in.ID) == "" {
		write(w, http.StatusBadRequest, map[string]any{"error": "攻略 ID 无效"})
		return
	}
	_, err := a.wikiStore.Delete(r.Context(), strings.TrimSpace(in.ID), session.AccountID, session.Name, "作者删除", true, session.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		write(w, http.StatusNotFound, map[string]any{"error": "攻略不存在"})
		return
	}
	if err != nil {
		if strings.Contains(err.Error(), "只有待审核") {
			write(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		failure(w, identity.ErrStorage)
		return
	}
	limits, err := a.wikiStore.Limits(r.Context(), session.AccountID)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "limits": wikiLimitsPayload(limits)})
}

func (a *API) legacyAdminWikiContent(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	official, updated, guides, updates, err := a.wikiStore.Official(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	_, userRevision, err := a.wikiStore.Revisions(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if strings.TrimSpace(updated) == "" {
		updated = time.Now().UTC().Format(time.RFC3339Nano)
	}
	etag := legacyWikiETagPair(official, userRevision)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", etag)
	if legacyWikiETagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	content := make([]wiki.Guide, 0, len(guides))
	for _, g := range guides {
		content = append(content, g.Guide)
	}
	write(w, http.StatusOK, map[string]any{"revision": official, "officialRevision": official, "userRevision": userRevision, "updatedAt": updated, "guides": content, "updates": updates})
}

func (a *API) legacyAdminWikiContentSave(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	raw, ok := decodeWikiRaw(w, r)
	if !ok {
		return
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		write(w, http.StatusBadRequest, map[string]any{"error": "请求格式错误"})
		return
	}
	var base float64
	if value, exists := envelope["baseRevision"]; !exists || json.Unmarshal(value, &base) != nil {
		write(w, http.StatusConflict, map[string]any{"error": "Wiki 内容已被其他人修改，请刷新后重试"})
		return
	}
	current, _, err := a.wikiStore.Revisions(r.Context())
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if int64(base) != current {
		write(w, http.StatusConflict, map[string]any{"error": "Wiki 内容已被其他人修改，请刷新后重试", "currentRevision": current})
		return
	}
	var content wiki.Content
	if reset, exists := envelope["reset"]; exists && string(reset) == "true" {
		bundle, e := wiki.Default()
		if e != nil {
			failure(w, identity.ErrStorage)
			return
		}
		content = wiki.Content{Guides: bundle.Guides(), Updates: bundle.Updates()}
	} else {
		value, exists := envelope["content"]
		if !exists || json.Unmarshal(value, &content) != nil {
			write(w, http.StatusBadRequest, map[string]any{"error": "Wiki 内容格式错误"})
			return
		}
		normalized, e := wiki.NormalizeContent(value)
		if e != nil {
			write(w, http.StatusBadRequest, map[string]any{"error": e.Error()})
			return
		}
		content = normalized
	}
	revision, err := a.wikiStore.ReplaceOfficial(r.Context(), content, current, actor.AccountID, actor.Name)
	if errors.Is(err, wiki.ErrConflict) {
		write(w, http.StatusConflict, map[string]any{"error": "Wiki 内容已被其他人修改，请刷新后重试", "currentRevision": revision})
		return
	}
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	_, userRevision, _ := a.wikiStore.Revisions(r.Context())
	write(w, http.StatusOK, map[string]any{"revision": revision, "officialRevision": revision, "userRevision": userRevision, "updatedAt": time.Now().UTC().Format(time.RFC3339Nano), "guides": content.Guides, "updates": content.Updates})
}

func (a *API) legacyAdminWikiGuides(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	if status != "pending" && status != "approved" && status != "rejected" && status != "all" {
		write(w, http.StatusBadRequest, map[string]any{"error": "未知审核状态"})
		return
	}
	if status == "all" {
		status = ""
	}
	guides, revision, counts, err := a.wikiStore.ListUsers(r.Context(), status)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	out := make([]map[string]any, 0, len(guides))
	for _, g := range guides {
		out = append(out, wikiGuideAdminView(g))
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "status": status, "revision": revision, "guides": out, "autoApprove": wikiAutoApprove(), "counts": counts})
}

func (a *API) legacyAdminWikiGuideReview(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	raw, ok := decodeWikiRaw(w, r)
	if !ok {
		return
	}
	var in struct{ ID, Action, ExpectedStatus, Note string }
	if json.Unmarshal(raw, &in) != nil || strings.TrimSpace(in.ID) == "" {
		write(w, http.StatusBadRequest, map[string]any{"error": "请求格式错误"})
		return
	}
	if in.Action != "approve" && in.Action != "reject" {
		write(w, http.StatusBadRequest, map[string]any{"error": "审核动作必须是 approve 或 reject"})
		return
	}
	in.Note = strings.TrimSpace(in.Note)
	if len([]rune(in.Note)) > 500 || in.Action == "reject" && in.Note == "" {
		write(w, http.StatusBadRequest, map[string]any{"error": "审核备注格式错误"})
		return
	}
	guide, revision, err := a.wikiStore.Review(r.Context(), in.ID, in.Action, in.Note, actor.AccountID, actor.Name, in.ExpectedStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		write(w, http.StatusNotFound, map[string]any{"error": "攻略不存在"})
		return
	}
	if errors.Is(err, wiki.ErrConflict) {
		currentStatus := strings.TrimPrefix(err.Error(), wiki.ErrConflict.Error()+":")
		write(w, http.StatusConflict, map[string]any{"error": "攻略状态已变化，请刷新后重试", "currentStatus": currentStatus})
		return
	}
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "guide": wikiGuideAdminView(guide), "revision": revision})
}

func (a *API) legacyAdminWikiGuideDelete(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	raw, ok := decodeWikiRaw(w, r)
	if !ok {
		return
	}
	var in struct{ ID, Reason string }
	if json.Unmarshal(raw, &in) != nil || strings.TrimSpace(in.ID) == "" {
		write(w, http.StatusBadRequest, map[string]any{"error": "请求格式错误"})
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || len([]rune(in.Reason)) > 500 {
		write(w, http.StatusBadRequest, map[string]any{"error": "删除原因不能为空或过长"})
		return
	}
	revision, err := a.wikiStore.Delete(r.Context(), in.ID, actor.AccountID, actor.Name, in.Reason, false, 0)
	if errors.Is(err, pgx.ErrNoRows) {
		write(w, http.StatusNotFound, map[string]any{"error": "攻略不存在"})
		return
	}
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, http.StatusOK, map[string]any{"ok": true, "revision": revision})
}
