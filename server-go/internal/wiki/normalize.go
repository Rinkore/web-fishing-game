package wiki

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

// Problem is a client-safe validation error returned by the Wiki boundary.
// Keeping validation failures typed prevents handlers from exposing parser or
// database details while preserving the legacy Chinese error messages.
type Problem struct {
	Status  int
	Message string
	Cause   error
}

func (p Problem) Error() string {
	if p.Message != "" {
		return p.Message
	}
	if p.Cause != nil {
		return p.Cause.Error()
	}
	return fmt.Sprintf("Wiki validation failed (%d)", p.Status)
}

type Content struct {
	Guides  []Guide  `json:"guides"`
	Updates []Update `json:"updates"`
}
type Submission struct {
	Title    string    `json:"title"`
	Category string    `json:"category"`
	Summary  string    `json:"summary"`
	Tags     []string  `json:"tags"`
	Sections []Section `json:"sections"`
}

func normalizedText(s *string, max int, required bool) bool {
	*s = strings.TrimSpace(*s)
	return (!required || *s != "") && len(utf16.Encode([]rune(*s))) <= max
}
func normalizedList(list *[]string, count, size int) bool {
	if *list == nil {
		*list = []string{}
	}
	if len(*list) > count {
		return false
	}
	for i := range *list {
		if !normalizedText(&(*list)[i], size, true) {
			return false
		}
	}
	return true
}
func normalizeSections(sections []Section, user bool) bool {
	n, text, count, item := 40, 5000, 30, 1500
	if user {
		n, text, count, item = 20, 4000, 20, 1200
	}
	if len(sections) < 1 || len(sections) > n {
		return false
	}
	for i := range sections {
		s := &sections[i]
		if !normalizedText(&s.Heading, 100, true) {
			return false
		}
		switch s.Type {
		case "p", "note":
			if !normalizedText(&s.Text, text, true) {
				return false
			}
			s.Items = nil
		case "ol", "ul":
			if !normalizedList(&s.Items, count, item) || len(s.Items) == 0 {
				return false
			}
			s.Text = ""
		default:
			return false
		}
	}
	return true
}

func NormalizeSubmission(raw []byte) (Submission, error) {
	var out Submission
	if len(raw) > 64<<10 {
		return out, Problem{400, "单篇攻略不能超过 64 KB", nil}
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return out, Problem{400, "攻略投稿必须是对象", nil}
	}
	for _, key := range []string{"id", "kind", "status", "author", "authorKey", "authorName", "submittedAt"} {
		if v, ok := fields[key]; ok && string(v) != "null" {
			return out, Problem{400, "投稿中不能包含系统字段", nil}
		}
	}
	if json.Unmarshal(raw, &out) != nil || !normalizedText(&out.Title, 120, true) || !normalizedText(&out.Category, 40, true) || !normalizedText(&out.Summary, 300, true) {
		return out, Problem{400, "标题、分类或摘要格式错误", nil}
	}
	allowed := false
	for _, value := range []string{"新手入门", "机制说明", "进阶策略", "工坊指南", "经济交易", "配装攻略", "心得分享"} {
		if out.Category == value {
			allowed = true
		}
	}
	if !allowed {
		return out, Problem{400, "未知攻略分类", nil}
	}
	if !normalizedList(&out.Tags, 6, 24) || !normalizeSections(out.Sections, true) {
		return out, Problem{400, "标签或攻略段落格式错误", nil}
	}
	return out, nil
}

func NormalizeContent(raw []byte) (Content, error) {
	var out Content
	var input struct {
		Guides  []json.RawMessage `json:"guides"`
		Updates []Update          `json:"updates"`
	}
	if json.Unmarshal(raw, &input) != nil || len(input.Guides) < 1 || len(input.Guides) > 100 || input.Updates == nil || len(input.Updates) > 100 {
		return out, Problem{400, "官方攻略或更新记录格式错误（最多各 100 条）", nil}
	}
	out.Guides, out.Updates = []Guide{}, input.Updates
	ids := map[string]bool{}
	for _, raw := range input.Guides {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return out, Problem{400, "官方攻略格式错误", nil}
		}
		for _, key := range []string{"author", "authorKey", "submittedAt"} {
			if v, ok := fields[key]; ok && string(v) != "null" {
				return out, Problem{400, "官方攻略不能包含用户投稿字段", nil}
			}
		}
		var g Guide
		if json.Unmarshal(raw, &g) != nil {
			return out, Problem{400, "官方攻略格式错误", nil}
		}
		g.ID = strings.TrimSpace(g.ID)
		if !idPattern.MatchString(g.ID) || ids[g.ID] {
			return out, Problem{400, "攻略 ID 无效或重复", nil}
		}
		ids[g.ID] = true
		g.Kind, g.Status = "official", "published"
		if !normalizedText(&g.Title, 120, true) || !normalizedText(&g.Category, 40, true) || !normalizedText(&g.Summary, 300, true) || !normalizedText(&g.UpdatedAt, 10, true) || !datePattern.MatchString(g.UpdatedAt) {
			return out, Problem{400, "攻略标题、分类、摘要或日期格式错误", nil}
		}
		if !normalizedList(&g.Tags, 16, 24) || !normalizedList(&g.Aliases, 16, 40) || !normalizeSections(g.Sections, false) {
			return out, Problem{400, "攻略标签或段落格式错误", nil}
		}
		out.Guides = append(out.Guides, g)
	}
	for i := range out.Updates {
		u := &out.Updates[i]
		if !normalizedText(&u.Date, 10, true) || !datePattern.MatchString(u.Date) || !normalizedText(&u.Title, 120, true) || !normalizedText(&u.Summary, 500, true) {
			return out, Problem{400, "更新记录格式错误", nil}
		}
	}
	return out, nil
}
