package gateway

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/social"
	"fishing.local/server/internal/rules"
)

// Legacy friends and player-list bridge. The durable social module owns the
// reciprocal relationships; presence (online, fishing, location) is projected
// from the stream leases and the native fishing sessions.
//
// Every identity the original frontend exchanges here is the lowercase
// username: player ids, friend targets and the sea ground id
// ("sea:<owner>:<zone>") which the original server keyed by username while the
// durable model keys the zone owner by account id.
//
// Known degradation: POST /api/players/view cannot register an SSE viewport
// (the Go bridge has no per-stream view registry yet), so it acknowledges the
// request without pushing playersPage updates.

type legacyOnlinePlayer struct {
	AccountID    int64
	Key          string
	Name         string
	Status       string
	GroundID     string
	SpotID       string
	LocationName string
}

func (p legacyOnlinePlayer) view() map[string]any {
	return map[string]any{
		"id": p.Key, "name": p.Name, "status": p.Status,
		"groundId": p.GroundID, "spotId": p.SpotID,
		"recent": nil, "fishing": nil,
		"username": p.Key, "locationName": p.LocationName,
	}
}

// legacySession is the legacy 401 shape ("未登录") for the friend APIs.
func (a *API) legacySession(w http.ResponseWriter, r *http.Request) (identity.Session, bool) {
	session, err := a.optionalSession(r)
	if err != nil {
		write(w, 401, map[string]any{"error": "未登录"})
		return identity.Session{}, false
	}
	return session, true
}

type legacyGround struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Spots []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"spots"`
}

// legacyLocationName mirrors socialPlayerView: the map spot name for the world
// map, the ground name otherwise, the zone name for a shared voyage zone, and
// the original fallbacks.
func (a *API) legacyLocationName(ctx context.Context, c *rules.Catalog, players []legacyOnlinePlayer) (map[int64]string, error) {
	grounds := []legacyGround{}
	_ = c.Constant("GROUNDS", &grounds)
	byID := map[string]legacyGround{}
	for _, ground := range grounds {
		byID[ground.ID] = ground
	}
	// Shared voyage zones are keyed by account id internally but the original
	// contract exposes the owner's username.
	zoneOwners := map[int64]bool{}
	for _, player := range players {
		if !strings.HasPrefix(player.GroundID, "sea:") {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(player.GroundID, "sea:"), ":", 2)
		if len(parts) != 2 {
			continue
		}
		owner, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || owner < 1 {
			continue
		}
		zoneOwners[owner] = true
	}
	zoneNames := map[string]string{}
	if len(zoneOwners) > 0 {
		owners := make([]int64, 0, len(zoneOwners))
		for owner := range zoneOwners {
			owners = append(owners, owner)
		}
		rows, err := a.pool.Query(ctx, `SELECT owner_id,id,COALESCE(data->>'name','') FROM fishing.sea_zones WHERE owner_id=ANY($1::bigint[]) AND expires_at>clock_timestamp()`, owners)
		if err != nil {
			return nil, identity.ErrStorage
		}
		defer rows.Close()
		for rows.Next() {
			var owner int64
			var id, name string
			if err := rows.Scan(&owner, &id, &name); err != nil {
				return nil, identity.ErrStorage
			}
			zoneNames[strconv.FormatInt(owner, 10)+":"+id] = name
		}
		if err := rows.Err(); err != nil {
			return nil, identity.ErrStorage
		}
	}
	out := map[int64]string{}
	for _, player := range players {
		name := ""
		if strings.HasPrefix(player.GroundID, "sea:") {
			parts := strings.SplitN(strings.TrimPrefix(player.GroundID, "sea:"), ":", 2)
			if len(parts) == 2 {
				name = zoneNames[parts[0]+":"+parts[1]]
			}
		} else if ground, ok := byID[player.GroundID]; ok {
			name = ground.Name
			if ground.ID == "map" {
				for _, spot := range ground.Spots {
					if spot.ID == player.SpotID {
						name = spot.Name
						break
					}
				}
			}
		}
		if name == "" {
			if player.GroundID != "" {
				name = "未知钓点"
			} else {
				name = "未出发"
			}
		}
		out[player.AccountID] = name
	}
	return out, nil
}

// legacyOnlinePlayers lists every online account with its legacy presence row.
func (a *API) legacyOnlinePlayers(ctx context.Context) ([]legacyOnlinePlayer, error) {
	rows, err := a.pool.Query(ctx, `SELECT i.account_id,lower(i.username),i.display_name,
 COALESCE(s.state='active',false),COALESCE(s.ground_id,''),COALESCE(s.spot_id,'')
 FROM fishing.identities i
 JOIN (SELECT DISTINCT owner_id FROM fishing.gateway_streams WHERE expires_at>clock_timestamp()) g ON g.owner_id=i.account_id
 LEFT JOIN fishing.native_fishing_sessions s ON s.owner_id=i.account_id AND s.state='active'
 WHERE NOT i.banned`)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	out := []legacyOnlinePlayer{}
	for rows.Next() {
		var player legacyOnlinePlayer
		var fishing bool
		if err := rows.Scan(&player.AccountID, &player.Key, &player.Name, &fishing, &player.GroundID, &player.SpotID); err != nil {
			return nil, identity.ErrStorage
		}
		player.Status = "idle"
		if fishing {
			player.Status = "fishing"
		}
		out = append(out, player)
	}
	if err := rows.Err(); err != nil {
		return nil, identity.ErrStorage
	}
	return out, nil
}

// legacyGroundFilter converts the legacy sea ground id into the durable form.
func (a *API) legacyGroundFilter(ctx context.Context, ground string) (string, error) {
	if !strings.HasPrefix(ground, "sea:") {
		return ground, nil
	}
	parts := strings.SplitN(strings.TrimPrefix(ground, "sea:"), ":", 2)
	if len(parts) != 2 {
		return ground, nil
	}
	var owner int64
	if err := a.pool.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE lower(username)=$1`, strings.ToLower(parts[0])).Scan(&owner); err != nil {
		// An unknown owner cannot match any projected row.
		return "sea:-1:" + parts[1], nil
	}
	return "sea:" + strconv.FormatInt(owner, 10) + ":" + parts[1], nil
}

