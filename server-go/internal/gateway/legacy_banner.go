package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
)

type legacyBannerEntry struct {
	ID        string  `json:"id"`
	Seq       int64   `json:"seq"`
	Content   string  `json:"content"`
	Duration  float64 `json:"duration"`
	Color     string  `json:"color"`
	CreatedAt int64   `json:"createdAt"`
	By        string  `json:"by"`
}

type legacyBannerState struct {
	Revision int64               `json:"revision"`
	Seq      int64               `json:"seq"`
	Banners  []legacyBannerEntry `json:"banners"`
	Cfg      map[string]any      `json:"cfg"`
}

func readLegacyBanners(ctx context.Context, q assets.SQL, lock bool) (legacyBannerState, error) {
	var state legacyBannerState
	var banners, cfg []byte
	query := `SELECT revision,next_seq,banners,cfg FROM fishing.banner_state WHERE singleton`
	if lock {
		query += " FOR UPDATE"
	}
	if err := q.QueryRow(ctx, query).Scan(&state.Revision, &state.Seq, &banners, &cfg); err != nil {
		return state, err
	}
	if err := json.Unmarshal(banners, &state.Banners); err != nil {
		return state, err
	}
	state.Cfg = map[string]any{"blink": false, "blinkTitle": "📢 有新公告"}
	if err := json.Unmarshal(cfg, &state.Cfg); err != nil {
		return state, err
	}
	return state, nil
}

func (s legacyBannerState) frame() map[string]any {
	return map[string]any{"type": "banner", "banners": s.Banners, "cfg": s.Cfg}
}

func (a *API) legacyBanner(w http.ResponseWriter, r *http.Request) {
	state, err := readLegacyBanners(r.Context(), a.pool, false)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, state)
}

func (a *API) legacyAdminBanner(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	ctx := r.Context()
	state, err := readLegacyBanners(ctx, a.pool, false)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	rows, err := a.pool.Query(ctx, `SELECT w.banner_id,count(*),max(w.last_at) FROM fishing.banner_watchers w
 WHERE w.last_at>clock_timestamp()-interval '15 seconds' GROUP BY w.banner_id ORDER BY count(*) DESC,max(w.last_at) DESC`)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer rows.Close()
	playing := []map[string]any{}
	for rows.Next() {
		var id string
		var count int64
		var at time.Time
		if err := rows.Scan(&id, &count, &at); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		for _, b := range state.Banners {
			if b.ID == id {
				playing = append(playing, map[string]any{"id": id, "content": b.Content, "count": count, "lastAt": at.UnixMilli()})
				break
			}
		}
	}
	if rows.Err() != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "banners": state.Banners, "cfg": state.Cfg, "seq": state.Seq,
		"revision": state.Revision, "playing": playing, "online": a.onlinePlayers(ctx)})
}

var bannerColor = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

func bannerClip(s string, limit int) string {
	u := utf16.Encode([]rune(strings.TrimSpace(s)))
	if len(u) > limit {
		u = u[:limit]
		if u[len(u)-1] >= 0xd800 && u[len(u)-1] <= 0xdbff {
			u = u[:len(u)-1]
		}
	}
	return string(utf16.Decode(u))
}

type legacyBannerInput struct {
	ID               string   `json:"id"`
	Dir              string   `json:"dir"`
	Content          *string  `json:"content"`
	Duration         *float64 `json:"duration"`
	Color            *string  `json:"color"`
	Blink            *bool    `json:"blink"`
	BlinkTitle       *string  `json:"blinkTitle"`
	NoticeColor      *string  `json:"noticeColor"`
	CatchLevel       *string  `json:"catchLevel"`
	ExpectedRevision *int64   `json:"expectedRevision"`
}

