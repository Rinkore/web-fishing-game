// acceptance drives the isolated Go gateway over real HTTP and SSE. Database
// access is limited to fixture setup, observability, and reconciliation.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

type endpointStats struct {
	mu                                                             sync.Mutex
	latencies                                                      []float64
	requests, transportErrors, unexpectedErrors, businessResponses int64
	bytesIn, bytesOut                                              int64
}

type metrics struct {
	mu                                                    sync.Mutex
	endpoints                                             map[string]*endpointStats
	sseMessages, sseBytes, sseReconnects, retryRecoveries atomic.Int64
	notificationLagMu                                     sync.Mutex
	notificationLag                                       []float64
}

func newMetrics() *metrics { return &metrics{endpoints: map[string]*endpointStats{}} }
func (m *metrics) endpoint(name string) *endpointStats {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.endpoints[name]; s != nil {
		return s
	}
	s := &endpointStats{}
	m.endpoints[name] = s
	return s
}
func (m *metrics) record(name string, started time.Time, status int, in, out int64, transport bool) {
	s := m.endpoint(name)
	s.mu.Lock()
	s.requests++
	s.latencies = append(s.latencies, float64(time.Since(started).Microseconds())/1000)
	s.bytesIn += in
	s.bytesOut += out
	if transport {
		s.transportErrors++
	} else if status >= 500 {
		s.unexpectedErrors++
	} else if status >= 400 {
		s.businessResponses++
	}
	s.mu.Unlock()
}
func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	return values[int(float64(len(values)-1)*p)]
}
func (m *metrics) unexpectedTotal() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	var total int64
	for _, s := range m.endpoints {
		s.mu.Lock()
		total += s.unexpectedErrors
		s.mu.Unlock()
	}
	return total
}
func (m *metrics) snapshot() map[string]any {
	m.mu.Lock()
	names := make([]string, 0, len(m.endpoints))
	for name := range m.endpoints {
		names = append(names, name)
	}
	sort.Strings(names)
	out := map[string]any{}
	for _, name := range names {
		s := m.endpoints[name]
		s.mu.Lock()
		lat := append([]float64(nil), s.latencies...)
		out[name] = map[string]any{"requests": s.requests, "transportErrors": s.transportErrors, "unexpectedErrors": s.unexpectedErrors, "businessResponses4xx": s.businessResponses, "p50Ms": percentile(append([]float64(nil), lat...), .50), "p95Ms": percentile(append([]float64(nil), lat...), .95), "p99Ms": percentile(append([]float64(nil), lat...), .99), "bytesIn": s.bytesIn, "bytesOut": s.bytesOut}
		s.mu.Unlock()
	}
	m.mu.Unlock()
	m.notificationLagMu.Lock()
	lag := append([]float64(nil), m.notificationLag...)
	m.notificationLagMu.Unlock()
	return map[string]any{"http": out, "sse": map[string]any{"messages": m.sseMessages.Load(), "bytes": m.sseBytes.Load(), "reconnects": m.sseReconnects.Load()}, "notificationLagMs": map[string]any{"p95": percentile(append([]float64(nil), lag...), .95), "samples": len(lag)}, "retryRecoveries": m.retryRecoveries.Load()}
}

func numberValue(value any) (float64, bool) {
	switch n := value.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case float64:
		return n, true
	default:
		return 0, false
	}
}

