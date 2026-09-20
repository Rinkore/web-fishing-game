// Package gateway exposes authenticated HTTP contracts; internal asset plans
// and prototype reward configuration are never accepted from clients.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"fishing.local/server/internal/modules/identity"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type API struct {
	pool     *pgxpool.Pool
	identity *identity.Service
	mu       sync.Mutex
	limits   map[string]bucket
	streams  chan struct{}
	location *time.Location
}
type bucket struct {
	start time.Time
	count int
}

func New(pool *pgxpool.Pool, mfaKey []byte, locations ...*time.Location) http.Handler {
	a := &API{pool: pool, identity: identity.New(pool, mfaKey), limits: map[string]bucket{}, streams: make(chan struct{}, 128)}
	a.location = time.Local
	if len(locations) > 0 && locations[0] != nil {
		a.location = locations[0]
	}
	r := chi.NewRouter()
	r.Use(a.security)
	r.Post("/api/register", a.register)
	r.Post("/api/login", a.login)
	r.Post("/api/admin/login", a.login)
	r.Post("/api/logout", a.logout)
	r.Post("/api/admin/logout", a.logout)
	r.Get("/api/admin/session", a.adminSession)
	r.Post("/api/admin/v1/features", a.publishFeatures)
	r.Get("/api/admin/v1/catalog", a.catalogView)
	r.Post("/api/admin/v1/catalog", a.catalogPublish)
	r.Get("/api/v1/features", a.features)
	r.Get("/api/version", a.legacyVersion)
	r.Get("/api/me", a.legacyMe)
	r.Get("/api/grounds", a.legacyGrounds)
	r.Get("/api/codex", a.legacyCodex)
	r.Get("/api/features", a.legacyFeatures)
	r.Get("/api/banner", a.legacyBanner)
	r.Get("/api/records", a.legacyRecords)
	r.Get("/api/records/top", a.legacyRecordsTop)
	r.Get("/shop", a.legacyShop)
	r.Get("/api/shop/history", a.legacyShopHistory)
	r.Post("/api/sell", a.legacySell)
	r.Get("/api/mall", a.legacyMall)
	r.Get("/api/autosell", a.legacyAutoSell)
	r.Post("/api/autosell", a.legacyAutoSellSet)
	r.Post("/api/mall/buy", a.legacyMallBuy)
	r.Post("/api/bd/set", a.legacyBdSet)
	r.Get("/events", a.legacyEvents)
	r.Post("/api/fishing/start", a.legacyFishingStart)
	r.Post("/api/fishing/stop", a.legacyFishingStop)
	// v1 routes explicitly expose the new contract until legacy frontend parity is verified.
	r.Get("/api/v1/me", a.me)
	r.Get("/api/v1/assets", a.assets)
	r.Get("/api/v1/codex", a.codex)
	r.Get("/api/v1/sea", a.seaView)
	r.Post("/api/v1/sea", a.seaChange)
	r.Post("/api/v1/sea/voyage", a.voyage)
	r.Post("/api/v1/sea/anchor", a.anchor)
	r.Post("/api/v1/sea/quests", a.quests)
	r.Post("/api/v1/sea/quest/claim", a.questClaim)
	r.Get("/api/v1/events", a.events)
	r.Post("/api/v1/presence", a.presence)
	r.Post("/api/v1/trade/invite", a.invite)
	r.Post("/api/v1/trade/change", a.tradeChange)
	r.Get("/api/v1/trade", a.tradeView)
	r.Post("/api/v1/market/list", a.marketList)
	r.Post("/api/v1/market/buy", a.marketBuy)
	r.Post("/api/v1/market/cancel", a.marketCancel)
	r.Get("/api/v1/market", a.marketOpen)
	r.Get("/api/v1/market/history", a.marketHistory)
	r.Post("/api/v1/rod/change", a.rodChange)
	r.Get("/api/v1/operation", a.operation)
	r.Post("/api/v1/workshop", a.workshop)
	r.Post("/api/v1/chest", a.chest)
	r.Get("/api/v1/mall", a.mallView)
	r.Post("/api/v1/mall/buy", a.mallBuy)
	r.Get("/api/v1/friends", a.friends)
	r.Post("/api/v1/friends", a.friendChange)
	r.Get("/api/v1/party", a.partyView)
	r.Post("/api/v1/party", a.partyChange)
	r.Get("/api/v1/party/events", a.partyEvents)
	r.Post("/api/v1/sell", a.sell)
	r.Post("/api/v1/sell/equipment", a.sellEquipment)
	r.Post("/api/v1/autosell", a.autosellConfigure)
	r.Post("/api/v1/autosell/run", a.autosellRun)
	r.Get("/api/v1/shop", a.shopPrices)
	r.Get("/api/v1/autosell", a.autosellSettings)
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { write(w, 404, map[string]any{"error": "not_found"}) })
	return r
}
func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	status := 503
	code := "unavailable"
	switch {
	case errors.Is(err, identity.ErrInvalid):
		status = 400
		code = "invalid_input"
	case errors.Is(err, identity.ErrCredentials):
		status = 401
		code = "invalid_credentials"
	case errors.Is(err, identity.ErrExists):
		status = 409
		code = "username_exists"
	case errors.Is(err, identity.ErrBanned):
		status = 403
		code = "account_banned"
	case errors.Is(err, identity.ErrForbidden):
		status = 403
		code = "admin_required"
	case errors.Is(err, identity.ErrMFASetup):
		status = 403
		code = "MFA_SETUP_REQUIRED"
	case errors.Is(err, identity.ErrBusy):
		status = 429
		code = "rate_limited"
	case errors.Is(err, identity.ErrCommitUnknown):
		code = "commit_unknown"
	}
	write(w, status, map[string]any{"error": code, "code": code})
}
func (a *API) limited(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	b := a.limits[host]
	if now.Sub(b.start) >= time.Minute {
		b = bucket{start: now}
	}
	if len(a.limits) >= 10000 {
		for k, v := range a.limits {
			if now.Sub(v.start) >= time.Minute {
				delete(a.limits, k)
			}
		}
		if _, ok := a.limits[host]; !ok && len(a.limits) >= 10000 {
			return true
		}
	}
	b.count++
	a.limits[host] = b
	return b.count > 30
}
func (a *API) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != scheme+"://"+r.Host {
			write(w, 403, map[string]any{"error": "origin_rejected"})
			return
		}
		if r.Method == http.MethodPost {
			if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" {
				write(w, 415, map[string]any{"error": "json_required"})
				return
			}
			if r.Header.Get("Authorization") == "" && (r.Header.Get("Cookie") != "" || r.Header.Get("X-Session-Mode") == "cookie") && r.Header.Get("X-Requested-With") != "FishGame" {
				write(w, 403, map[string]any{"error": "csrf_rejected"})
				return
			}
		}
		if strings.HasSuffix(r.URL.Path, "/login") || r.URL.Path == "/api/register" {
			if a.limited(r) {
				failure(w, identity.ErrBusy)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		failure(w, identity.ErrInvalid)
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		failure(w, identity.ErrInvalid)
		return false
	}
	return true
}
func cookieName(r *http.Request, admin bool) string {
	name := "fish_game"
	if admin {
		name = "fish_admin"
	}
	if r.TLS != nil {
		name = "__Host-" + name
	}
	return name
}
func token(r *http.Request, admin bool) string {
	if values, exists := r.Header["Authorization"]; exists {
		if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
			return ""
		}
		return strings.TrimPrefix(values[0], "Bearer ")
	}
	cookies := r.CookiesNamed(cookieName(r, admin))
	if len(cookies) != 1 {
		return ""
	}
	return cookies[0].Value
}
func setCookie(w http.ResponseWriter, r *http.Request, admin bool, value string, clear bool) {
	age := 86400
	if clear {
		age = -1
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName(r, admin), Value: value, Path: "/", MaxAge: age, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
}
func loginResponse(w http.ResponseWriter, r *http.Request, result identity.LoginResult) {
	value := result.Token
	if r.Header.Get("X-Session-Mode") == "cookie" {
		setCookie(w, r, result.Session.Admin, value, false)
		value = "cookie"
	}
	write(w, 200, map[string]any{"ok": true, "token": value, "username": result.Session.Username, "name": result.Session.Name, "admin": result.Session.Admin})
}
func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var in identity.Registration
	if !decode(w, r, &in) {
		return
	}
	result, err := a.identity.Register(r.Context(), in)
	if err != nil {
		failure(w, err)
		return
	}
	loginResponse(w, r, result)
}
func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in identity.Login
	if !decode(w, r, &in) {
		return
	}
	in.Admin = strings.HasPrefix(r.URL.Path, "/api/admin/")
	result, err := a.identity.Login(r.Context(), in)
	if err != nil {
		failure(w, err)
		return
	}
	loginResponse(w, r, result)
}
func (a *API) authorize(w http.ResponseWriter, r *http.Request, admin bool) (identity.Session, bool) {
	session, err := a.identity.Authenticate(r.Context(), token(r, admin), admin)
	if err != nil {
		failure(w, err)
		return identity.Session{}, false
	}
	return session, true
}
func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	admin := strings.HasPrefix(r.URL.Path, "/api/admin/")
	session, ok := a.authorize(w, r, admin)
	if !ok {
		return
	}
	if err := a.identity.Logout(r.Context(), session); err != nil {
		failure(w, err)
		return
	}
	setCookie(w, r, admin, "", true)
	write(w, 200, map[string]any{"ok": true})
}
func (a *API) adminSession(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	write(w, 200, map[string]any{"ok": true, "username": session.Username, "name": session.Name})
}
func (a *API) me(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var coins, revision int64
	var capacity int
	if err := a.pool.QueryRow(r.Context(), `SELECT w.coins,p.assets_rev,p.rod_capacity FROM fishing.player_state p JOIN fishing.wallets w ON w.account_id=p.account_id WHERE p.account_id=$1`, session.AccountID).Scan(&coins, &revision, &capacity); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"id": strconv.FormatInt(session.AccountID, 10), "username": session.Username, "name": session.Name, "coins": coins, "assetsRev": strconv.FormatInt(revision, 10), "rodCapacity": capacity})
}
func timeout(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), 5*time.Second)
}