func (a *API) legacyBannerChange(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actor, ok := a.authorize(w, r, true)
		if !ok {
			return
		}
		var in legacyBannerInput
		if !decode(w, r, &in) {
			return
		}
		for _, color := range []*string{in.Color, in.NoticeColor} {
			if color != nil && *color != "" && !bannerColor.MatchString(*color) {
				legacyTradeError(w, 400, "颜色需为 #RGB 或 #RRGGBB 格式")
				return
			}
		}
		if in.Content != nil {
			v := bannerClip(*in.Content, 200)
			in.Content = &v
			if v == "" {
				legacyTradeError(w, 400, "横幅内容不能为空")
				return
			}
		}
		if in.Duration != nil && (*in.Duration < 1 || *in.Duration > 3600 || math.IsNaN(*in.Duration) || math.IsInf(*in.Duration, 0)) {
			legacyTradeError(w, 400, "时长需在 1-3600 秒之间")
			return
		}
		if action == "add" && (in.Content == nil || in.Duration == nil) {
			legacyTradeError(w, 400, "横幅内容和时长不能为空")
			return
		}
		if in.CatchLevel != nil && *in.CatchLevel != "gmax" && *in.CatchLevel != "gmax10" && *in.CatchLevel != "fish" && *in.CatchLevel != "fish10" {
			legacyTradeError(w, 400, "未知的上鱼通告横幅等级")
			return
		}
		ctx := r.Context()
		tx, err := a.pool.Begin(ctx)
		if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		state, err := readLegacyBanners(ctx, tx, true)
		if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		// Recheck after taking the shared head lock, including a revocation that
		// happened while this request was queued behind another operator.
		var authorized bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.auth_sessions s JOIN fishing.identities i ON i.account_id=s.account_id
 WHERE s.token_hash=$1 AND s.admin AND s.expires_at>clock_timestamp() AND i.admin AND NOT i.banned AND NOT i.retired)`, actor.Hash[:]).Scan(&authorized); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if !authorized {
			failure(w, identity.ErrCredentials)
			return
		}
		if in.ExpectedRevision != nil && *in.ExpectedRevision != state.Revision {
			legacyTradeError(w, 409, "banner_revision_changed")
			return
		}
		index := -1
		for i, b := range state.Banners {
			if b.ID == in.ID {
				index = i
				break
			}
		}
		if action != "add" && action != "cfg" && action != "clear" && index < 0 {
			legacyTradeError(w, 404, "横幅不存在")
			return
		}
		out := map[string]any{"ok": true}
		stops := []string{}
		removeWatch := []string{}
		switch action {
		case "add":
			if len(state.Banners) >= 500 {
				legacyTradeError(w, 400, "横幅队列已满（最多 500 条）")
				return
			}
			b := legacyBannerEntry{ID: "bn_" + randomStreamID(), Seq: state.Seq, Content: *in.Content, Duration: math.Round(*in.Duration*10) / 10, CreatedAt: timeNowMS(), By: actor.Name}
			if in.Color != nil {
				b.Color = *in.Color
			}
			state.Seq++
			state.Banners = append(state.Banners, b)
			out["banner"] = b
		case "update":
			b := &state.Banners[index]
			if in.Content != nil {
				b.Content = *in.Content
			}
			if in.Duration != nil {
				b.Duration = math.Round(*in.Duration*10) / 10
			}
			if in.Color != nil {
				b.Color = *in.Color
			}
			out["banner"] = *b
		case "remove":
			state.Banners = append(state.Banners[:index], state.Banners[index+1:]...)
			removeWatch = append(removeWatch, in.ID)
		case "move":
			if in.Dir != "up" && in.Dir != "down" {
				legacyTradeError(w, 400, "移动方向需为 up 或 down")
				return
			}
			j := index - 1
			if in.Dir == "down" {
				j = index + 1
			}
			if j < 0 || j >= len(state.Banners) {
				legacyTradeError(w, 400, "已经在队列端点")
				return
			}
			state.Banners[index], state.Banners[j] = state.Banners[j], state.Banners[index]
			for i := range state.Banners {
				state.Banners[i].Seq = int64(i + 1)
			}
			out["banners"] = state.Banners
		case "cfg":
			if in.Blink != nil {
				state.Cfg["blink"] = *in.Blink
			}
			if in.BlinkTitle != nil {
				state.Cfg["blinkTitle"] = bannerClip(*in.BlinkTitle, 40)
			}
			if in.NoticeColor != nil {
				state.Cfg["noticeColor"] = *in.NoticeColor
			}
			if in.CatchLevel != nil {
				state.Cfg["catchLevel"] = *in.CatchLevel
			}
			out["cfg"] = state.Cfg
		case "stop":
			stops = append(stops, in.ID)
			removeWatch = append(removeWatch, in.ID)
		case "clear":
			out["cleared"] = len(state.Banners)
			for _, b := range state.Banners {
				stops = append(stops, b.ID)
				removeWatch = append(removeWatch, b.ID)
			}
			state.Banners = []legacyBannerEntry{}
		default:
			failure(w, identity.ErrInvalid)
			return
		}
		frames := []map[string]any{}
		if action != "stop" {
			frames = append(frames, state.frame())
		}
		for _, id := range stops {
			frames = append(frames, map[string]any{"type": "bannerStop", "id": id})
		}
		state.Revision++
		out["revision"] = state.Revision
		banners, _ := json.Marshal(state.Banners)
		cfg, _ := json.Marshal(state.Cfg)
		events, _ := json.Marshal(frames)
		if _, err := tx.Exec(ctx, `UPDATE fishing.banner_state SET revision=$1,next_seq=$2,banners=$3,cfg=$4 WHERE singleton`, state.Revision, state.Seq, banners, cfg); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.banner_events(revision,frames) VALUES($1,$2)`, state.Revision, events); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM fishing.banner_watchers WHERE banner_id=ANY($1::text[])`, removeWatch); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err := legacyAdminAudit(ctx, tx, actor, "banner/"+action, nil, in.ID, fmt.Sprintf("revision=%d", state.Revision)); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			failure(w, identity.ErrCommitUnknown)
			return
		}
		write(w, 200, out)
	}
}

func (a *API) legacyBannerPlaying(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		ID string `json:"id"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT banners FROM fishing.banner_state WHERE singleton FOR SHARE`).Scan(&raw); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	var banners []legacyBannerEntry
	if json.Unmarshal(raw, &banners) != nil {
		failure(w, identity.ErrStorage)
		return
	}
	found := false
	for _, b := range banners {
		if b.ID == in.ID {
			found = true
			break
		}
	}
	if !found {
		write(w, 200, map[string]any{"ok": true, "ignored": true})
		return
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.banner_watchers(banner_id,owner_id) VALUES($1,$2)
 ON CONFLICT(banner_id,owner_id) DO UPDATE SET last_at=clock_timestamp()`, in.ID, session.AccountID); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true})
}

type legacyBannerPush struct {
	api      *API
	revision int64
	seeded   bool
	pending  []string
}

func (p *legacyBannerPush) init(ctx context.Context) map[string]any {
	if state, err := readLegacyBanners(ctx, p.api.pool, false); err == nil {
		p.revision, p.seeded = state.Revision, true
		p.pending = []string{legacyFrame(state.frame())}
	}
	return nil
}
func (p *legacyBannerPush) poll(ctx context.Context) []string {
	if !p.seeded {
		p.init(ctx)
	}
	out := p.pending
	p.pending = nil
	if !p.seeded {
		return out
	}
	rows, err := p.api.pool.Query(ctx, `SELECT revision,frames FROM fishing.banner_events WHERE revision>$1 ORDER BY revision LIMIT 16`, p.revision)
	if err != nil {
		return out
	}
	defer rows.Close()
	next := p.revision
	frames := []string{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&next, &raw); err != nil {
			return out
		}
		var list []map[string]any
		if json.Unmarshal(raw, &list) != nil {
			return out
		}
		for _, frame := range list {
			frames = append(frames, legacyFrame(frame))
		}
	}
	if rows.Err() != nil {
		return out
	}
	p.revision = next
	return append(out, frames...)
}