func performanceThresholds(snapshot map[string]any) map[string]any {
	httpStats, _ := snapshot["http"].(map[string]any)
	maxP95 := func(selectName func(string) bool) (float64, string, int) {
		var max float64
		name := ""
		requests := 0
		for endpoint, raw := range httpStats {
			if !selectName(endpoint) {
				continue
			}
			stat, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			p95, ok := numberValue(stat["p95Ms"])
			if !ok {
				continue
			}
			count, _ := numberValue(stat["requests"])
			if count > 0 && (name == "" || p95 > max) {
				max, name, requests = p95, endpoint, int(count)
			}
		}
		return max, name, requests
	}
	readP95, readEndpoint, readRequests := maxP95(func(name string) bool {
		return strings.Contains(name, ".read.") || strings.HasPrefix(name, "legacy.read.")
	})
	writeP95, writeEndpoint, writeRequests := maxP95(func(name string) bool {
		return strings.Contains(name, ".rod") || strings.Contains(name, ".market.list") || strings.Contains(name, ".market.buy") || strings.Contains(name, ".chest") || (strings.Contains(name, ".autosell") && !strings.Contains(name, ".read.")) || strings.Contains(name, ".sell") || strings.Contains(name, "legacy.autosell.write")
	})
	lag, _ := snapshot["notificationLagMs"].(map[string]any)
	lagP95, _ := numberValue(lag["p95"])
	lagSamples, _ := numberValue(lag["samples"])
	return map[string]any{
		"readP95Ms":            map[string]any{"value": readP95, "limit": 200, "endpoint": readEndpoint, "requests": readRequests, "status": readRequests > 0 && readP95 <= 200},
		"assetWriteP95Ms":      map[string]any{"value": writeP95, "limit": 300, "endpoint": writeEndpoint, "requests": writeRequests, "status": writeRequests > 0 && writeP95 <= 300},
		"schedulingP95Ms":      map[string]any{"value": nil, "limit": 100, "status": "not-measured", "reason": "scheduler dispatch timestamps are not exposed by the current HTTP/SSE harness"},
		"notificationLagP95Ms": map[string]any{"value": lagP95, "limit": 500, "samples": int(lagSamples), "status": lagSamples > 0 && lagP95 <= 500},
		"overall":              readRequests > 0 && readP95 <= 200 && writeRequests > 0 && writeP95 <= 300 && lagSamples > 0 && lagP95 <= 500,
	}
}

type player struct {
	index                     int
	username, password, token string
	accountID                 int64
	equipmentID               atomic.Int64
	generation                atomic.Int64
	lastEventID               atomic.Int64
}

type acceptance struct {
	baseURL                            string
	players, seconds                   int
	runID, outputDir                   string
	pool                               *pgxpool.Pool
	httpClient                         *http.Client
	sseClient                          *http.Client
	metrics                            *metrics
	all                                []*player
	materialID, chestID                string
	equipmentDefinition, equipmentPart string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance failed:", err)
		os.Exit(1)
	}
}

func numberEnv(name string, def, lo, hi int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		return 0, fmt.Errorf("invalid %s: must be %d..%d", name, lo, hi)
	}
	return n, nil
}
func jsonBody(v any) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}
func decodeObject(data []byte) map[string]any {
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		return map[string]any{}
	}
	return out
}

type registrationChallenge struct {
	ID         string `json:"id"`
	Prefix     string `json:"prefix"`
	Difficulty int    `json:"difficulty"`
}

func solveRegistrationChallenge(c registrationChallenge) string {
	for nonce := int64(0); nonce <= 100000000; nonce++ {
		sum := sha256.Sum256([]byte(c.Prefix + ":" + strconv.FormatInt(nonce, 10)))
		if c.Difficulty <= 0 || (c.Difficulty == 4 && sum[0] == 0 && sum[1] == 0) {
			return strconv.FormatInt(nonce, 10)
		}
	}
	return ""
}