type legacyRelation struct {
	AccountID int64
	Key       string
	Name      string
	Kind      string // friend | in | out
}

func (a *API) legacyRelations(ctx context.Context, owner int64) ([]legacyRelation, error) {
	rows, err := a.pool.Query(ctx, `SELECT i.account_id,lower(i.username),i.display_name,r.kind
 FROM (SELECT CASE WHEN a_id=$1 THEN b_id ELSE a_id END AS target,
        CASE WHEN state='accepted' THEN 'friend' WHEN requester_id=$1 THEN 'out' ELSE 'in' END AS kind
       FROM fishing.friend_relations WHERE (a_id=$1 OR b_id=$1) AND state<>'none') r
 JOIN fishing.identities i ON i.account_id=r.target
 WHERE NOT i.banned
 ORDER BY r.target`, owner)
	if err != nil {
		return nil, identity.ErrStorage
	}
	defer rows.Close()
	out := []legacyRelation{}
	for rows.Next() {
		var relation legacyRelation
		if err := rows.Scan(&relation.AccountID, &relation.Key, &relation.Name, &relation.Kind); err != nil {
			return nil, identity.ErrStorage
		}
		out = append(out, relation)
	}
	if err := rows.Err(); err != nil {
		return nil, identity.ErrStorage
	}
	return out, nil
}

func legacyPlayerSort(players []legacyOnlinePlayer) {
	sort.SliceStable(players, func(i, j int) bool {
		left, right := players[i], players[j]
		if (left.Status == "fishing") != (right.Status == "fishing") {
			return left.Status == "fishing"
		}
		return strings.ToLower(left.Name) < strings.ToLower(right.Name)
	})
}

