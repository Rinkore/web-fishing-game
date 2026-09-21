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
	"sync/atomic"
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
	// started and the counters behind the console overview and netstats panels.
	// The original tracked the same numbers in process memory; they reset on
	// restart here too.
	started      time.Time
	apiReqs      atomic.Int64
	apiBytes     atomic.Int64
	sseMsgs      atomic.Int64
	sseWrites    atomic.Int64
	sseBytes     atomic.Int64
	regAttempts  atomic.Int64
	regCreated   atomic.Int64
	regRejected  atomic.Int64
	regDuplicate atomic.Int64
	regLimited   atomic.Int64
	// views holds the legacy player-list viewports registered through
	// POST /api/players/view, keyed by account. It is per-process state: the
	// single-role deployment is the supported layout, a multi-process split
	// would need to share it.
	viewMu sync.Mutex
	views  map[int64]legacyPlayersView
}
type bucket struct {
	start time.Time
	count int
}

func New(pool *pgxpool.Pool, mfaKey []byte, locations ...*time.Location) http.Handler {
	a := &API{pool: pool, identity: identity.New(pool, mfaKey), limits: map[string]bucket{}, streams: make(chan struct{}, 128), views: map[int64]legacyPlayersView{}, started: time.Now()}
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
	r.Post("/api/rod/slot/buy", a.legacyRodSlotBuy)
	r.Post("/api/rod/save", a.legacyRodSave)
	r.Post("/api/rod/name", a.legacyRodName)
	r.Post("/api/rod/rename", a.legacyRodRename)
	r.Post("/api/rod/use", a.legacyRodUse)
	r.Post("/api/rod/stow", a.legacyRodStow)
	r.Post("/api/rod/delete", a.legacyRodDelete)
	r.Post("/api/profile", a.legacyProfileSave)
	r.Post("/api/banner/playing", a.legacyBannerPlaying)
	r.Get("/api/sea", a.legacySea)
	r.Post("/api/sea/ship/up", a.legacySeaAction("ship"))
	r.Post("/api/sea/chart", a.legacySeaAction("chart"))
	r.Post("/api/sea/voyage", a.legacySeaAction("voyage"))
	r.Post("/api/sea/anchor", a.legacySeaAction("anchor"))
	r.Post("/api/sea/quest/claim", a.legacySeaAction("quest"))
	r.Get("/api/party", a.legacyParty)
	r.Post("/api/party", a.legacyPartyChange)
	r.Get("/api/chest", a.legacyChest)
	r.Post("/api/chest/craft", a.legacyChestCraft)
	r.Post("/api/chest/open", a.legacyChestOpen)
	r.Get("/api/market", a.legacyMarket)
	r.Get("/api/market/history", a.legacyMarketHistory)
	r.Post("/api/market/list", a.legacyMarketList)
	r.Post("/api/market/buy", a.legacyMarketBuy)
	r.Post("/api/market/cancel", a.legacyMarketCancel)
	r.Get("/api/workshop", a.legacyWorkshop)
	r.Post("/api/workshop/smelt", a.legacyWorkshopSmelt)
	r.Post("/api/workshop/recast", a.legacyWorkshopRecast)
	r.Post("/api/workshop/forge", a.legacyWorkshopForge)
	r.Post("/api/trade/invite", a.legacyTradeInvite)
	r.Post("/api/trade/respond", a.legacyTradeRespond)
	r.Post("/api/trade/set", a.legacyTradeSet)
	r.Post("/api/trade/confirm", a.legacyTradeConfirm)
	r.Post("/api/trade/cancel", a.legacyTradeCancel)
	r.Get("/api/subscribe", a.legacySubscribeGet)
	r.Post("/api/subscribe", a.legacySubscribeSet)
	r.Get("/api/feedback", a.legacyFeedbackGet)
	r.Post("/api/feedback/submit", a.legacyFeedbackSubmit)
	r.Post("/api/feedback/skip", a.legacyFeedbackSkip)
	r.Get("/api/friends/relations", a.legacyFriendRelations)
	r.Get("/api/friends", a.legacyFriendsView)
	r.Post("/api/friends", a.legacyFriendChange)
	r.Get("/api/players/page", a.legacyPlayersPage)
	r.Post("/api/players/view", a.legacyPlayersView)
	r.Post("/api/players/rod", a.legacyPlayersRod)
	r.Get("/api/admin/overview", a.legacyAdminOverview)
	r.Get("/api/admin/stats", a.legacyAdminStats)
	r.Get("/api/admin/netstats", a.legacyAdminNetstats)
	r.Get("/api/admin/security", a.legacyAdminSecurity)
	r.Get("/api/admin/registration/stats", a.legacyAdminRegistrationStats)
	r.Get("/api/admin/users", a.legacyAdminUsers)
	r.Post("/api/admin/users/update", a.legacyAdminUserUpdate)
	r.Post("/api/admin/users/ban", a.legacyAdminUserBan)
	r.Post("/api/admin/users/setadmin", a.legacyAdminUserSetAdmin)
	r.Post("/api/admin/users/delete", a.legacyAdminUserDelete)
	r.Get("/api/admin/feedback", a.legacyAdminFeedback)
	r.Post("/api/admin/feedback/status", a.legacyAdminFeedbackStatus)
	r.Post("/api/admin/feedback/del", a.legacyAdminFeedbackDelete)
	r.Post("/api/admin/feedback/reward", a.legacyAdminFeedbackReward)
	r.Post("/api/admin/feedback/cfg", a.legacyAdminFeedbackConfig)
	r.Get("/api/admin/banner", a.legacyAdminBanner)
	r.Get("/api/admin/parties", a.legacyAdminParties)
	r.Post("/api/admin/party/disband", a.legacyAdminPartyDisband)
	r.Post("/api/admin/banner/add", a.legacyBannerChange("add"))
	r.Post("/api/admin/banner/remove", a.legacyBannerChange("remove"))
	r.Post("/api/admin/banner/move", a.legacyBannerChange("move"))
	r.Post("/api/admin/banner/cfg", a.legacyBannerChange("cfg"))
	r.Post("/api/admin/banner/update", a.legacyBannerChange("update"))
	r.Post("/api/admin/banner/stop", a.legacyBannerChange("stop"))
	r.Post("/api/admin/banner/clear", a.legacyBannerChange("clear"))
	r.Get("/api/wiki/content", a.legacyWikiContent)
	r.Get("/api/wiki/guides", a.legacyWikiGuides)
	r.Get("/api/wiki/guides/session", a.legacyWikiGuideSession)
	r.Get("/api/wiki/guides/{id}", a.legacyWikiGuideDetail)
	r.Get("/api/wiki/simulator/inventory", a.legacyWikiSimulatorInventory)
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
		// The console netstats panel reports API traffic; SSE responses are
		// counted per frame by the stream handlers instead.
		if r.URL.Path != "/events" && r.URL.Path != "/api/v1/events" {
			a.apiReqs.Add(1)
			counter := &legacyCountingWriter{ResponseWriter: w}
			w = counter
			defer func() { a.apiBytes.Add(counter.written) }()
		}
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
				if r.URL.Path == "/api/register" {
					a.regLimited.Add(1)
				}
				failure(w, identity.ErrBusy)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// legacyCountingWriter tallies response bytes for the console netstats panel.
// Unwrap keeps http.ResponseController (write deadlines and flushing) working
// for the SSE handlers.
type legacyCountingWriter struct {
	http.ResponseWriter
	written int64
}

func (w *legacyCountingWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.written += int64(n)
	return n, err
}

func (w *legacyCountingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
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
	a.regAttempts.Add(1)
	var in identity.Registration
	if !decode(w, r, &in) {
		a.regRejected.Add(1)
		return
	}
	result, err := a.identity.Register(r.Context(), in)
	if err != nil {
		a.regRejected.Add(1)
		if errors.Is(err, identity.ErrExists) {
			a.regDuplicate.Add(1)
		}
		failure(w, err)
		return
	}
	a.regCreated.Add(1)
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