func urlQueryEscape(value string) string {
	var b strings.Builder
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.~:", c) {
			b.WriteRune(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (a *acceptance) request(ctx context.Context, p *player, method, path, class string, body any) (int, []byte, error) {
	payload, err := jsonBody(body)
	if err != nil {
		return 0, nil, err
	}
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, method, a.baseURL+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		a.metrics.record(class, started, 0, int64(len(payload)), 0, true)
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	a.metrics.record(class, started, resp.StatusCode, int64(len(payload)), int64(len(data)), readErr != nil)
	if readErr != nil {
		return resp.StatusCode, data, readErr
	}
	return resp.StatusCode, data, nil
}
func (a *acceptance) get(ctx context.Context, p *player, path, class string) (int, map[string]any, error) {
	s, data, err := a.request(ctx, p, http.MethodGet, path, class, nil)
	return s, decodeObject(data), err
}
func (a *acceptance) post(ctx context.Context, p *player, path, class, key string, body map[string]any) (int, map[string]any, error) {
	s, data, err := a.request(ctx, p, http.MethodPost, path, class, body)
	if err == nil || key == "" {
		return s, decodeObject(data), err
	}
	// A transport failure is an unknown commit result. Query the durable result
	// first, then retry the exact payload once. Legacy calls never enter here.
	lookupStatus, lookup, lookupErr := a.get(ctx, p, "/api/v1/operation?key="+urlQueryEscape(key), "v1.operation.recovery")
	if lookupErr == nil && lookupStatus == http.StatusOK && lookup["operationId"] != nil {
		a.metrics.retryRecoveries.Add(1)
		return lookupStatus, lookup, nil
	}
	if lookupErr == nil && lookupStatus != http.StatusNotFound {
		return lookupStatus, lookup, nil
	}
	retryStatus, retryData, retryErr := a.request(ctx, p, http.MethodPost, path, "v1.retry."+strings.TrimPrefix(path, "/api/v1/"), body)
	if retryErr == nil {
		a.metrics.retryRecoveries.Add(1)
	}
	return retryStatus, decodeObject(retryData), retryErr
}

func (a *acceptance) register(ctx context.Context, i int) (*player, error) {
	suffix := a.runID
	if len(suffix) > 8 {
		suffix = suffix[len(suffix)-8:]
	}
	suffix = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, suffix)
	username := fmt.Sprintf("l%s%05d", suffix, i)
	password := "Synthetic-Load-42"
	body := map[string]any{"username": username, "password": password, "confirmPassword": password, "name": fmt.Sprintf("Load %04d", i), "qq": fmt.Sprintf("%06d", 100000+i%899999)}
	postRegister := func(input map[string]any) (int, []byte, error) {
		payload, _ := json.Marshal(input)
		started := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/api/register", bytes.NewReader(payload))
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := a.httpClient.Do(req)
		if err != nil {
			a.metrics.record("setup.register", started, 0, int64(len(payload)), 0, true)
			return 0, nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		a.metrics.record("setup.register", started, resp.StatusCode, int64(len(payload)), int64(len(data)), readErr != nil)
		return resp.StatusCode, data, readErr
	}
	status, data, err := postRegister(body)
	if err != nil {
		return nil, err
	}
	if status == http.StatusForbidden && decodeObject(data)["code"] == "REGISTRATION_CHALLENGE" {
		challengeReq, e := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/api/register/challenge", nil)
		if e != nil {
			return nil, e
		}
		challengeResp, e := a.httpClient.Do(challengeReq)
		if e != nil {
			return nil, e
		}
		challengeData, e := io.ReadAll(io.LimitReader(challengeResp.Body, 1<<20))
		challengeResp.Body.Close()
		if e != nil || challengeResp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("registration challenge failed: %d %v", challengeResp.StatusCode, e)
		}
		var challenge registrationChallenge
		if e := json.Unmarshal(challengeData, &challenge); e != nil {
			return nil, e
		}
		nonce := solveRegistrationChallenge(challenge)
		if nonce == "" {
			return nil, errors.New("registration challenge could not be solved")
		}
		body["proof"] = map[string]any{"id": challenge.ID, "nonce": nonce}
		status, data, err = postRegister(body)
		if err != nil {
			return nil, err
		}
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("registration %s returned %d: %s", username, status, string(data))
	}
	obj := decodeObject(data)
	token, _ := obj["token"].(string)
	if token == "" {
		return nil, fmt.Errorf("registration %s returned no token", username)
	}
	var id int64
	if err := a.pool.QueryRow(ctx, "SELECT account_id FROM fishing.identities WHERE username=$1", strings.ToLower(username)).Scan(&id); err != nil {
		return nil, err
	}
	return &player{index: i, username: username, password: password, token: token, accountID: id}, nil
}

func (a *acceptance) seed(ctx context.Context) error {
	var material, chest, equipment, part string
	if err := a.pool.QueryRow(ctx, `SELECT id FROM fishing.item_definitions WHERE kind='material' ORDER BY id LIMIT 1`).Scan(&material); err != nil {
		return fmt.Errorf("catalog has no material: %w", err)
	}
	if err := a.pool.QueryRow(ctx, `SELECT id FROM fishing.item_definitions WHERE kind='chest' ORDER BY id LIMIT 1`).Scan(&chest); err != nil {
		return fmt.Errorf("catalog has no chest: %w", err)
	}
	_ = a.pool.QueryRow(ctx, `SELECT id,part FROM fishing.item_definitions WHERE kind='equipment' ORDER BY id,part LIMIT 1`).Scan(&equipment, &part)
	a.materialID, a.chestID, a.equipmentDefinition, a.equipmentPart = material, chest, equipment, part
	for _, p := range a.all {
		change := assets.Change{ActorID: p.accountID, RequestKey: fmt.Sprintf("acceptance:seed:%s:%d", a.runID, p.index), Reason: "reward", RuleVersion: "v0.21.4", Coins: 100000, Stacks: []assets.StackDelta{{ItemID: material, Tier: "normal", Quantity: 1000}, {ItemID: chest, Tier: "normal", Quantity: 5}}}
		if equipment != "" {
			change.Create = []assets.EquipmentSpec{{DefinitionID: equipment, Part: part, Attributes: json.RawMessage(`{"quality":"rare","affixes":[]}`)}}
		}
		result, err := assets.New(a.pool).ApplyChange(ctx, change)
		if err != nil || result.Status != "applied" {
			return fmt.Errorf("fixture seed for player %d failed: %v", p.index, err)
		}
		if len(result.EquipmentIDs) > 0 {
			id, _ := strconv.ParseInt(result.EquipmentIDs[0], 10, 64)
			p.equipmentID.Store(id)
		}
	}
	return nil
}

func (a *acceptance) sse(ctx context.Context, p *player) {
	for ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.baseURL+"/api/v1/events", nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+p.token)
		if last := p.lastEventID.Load(); last > 0 {
			req.Header.Set("Last-Event-ID", strconv.FormatInt(last, 10))
		}
		started := time.Now()
		resp, err := a.sseClient.Do(req)
		if err != nil {
			a.metrics.sseReconnects.Add(1)
			if ctx.Err() == nil {
				time.Sleep(100 * time.Millisecond)
			}
			continue
		}
		a.metrics.record("sse.handshake", started, resp.StatusCode, 0, 0, false)
		if resp.StatusCode >= 400 {
			resp.Body.Close()
			a.metrics.sseReconnects.Add(1)
			if ctx.Err() == nil {
				time.Sleep(100 * time.Millisecond)
			}
			continue
		}
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		var frameBytes int64
		for scanner.Scan() && ctx.Err() == nil {
			line := scanner.Text()
			frameBytes += int64(len(line) + 1)
			if strings.HasPrefix(line, "id: ") {
				if id, e := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "id: ")), 10, 64); e == nil {
					p.lastEventID.Store(id)
					var lag float64
					if e := a.pool.QueryRow(ctx, `SELECT COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-o.created_at)*1000,0) FROM fishing.player_events pe JOIN fishing.outbox_events o ON o.id=pe.outbox_id WHERE pe.owner_id=$1 AND pe.revision=$2`, p.accountID, id).Scan(&lag); e == nil {
						a.metrics.notificationLagMu.Lock()
						a.metrics.notificationLag = append(a.metrics.notificationLag, lag)
						a.metrics.notificationLagMu.Unlock()
					}
				}
			}
			if line == "" {
				a.metrics.sseMessages.Add(1)
				a.metrics.sseBytes.Add(frameBytes)
				frameBytes = 0
			}
		}
		resp.Body.Close()
		if frameBytes > 0 {
			a.metrics.sseBytes.Add(frameBytes)
		}
		if ctx.Err() == nil {
			a.metrics.sseReconnects.Add(1)
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func (a *acceptance) action(ctx context.Context, p *player, tick int) {
	key := fmt.Sprintf("load:%s:%d:%d", a.runID, p.index, tick)
	if tick == 0 {
		status, obj, _ := a.post(ctx, p, "/api/v1/presence", "v1.presence", key+":connect", map[string]any{"action": "connect", "requestKey": key + ":connect"})
		_ = status
		if generation, ok := obj["generation"].(string); ok {
			if n, e := strconv.ParseInt(generation, 10, 64); e == nil {
				p.generation.Store(n)
			}
		}
		_, _, _ = a.request(ctx, p, http.MethodPost, "/api/fishing/start", "legacy.fishing.start", map[string]any{"groundId": "map", "spotId": "dock"})
		return
	}
	if tick%5 == 0 {
		body := map[string]any{"action": "heartbeat", "requestKey": key + ":presence", "generation": strconv.FormatInt(p.generation.Load(), 10)}
		status, obj, _ := a.post(ctx, p, "/api/v1/presence", "v1.presence", body["requestKey"].(string), body)
		if generation, ok := obj["generation"].(string); ok {
			if n, e := strconv.ParseInt(generation, 10, 64); e == nil {
				p.generation.Store(n)
			}
		}
		if status == 409 {
			_, obj, _ = a.post(ctx, p, "/api/v1/presence", "v1.presence.reconnect", key+":reconnect", map[string]any{"action": "connect", "requestKey": key + ":reconnect"})
			if generation, ok := obj["generation"].(string); ok {
				if n, e := strconv.ParseInt(generation, 10, 64); e == nil {
					p.generation.Store(n)
				}
			}
		}
	}
	if tick%10 == 0 {
		_, _, _ = a.get(ctx, p, "/api/v1/me", "v1.read.me")
		_, _, _ = a.get(ctx, p, "/api/v1/assets?limit=50", "v1.read.assets")
	}
	if tick%20 == 0 {
		_, _, _ = a.get(ctx, p, "/api/market", "legacy.read.market")
		_, _, _ = a.get(ctx, p, "/api/autosell", "legacy.read.autosell")
	}
	choice := (tick + p.index*17) % 100
	switch {
	case choice < 5:
		id := p.equipmentID.Load()
		_, _, _ = a.post(ctx, p, "/api/v1/rod/change", "v1.rod", key+":rod", map[string]any{"requestKey": key + ":rod", "action": "equip", "part": a.equipmentPart, "equipmentId": strconv.FormatInt(id, 10), "slot": 0})
	case choice < 7:
		if len(a.all) > 1 {
			peer := a.all[(p.index+1)%len(a.all)]
			_, _, _ = a.post(ctx, p, "/api/v1/trade/invite", "v1.trade", key+":trade", map[string]any{"requestKey": key + ":trade", "targetId": strconv.FormatInt(peer.accountID, 10)})
		}
	case choice < 12:
		_, _, _ = a.post(ctx, p, "/api/v1/market/list", "v1.market.list", key+":list", map[string]any{"requestKey": key + ":list", "itemId": a.materialID, "quantity": 1, "unitPrice": 10, "hours": 6})
	case choice < 17:
		_, obj, _ := a.get(ctx, p, "/api/v1/market?limit=1", "v1.market.read")
		if items, ok := obj["items"].([]any); ok && len(items) > 0 {
			if order, ok := items[0].(map[string]any)["id"].(string); ok {
				_, _, _ = a.post(ctx, p, "/api/v1/market/buy", "v1.market.buy", key+":buy", map[string]any{"requestKey": key + ":buy", "orderId": order, "quantity": 1, "expectedUnitPrice": 10})
			}
		}
	case choice < 20:
		_, _, _ = a.post(ctx, p, "/api/v1/chest", "v1.chest", key+":chest", map[string]any{"requestKey": key + ":chest", "action": "open", "chestId": a.chestID})
	case choice < 30:
		_, _, _ = a.post(ctx, p, "/api/v1/autosell/run", "v1.autosell", key+":autosell", map[string]any{"requestKey": key + ":autosell"})
	case choice < 35:
		_, _, _ = a.post(ctx, p, "/api/v1/sell", "v1.sell", key+":sell", map[string]any{"requestKey": key + ":sell", "itemId": a.materialID, "tier": "normal", "quantity": 1})
	case choice < 40:
		_, _, _ = a.request(ctx, p, http.MethodPost, "/api/autosell", "legacy.autosell.write", map[string]any{"id": a.materialID, "on": true, "keep": 1})
	case choice < 45:
		_, _, _ = a.request(ctx, p, http.MethodPost, "/api/fishing/stop", "legacy.fishing.stop", map[string]any{})
		_, _, _ = a.request(ctx, p, http.MethodPost, "/api/fishing/start", "legacy.fishing.restart", map[string]any{"groundId": "map", "spotId": "dock"})
	default:
		_, _, _ = a.get(ctx, p, "/api/me", "legacy.read.me")
	}
}

func (a *acceptance) sample(ctx context.Context, stop <-chan struct{}, file *os.File) {
	interval := 5
	if raw := os.Getenv("FISHING_GO_ACCEPTANCE_SAMPLE_INTERVAL_SECONDS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			interval = n
		}
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	enc := json.NewEncoder(file)
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			var active, waiting, locks int64
			_ = a.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event IS NOT NULL`).Scan(&waiting)
			_ = a.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()`).Scan(&active)
			_ = a.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname=current_database() AND NOT l.granted`).Scan(&locks)
			var dbBytes int64
			var walStart string
			var commits, rollbacks int64
			_ = a.pool.QueryRow(ctx, `SELECT pg_database_size(current_database()),pg_current_wal_lsn()::text`).Scan(&dbBytes, &walStart)
			_ = a.pool.QueryRow(ctx, `SELECT xact_commit,xact_rollback FROM pg_stat_database WHERE datname=current_database()`).Scan(&commits, &rollbacks)
			_ = enc.Encode(map[string]any{"at": time.Now().UTC().Format(time.RFC3339Nano), "activeSessions": active, "waitEvents": waiting, "ungrantedLocks": locks, "databaseBytes": dbBytes, "walLSN": walStart, "commits": commits, "rollbacks": rollbacks})
			_ = file.Sync()
		}
	}
}

func fingerprint(ctx context.Context, p *pgxpool.Pool) (string, error) {
	var snapshot string
	err := p.QueryRow(ctx, `SELECT json_build_object(
 'wallets',(SELECT COALESCE(json_agg(row_to_json(x) ORDER BY account_id),'[]') FROM (SELECT account_id,coins FROM fishing.wallets)x),
 'stacks',(SELECT COALESCE(json_agg(row_to_json(x) ORDER BY owner_id,item_id,tier),'[]') FROM (SELECT owner_id,item_id,tier,quantity FROM fishing.inventory_stacks)x),
 'equipment',(SELECT COALESCE(json_agg(row_to_json(x) ORDER BY id),'[]') FROM (SELECT id,owner_id,definition_id,part,lifecycle,escrow_order_id FROM fishing.equipment_instances)x),
 'orders',(SELECT COALESCE(json_agg(row_to_json(x) ORDER BY id),'[]') FROM (SELECT id,seller_id,kind,item_id,quantity,remaining,state FROM fishing.market_orders)x),
 'trades',(SELECT COALESCE(json_agg(row_to_json(x) ORDER BY id),'[]') FROM (SELECT id,a_id,b_id,state,revision,a_confirm,b_confirm FROM fishing.trades)x),
 'counts',json_build_object('commands',(SELECT count(*) FROM fishing.command_results),'operations',(SELECT count(*) FROM fishing.asset_operations),'outbox',(SELECT count(*) FROM fishing.outbox_events),'events',(SELECT count(*) FROM fishing.player_events),'nativeSettlements',(SELECT count(*) FROM fishing.native_fishing_settlements)))::text`).Scan(&snapshot)
	if err != nil {
		return "", errors.New("cannot compute durable fingerprint")
	}
	h := sha256.Sum256([]byte(snapshot))
	return hex.EncodeToString(h[:]), nil
}

func reconcile(ctx context.Context, p *pgxpool.Pool) error {
	var differences int64
	query := `SELECT
 (SELECT count(*) FROM fishing.wallets w WHERE w.coins<>COALESCE((SELECT sum(delta) FROM fishing.asset_entries e WHERE e.account_id=w.account_id),0))+
 (SELECT count(*) FROM fishing.inventory_stacks s WHERE s.quantity<>COALESCE((SELECT sum(delta) FROM fishing.inventory_entries e WHERE (e.owner_id,e.item_id,e.tier)=(s.owner_id,s.item_id,s.tier)),0))+
 (SELECT count(*) FROM fishing.rod_components c LEFT JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE e.id IS NULL OR e.owner_id<>c.owner_id OR e.lifecycle<>'available')+
 (SELECT count(*) FROM fishing.equipment_instances e WHERE e.lifecycle='escrow' AND e.escrow_order_id IS NULL)+
 (SELECT count(*) FROM fishing.market_orders o WHERE (o.state='open')<>(o.remaining>0) OR (o.state='open')<>(o.closed_operation IS NULL))+
 (SELECT count(*) FROM fishing.trades t WHERE (t.state='done')<>(t.settled_operation IS NOT NULL))+
 (SELECT count(*) FROM fishing.asset_operations a WHERE NOT EXISTS(SELECT 1 FROM fishing.outbox_events o WHERE o.operation_id=a.id))+
 (SELECT count(*) FROM fishing.player_events e WHERE NOT EXISTS(SELECT 1 FROM fishing.outbox_events o WHERE o.id=e.outbox_id))`
	if err := p.QueryRow(ctx, query).Scan(&differences); err != nil {
		return fmt.Errorf("reconciliation query failed: %w", err)
	}
	if differences != 0 {
		return fmt.Errorf("reconciliation differences: %d", differences)
	}
	return nil
}

// reconcileAfterRecovery gives a deliberately bounded window for a database
// restart to finish accepting connections. A single connection-refused result
// at the end of a faulted load is transport state, not a reconciliation
// finding; once the database is available, the same invariant query is still
// required to pass without weakening its result.
func reconcileAfterRecovery(parent context.Context, p *pgxpool.Pool) error {
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	backoff := 250 * time.Millisecond
	for {
		if err := p.Ping(ctx); err == nil {
			err = reconcile(ctx, p)
			if err == nil || strings.HasPrefix(err.Error(), "reconciliation differences:") {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("database recovery reconciliation timeout: %w", ctx.Err())
		case <-time.After(backoff):
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}
func durability(ctx context.Context, p *pgxpool.Pool) map[string]string {
	out := map[string]string{}
	var fsync, fullPageWrites, synchronousCommit string
	_ = p.QueryRow(ctx, `SELECT current_setting('fsync'),current_setting('full_page_writes'),current_setting('synchronous_commit')`).Scan(&fsync, &fullPageWrites, &synchronousCommit)
	out["fsync"], out["fullPageWrites"], out["synchronousCommit"] = fsync, fullPageWrites, synchronousCommit
	return out
}
func writeJSON(path string, value any) error {
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func (a *acceptance) runLoad(ctx context.Context) (map[string]any, error) {
	work, cancel := context.WithTimeout(ctx, time.Duration(a.seconds)*time.Second)
	defer cancel()
	stopSample := make(chan struct{})
	var sampleFile *os.File
	if a.outputDir != "" {
		_ = os.MkdirAll(a.outputDir, 0755)
		f, err := os.OpenFile(filepath.Join(a.outputDir, "db-samples.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			return nil, err
		}
		sampleFile = f
		go a.sample(work, stopSample, f)
	}
	var wg sync.WaitGroup
	for _, p := range a.all {
		p := p
		wg.Add(1)
		go func() { defer wg.Done(); a.sse(work, p) }()
	}
	started := time.Now()
	for _, p := range a.all {
		p := p
		wg.Add(1)
		go func() {
			defer wg.Done()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			tick := 0
			for {
				select {
				case <-work.Done():
					return
				case <-ticker.C:
					a.action(work, p, tick)
					tick++
				}
			}
		}()
	}
	for {
		if work.Err() != nil {
			break
		}
		timer := time.NewTimer(10 * time.Second)
		select {
		case <-work.Done():
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
			if a.outputDir != "" {
				_ = writeJSON(filepath.Join(a.outputDir, "progress.json"), map[string]any{"elapsedSeconds": time.Since(started).Seconds(), "targetSeconds": a.seconds, "metrics": a.metrics.snapshot()})
			}
		}
	}
	close(stopSample)
	wg.Wait()
	if sampleFile != nil {
		_ = sampleFile.Close()
	}
	if marker := os.Getenv("FISHING_GO_ACCEPTANCE_LOAD_COMPLETE_FILE"); marker != "" {
		if err := writeJSON(marker, map[string]any{"at": time.Now().UTC().Format(time.RFC3339Nano), "players": a.players, "targetSeconds": a.seconds}); err != nil {
			return nil, fmt.Errorf("write load-complete marker: %w", err)
		}
		quiesce := os.Getenv("FISHING_GO_ACCEPTANCE_QUIESCE_FILE")
		if quiesce != "" {
			waitCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
			defer cancel()
			for {
				if _, err := os.Stat(quiesce); err == nil {
					break
				}
				select {
				case <-waitCtx.Done():
					return nil, fmt.Errorf("quiesce barrier timeout: %w", waitCtx.Err())
				case <-time.After(100 * time.Millisecond):
				}
			}
		}
	}
	metricSnapshot := a.metrics.snapshot()
	result := map[string]any{"phase": "run", "scope": "formal HTTP/SSE gameplay load; synthetic isolated accounts", "players": a.players, "seconds": time.Since(started).Seconds(), "targetSeconds": a.seconds, "cpus": runtime.NumCPU(), "candidateSHA": os.Getenv("FISHING_GO_ACCEPTANCE_CANDIDATE_SHA"), "metrics": metricSnapshot, "thresholds": performanceThresholds(metricSnapshot), "durability": durability(ctx, a.pool)}
	if err := reconcileAfterRecovery(ctx, a.pool); err != nil {
		result["reconciliation"] = map[string]any{"status": "failed", "error": err.Error()}
		return result, err
	}
	result["reconciliation"] = map[string]any{"status": "passed", "differences": 0}
	hash, err := fingerprint(ctx, a.pool)
	if err != nil {
		return result, err
	}
	result["fingerprint"] = hash
	if _, err := a.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.acceptance_checkpoint(id integer PRIMARY KEY,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())`); err != nil {
		return result, fmt.Errorf("write acceptance checkpoint schema: %w", err)
	}
	if _, err := a.pool.Exec(ctx, `INSERT INTO public.acceptance_checkpoint(id,fingerprint) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,created_at=clock_timestamp()`, hash); err != nil {
		return result, fmt.Errorf("write acceptance checkpoint: %w", err)
	}
	if a.metrics.unexpectedTotal() > 0 && os.Getenv("FISHING_GO_ACCEPTANCE_FAULT_MODE") == "none" {
		return result, errors.New("unexpected HTTP 5xx or transport errors observed")
	}
	return result, nil
}