// legacyFriendRelations serves GET /api/friends/relations: the username lists
// the client caches for badges and trade targets.
func (a *API) legacyFriendRelations(w http.ResponseWriter, r *http.Request) {
	session, ok := a.legacySession(w, r)
	if !ok {
		return
	}
	relations, err := a.legacyRelations(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	friends, in, out := []string{}, []string{}, []string{}
	for _, relation := range relations {
		switch relation.Kind {
		case "friend":
			friends = append(friends, relation.Key)
		case "in":
			in = append(in, relation.Key)
		case "out":
			out = append(out, relation.Key)
		}
	}
	write(w, 200, map[string]any{"ok": true, "friends": friends, "in": in, "out": out})
}

// legacyFriendsView serves GET /api/friends: the friend list with presence, the
// pending requests and one page of online players for the add-friend search.
func (a *API) legacyFriendsView(w http.ResponseWriter, r *http.Request) {
	session, ok := a.legacySession(w, r)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	relations, err := a.legacyRelations(r.Context(), session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	online, err := a.legacyOnlinePlayers(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	locations, err := a.legacyLocationName(r.Context(), c, online)
	if err != nil {
		failure(w, err)
		return
	}
	onlineByID := map[int64]legacyOnlinePlayer{}
	players := []legacyOnlinePlayer{}
	for _, player := range online {
		player.LocationName = locations[player.AccountID]
		if rewritten, ok := a.legacySeaGround(r.Context(), player.GroundID); ok {
			player.GroundID = rewritten
		}
		onlineByID[player.AccountID] = player
		players = append(players, player)
	}
	friendKeys := map[string]bool{}
	reqIn, reqOut := []map[string]any{}, []map[string]any{}
	requestID := func(relation legacyRelation) map[string]any {
		_, isOnline := onlineByID[relation.AccountID]
		return map[string]any{"id": relation.Key, "name": relation.Name, "username": relation.Key, "online": isOnline}
	}
	friends := []map[string]any{}
	for _, relation := range relations {
		switch relation.Kind {
		case "friend":
			friendKeys[relation.Key] = true
			if player, isOnline := onlineByID[relation.AccountID]; isOnline {
				view := player.view()
				view["online"] = true
				friends = append(friends, view)
				continue
			}
			friends = append(friends, map[string]any{
				"id": relation.Key, "name": relation.Name, "username": relation.Key,
				"online": false, "status": "offline", "locationName": "离线",
			})
		case "in":
			if len(reqIn) < 50 {
				reqIn = append(reqIn, requestID(relation))
			}
		case "out":
			if len(reqOut) < 50 {
				reqOut = append(reqOut, requestID(relation))
			}
		}
	}
	sort.SliceStable(friends, func(i, j int) bool {
		left, right := friends[i], friends[j]
		if left["online"] != right["online"] {
			return left["online"] == true
		}
		return strings.ToLower(left["name"].(string)) < strings.ToLower(right["name"].(string))
	})
	inKeys, outKeys := map[string]bool{}, map[string]bool{}
	for _, relation := range relations {
		if relation.Kind == "in" {
			inKeys[relation.Key] = true
		}
		if relation.Kind == "out" {
			outKeys[relation.Key] = true
		}
	}
	keyword := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(keyword) > 40 {
		keyword = keyword[:40]
	}
	candidates := []legacyOnlinePlayer{}
	for _, player := range players {
		if player.AccountID == session.AccountID {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(player.Name), keyword) {
			continue
		}
		candidates = append(candidates, player)
	}
	legacyPlayerSort(candidates)
	size := 30
	pages := 1
	if len(candidates) > 0 {
		pages = (len(candidates) + size - 1) / size
	}
	page := legacyPageParam(r.URL.Query().Get("page"), pages)
	start := (page - 1) * size
	if start > len(candidates) {
		start = len(candidates)
	}
	end := start + size
	if end > len(candidates) {
		end = len(candidates)
	}
	listed := []map[string]any{}
	for _, player := range candidates[start:end] {
		view := player.view()
		view["friend"] = friendKeys[player.Key]
		view["reqIn"] = inKeys[player.Key]
		view["reqOut"] = outKeys[player.Key]
		listed = append(listed, view)
	}
	write(w, 200, map[string]any{
		"ok": true, "friends": friends, "page": page, "pages": pages, "total": len(candidates),
		"requests": map[string]any{"in": reqIn, "out": reqOut}, "players": listed,
	})
}

// legacySeaGround rewrites "sea:<accountId>:<zone>" into the legacy
// "sea:<username>:<zone>" the original frontend parses.
func (a *API) legacySeaGround(ctx context.Context, ground string) (string, bool) {
	if !strings.HasPrefix(ground, "sea:") {
		return ground, false
	}
	parts := strings.SplitN(strings.TrimPrefix(ground, "sea:"), ":", 2)
	if len(parts) != 2 {
		return ground, false
	}
	owner, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || owner < 1 {
		return ground, false
	}
	var key string
	if err := a.pool.QueryRow(ctx, `SELECT lower(username) FROM fishing.identities WHERE account_id=$1`, owner).Scan(&key); err != nil {
		return ground, false
	}
	return "sea:" + key + ":" + parts[1], true
}

func legacyPageParam(raw string, pages int) int {
	page := 1
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		page = value
	}
	if page > pages {
		page = pages
	}
	if page < 1 {
		page = 1
	}
	return page
}

// legacyFriendChange serves POST /api/friends.
func (a *API) legacyFriendChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.legacySession(w, r)
	if !ok {
		return
	}
	var in struct {
		Target string `json:"target"`
		Action string `json:"action"`
	}
	if !decode(w, r, &in) {
		return
	}
	action := in.Action
	if action == "add" {
		action = "request"
	}
	switch action {
	case "request", "accept", "reject", "cancel", "remove":
	default:
		write(w, 400, map[string]any{"error": "未知好友操作"})
		return
	}
	key := strings.ToLower(strings.TrimSpace(in.Target))
	if key == "" {
		write(w, 404, map[string]any{"error": "玩家不存在"})
		return
	}
	if key == session.Username {
		write(w, 400, map[string]any{"error": "不能添加自己为好友"})
		return
	}
	var target int64
	if err := a.pool.QueryRow(r.Context(), `SELECT account_id FROM fishing.identities WHERE lower(username)=$1`, key).Scan(&target); err != nil {
		write(w, 404, map[string]any{"error": "玩家不存在"})
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := social.New(a.pool).Friend(ctx, social.FriendCommand{
		ActorID: session.AccountID, TargetID: target, Action: action,
		RequestKey: legacyMarketKey("legacy:friend:" + action),
	})
	// Business rejections arrive as a terminal status (the durable command
	// boundary stores them), while a pre-flight rejection arrives as an error;
	// both share one vocabulary.
	failureMessage := func(code string) (int, string, bool) {
		switch code {
		case "friend_request_limit":
			return 400, "发出的好友请求过多（上限 50），请先撤回一些", true
		case "friend_limit":
			return 400, "好友数量已达上限（200）", true
		case "incoming_request_exists":
			return 400, "对方已向你发送好友请求，请在「好友请求」里同意", true
		case "friend_request_missing":
			if action == "cancel" {
				return 400, "没有待撤回的好友申请（可能已被对方处理）", true
			}
			return 400, "没有来自该玩家的好友请求", true
		case "feature_disabled":
			return 400, "该功能当前已关闭", true
		}
		return 0, "", false
	}
	if err != nil {
		var rejection assets.Rejection
		switch {
		case errors.As(err, &rejection):
			if status, message, known := failureMessage(string(rejection)); known {
				write(w, status, map[string]any{"error": message})
			} else {
				write(w, 400, map[string]any{"error": string(rejection)})
			}
		case errors.Is(err, assets.ErrInvalid):
			write(w, 400, map[string]any{"error": "未知好友操作"})
		default:
			write(w, 503, map[string]any{"error": "retry_same_request"})
		}
		return
	}
	switch res.Status {
	case "pending", "accepted", "rejected", "cancelled", "removed", "none":
		write(w, 200, map[string]any{"ok": true})
	default:
		if status, message, known := failureMessage(res.Status); known {
			write(w, status, map[string]any{"error": message})
			return
		}
		write(w, 400, map[string]any{"error": res.Status})
	}
}

// legacyPlayersPage serves GET /api/players/page.
func (a *API) legacyPlayersPage(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.legacySession(w, r); !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	online, err := a.legacyOnlinePlayers(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	locations, err := a.legacyLocationName(r.Context(), c, online)
	if err != nil {
		failure(w, err)
		return
	}
	size := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("size")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			size = value
		}
	}
	if size < 5 {
		size = 5
	}
	if size > 100 {
		size = 100
	}
	keyword := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(keyword) > 40 {
		keyword = keyword[:40]
	}
	ground, err := a.legacyGroundFilter(r.Context(), r.URL.Query().Get("ground"))
	if err != nil {
		failure(w, err)
		return
	}
	spot := r.URL.Query().Get("spot")
	totalOnline := len(online)
	filtered := []legacyOnlinePlayer{}
	for _, player := range online {
		if ground != "" && player.GroundID != ground {
			continue
		}
		if spot != "" && player.SpotID != spot {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(player.Name), keyword) {
			continue
		}
		player.LocationName = locations[player.AccountID]
		if rewritten, ok := a.legacySeaGround(r.Context(), player.GroundID); ok {
			player.GroundID = rewritten
		}
		filtered = append(filtered, player)
	}
	legacyPlayerSort(filtered)
	pages := 1
	if len(filtered) > 0 {
		pages = (len(filtered) + size - 1) / size
	}
	page := legacyPageParam(r.URL.Query().Get("page"), pages)
	start := (page - 1) * size
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + size
	if end > len(filtered) {
		end = len(filtered)
	}
	listed := []map[string]any{}
	for _, player := range filtered[start:end] {
		listed = append(listed, player.view())
	}
	write(w, 200, map[string]any{
		"ok": true, "page": page, "pages": pages, "size": size,
		"total": len(filtered), "totalOnline": totalOnline, "players": listed,
	})
}

// legacyPlayersView serves POST /api/players/view. The original client registers
// the viewport it is looking at so the server can push playersPage updates; the
// Go bridge has no per-stream view registry yet, so the request is validated and
// acknowledged without pushing (pushed stays 0 instead of claiming otherwise).
func (a *API) legacyPlayersView(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.legacySession(w, r); !ok {
		return
	}
	var in struct {
		Page   int    `json:"page"`
		Size   int    `json:"size"`
		Q      string `json:"q"`
		Ground string `json:"ground"`
		Spot   string `json:"spot"`
		Clear  bool   `json:"clear"`
	}
	if !decode(w, r, &in) {
		return
	}
	write(w, 200, map[string]any{"ok": true, "pushed": 0})
}

// legacyPlayersRod serves POST /api/players/rod: the read-only rod view of
// another online player, without exposing their inventory or coins.
func (a *API) legacyPlayersRod(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.legacySession(w, r); !ok {
		return
	}
	var in struct {
		Target string `json:"target"`
	}
	if !decode(w, r, &in) {
		return
	}
	key := strings.ToLower(strings.TrimSpace(in.Target))
	var target int64
	var name string
	if err := a.pool.QueryRow(r.Context(), `SELECT account_id,display_name FROM fishing.identities WHERE lower(username)=$1`, key).Scan(&target, &name); err != nil {
		write(w, 404, map[string]any{"error": "玩家不存在"})
		return
	}
	online, err := a.legacyTradeOnline(r.Context(), target)
	if err != nil {
		failure(w, err)
		return
	}
	if !online {
		write(w, 400, map[string]any{"error": "对方不在线"})
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	capacity := a.rodSlotCapacity(r.Context(), target)
	bd, _, _, rodName, _, err := a.legacyRod(r.Context(), c, target, capacity)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "name": name, "rodName": rodName, "bd": bd})
}
