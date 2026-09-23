package gateway

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/mail"
	"fishing.local/server/internal/rules"
)

func (a *API) legacyMail(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	if page > 100000 {
		page = 100000
	}
	view, err := mail.New(a.pool, nil).List(r.Context(), session.AccountID, page, r.URL.Query().Get("summary") == "1")
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	write(w, 200, view)
}
func (a *API) legacyMailChange(claim bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, ok := a.authorize(w, r, false)
		if !ok {
			return
		}
		var in struct {
			ID         string `json:"id"`
			RequestKey string `json:"requestKey"`
		}
		if !decode(w, r, &in) {
			return
		}
		id, _ := strconv.ParseInt(in.ID, 10, 64)
		c, err := a.catalog(r.Context())
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
		result, err := mail.New(a.pool, c).Change(ctx, session.AccountID, in.RequestKey, id, claim)
		if err != nil {
			assetResponse(w, assets.Result{}, err)
			return
		}
		if result.Status != "read" && result.Status != "claimed" {
			write(w, 400, map[string]any{"error": result.Status})
			return
		}
		write(w, 200, map[string]any{"ok": true, "result": result})
	}
}
func (a *API) adminMail(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if r.Method == http.MethodGet {
		target := r.URL.Query().Get("target")
		out := map[string]any{"items": c.Items}
		if target != "" {
			id, exists, err := a.legacyAdminTarget(r.Context(), target)
			if err != nil {
				assetResponse(w, assets.Result{}, err)
				return
			}
			if !exists {
				write(w, 404, map[string]any{"error": "账号不存在"})
				return
			}
			page, _ := strconv.Atoi(r.URL.Query().Get("page"))
			view, err := mail.New(a.pool, c).List(r.Context(), id, max(1, min(page, 100000)), false)
			if err != nil {
				assetResponse(w, assets.Result{}, err)
				return
			}
			out["inbox"] = view
		}
		write(w, 200, out)
		return
	}
	var in struct {
		mail.Send
		Target     string `json:"target"`
		RequestKey string `json:"requestKey"`
	}
	if !decode(w, r, &in) {
		return
	}
	id, exists, err := a.legacyAdminTarget(r.Context(), in.Target)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if !exists {
		write(w, 404, map[string]any{"error": "账号不存在"})
		return
	}
	in.Send.Target = id
	ctx := assets.WithSession(r.Context(), actor.AccountID, actor.Hash, true)
	result, err := mail.New(a.pool, c).Send(ctx, actor.AccountID, actor.Name, in.RequestKey, in.Send)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	if result.Status != "sent" {
		write(w, 400, map[string]any{"error": result.Status})
		return
	}
	write(w, 200, map[string]any{"ok": true, "result": result})
}

var customItemID = regexp.MustCompile(`^custom_[a-z0-9_]{1,40}$`)

func (a *API) adminMailItem(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	body, ok := decodeWorldBody(w, r)
	if !ok {
		return
	}
	var item rules.Item
	if json.Unmarshal(body["item"], &item) != nil || !customItemID.MatchString(item.ID) || strings.TrimSpace(item.Name) == "" || len([]rune(item.Name)) > 80 || len([]rune(item.Description)) > 500 || item.Price < 0 || item.Price > 1e9 || !map[string]bool{"common": true, "rare": true, "epic": true, "mythic": true}[item.Rarity] {
		write(w, 400, map[string]any{"error": "自定义材料信息无效"})
		return
	}
	// Custom materials use the ordinary inventory/catalog path and can be edited
	// later; arbitrary client definitions are never accepted by the claim API.
	item.Kind = "material"
	item.Part = ""
	item.Pool = nil
	item.Size = nil
	item.SetID = ""
	item.Legacy = false
	item.ExpeditionOnly = false
	c, rev, err := worldCurrent(r.Context(), a)
	if err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	found := false
	for i, v := range c.Items {
		if v.ID == item.ID {
			if v.Kind != "material" {
				write(w, 400, map[string]any{"error": "物品类型不可更改"})
				return
			}
			c.Items[i] = item
			found = true
		}
	}
	if !found {
		c.Items = append(c.Items, item)
	}
	var materials []map[string]any
	if err = c.Constant("MATERIALS", &materials); err != nil {
		assetResponse(w, assets.Result{}, err)
		return
	}
	raw, _ := json.Marshal(item)
	var entry map[string]any
	_ = json.Unmarshal(raw, &entry)
	found = false
	for i, v := range materials {
		if v["id"] == item.ID {
			materials[i] = entry
			found = true
		}
	}
	if !found {
		materials = append(materials, entry)
	}
	c.Constants["MATERIALS"], _ = json.Marshal(materials)
	if _, ok = worldPublish(a, w, r, actor, body, "/api/admin/mail/item", item.ID, c, rev); !ok {
		return
	}
	write(w, 200, map[string]any{"ok": true, "item": item})
}