func run() error {
	ctx := context.Background()
	players, err := numberEnv("FISHING_GO_ACCEPTANCE_PLAYERS", 100, 1, 5000)
	if err != nil {
		return err
	}
	seconds, err := numberEnv("FISHING_GO_ACCEPTANCE_SECONDS", 7200, 5, 7*24*3600)
	if err != nil {
		return err
	}
	base := strings.TrimRight(os.Getenv("FISHING_GO_ACCEPTANCE_BASE_URL"), "/")
	if base == "" {
		return errors.New("FISHING_GO_ACCEPTANCE_BASE_URL is required for formal HTTP/SSE acceptance")
	}
	config, err := pgxpool.ParseConfig(os.Getenv("FISHING_GO_ACCEPTANCE_URL"))
	if err != nil || config.ConnConfig.Database != "fishing_acceptance" {
		return errors.New("requires isolated fishing_acceptance database")
	}
	config.MaxConns = 32
	config.ConnConfig.RuntimeParams["synchronous_commit"] = "on"
	config.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	p, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return errors.New("database unavailable")
	}
	defer p.Close()
	if err := p.Ping(ctx); err != nil {
		return err
	}
	if err := migrations.Apply(ctx, p); err != nil {
		return err
	}
	if os.Getenv("FISHING_GO_ACCEPTANCE_PHASE") == "verify" {
		if err := reconcile(ctx, p); err != nil {
			return err
		}
		actual, err := fingerprint(ctx, p)
		if err != nil {
			return err
		}
		var expected string
		if err := p.QueryRow(ctx, `SELECT fingerprint FROM public.acceptance_checkpoint WHERE id=1`).Scan(&expected); err != nil {
			return fmt.Errorf("durability checkpoint unavailable: %w", err)
		}
		if actual != expected {
			return fmt.Errorf("committed data changed after database crash: expected=%s actual=%s", expected, actual)
		}
		report := os.Getenv("FISHING_GO_ACCEPTANCE_REPORT")
		if report == "" && os.Getenv("FISHING_GO_ACCEPTANCE_OUTPUT_DIR") != "" {
			report = filepath.Join(os.Getenv("FISHING_GO_ACCEPTANCE_OUTPUT_DIR"), "acceptance-run.json")
		}
		return writeJSON(report, map[string]any{"phase": "verify", "databaseCrashRecovery": "passed", "reconciliationDifferences": 0, "fingerprint": actual, "candidateSHA": os.Getenv("FISHING_GO_ACCEPTANCE_CANDIDATE_SHA")})
	}
	var count int64
	if err := p.QueryRow(ctx, `SELECT count(*) FROM fishing.accounts`).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("formal acceptance requires a fresh synthetic database")
	}
	runID := os.Getenv("FISHING_GO_ACCEPTANCE_RUN_ID")
	if runID == "" {
		runID = strconv.FormatInt(time.Now().Unix(), 10)
	}
	a := &acceptance{baseURL: base, players: players, seconds: seconds, runID: runID, outputDir: os.Getenv("FISHING_GO_ACCEPTANCE_OUTPUT_DIR"), pool: p, httpClient: &http.Client{Timeout: 15 * time.Second}, metrics: newMetrics()}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 15 * time.Second
	a.sseClient = &http.Client{Transport: transport}
	a.all = make([]*player, 0, players)
	for i := 0; i < players; i++ {
		player, err := a.register(ctx, i)
		if err != nil {
			return err
		}
		a.all = append(a.all, player)
	}
	if err := a.seed(ctx); err != nil {
		return err
	}
	result, err := a.runLoad(ctx)
	report := os.Getenv("FISHING_GO_ACCEPTANCE_REPORT")
	if report == "" && a.outputDir != "" {
		report = filepath.Join(a.outputDir, "acceptance-run.json")
	}
	if report != "" {
		_ = writeJSON(report, result)
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return err
}
