// Package migration imports a versioned, offline legacy snapshot into a new
// PostgreSQL database. It deliberately separates scanning, staging and writes:
// the runtime never runs DDL and every source payload remains auditable.
package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/legacy"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const ToolVersion = "go-legacy-import/0.1"

var ErrBlocked = errors.New("legacy snapshot has blocking migration gaps")

type Options struct {
	Root          string
	SourceVersion string
	RunID         string
	FailAfter     int // test/drill fault injection; zero means disabled
}

type Result struct {
	RunID      string   `json:"runId"`
	State      string   `json:"state"`
	Manifest   string   `json:"manifestSha256"`
	Accounts   int      `json:"accounts"`
	Entities   int      `json:"entities"`
	Gaps       []Gap    `json:"gaps"`
	Reconciled bool     `json:"reconciled"`
	Sessions   string   `json:"sessionPolicy"`
	Diffs      []string `json:"diffs,omitempty"`
}

type Gap struct {
	Domain   string `json:"domain"`
	Entity   string `json:"entity"`
	Code     string `json:"code"`
	Detail   string `json:"detail"`
	Blocking bool   `json:"blocking"`
}

type entity struct {
	domain, key, sha string
	payload          map[string]any
}

type snapshot struct {
	report   *legacy.Report
	entities []entity
	accounts []entity
}

// Import performs an all-or-nothing import. The schema must already be at the
// binary's migration head; this function never creates or changes schema.
func Import(ctx context.Context, pool *pgxpool.Pool, opt Options) (res Result, retErr error) {
	if strings.TrimSpace(opt.Root) == "" || strings.TrimSpace(opt.SourceVersion) == "" {
		return Result{}, errors.New("snapshot and source version are required")
	}
	s, err := load(opt.Root, opt.SourceVersion)
	if err != nil {
		return Result{}, err
	}
	runID := opt.RunID
	if runID == "" {
		runID = deterministicRunID(s.report.ManifestHash, opt.SourceVersion)
	}
	res = Result{RunID: runID, Manifest: s.report.ManifestHash, Accounts: len(s.accounts), Sessions: "all legacy sessions are discarded; users must log in again"}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return res, err
	}
	defer func() {
		if retErr != nil {
			_ = tx.Rollback(context.Background())
			_, _ = pool.Exec(context.Background(), `INSERT INTO fishing.migration_runs(id,source_version,snapshot_sha256,tool_version,state,error,finished_at)
VALUES($1,$2,$3,$4,'failed',$5,clock_timestamp())
ON CONFLICT(id) DO UPDATE SET state='failed',error=EXCLUDED.error,finished_at=EXCLUDED.finished_at`, runID, opt.SourceVersion, s.report.ManifestHash, ToolVersion, retErr.Error())
			for _, gap := range res.Gaps {
				_, _ = pool.Exec(context.Background(), `INSERT INTO fishing.migration_gaps(run_id,domain,entity_key,code,detail,blocking)
VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, runID, gap.Domain, gap.Entity, gap.Code, gap.Detail, gap.Blocking)
			}
			return
		}
		_ = tx.Rollback(context.Background())
	}()
	var state string
	var storedManifest string
	err = tx.QueryRow(ctx, `SELECT state,snapshot_sha256 FROM fishing.migration_runs WHERE id=$1`, runID).Scan(&state, &storedManifest)
	if err == nil {
		if storedManifest != s.report.ManifestHash {
			return res, fmt.Errorf("run id already belongs to another snapshot")
		}
		if state == "imported" || state == "reconciled" {
			res.State = state
			res.Reconciled = state == "reconciled"
			if err := tx.Commit(ctx); err != nil {
				return res, err
			}
			return res, nil
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return res, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.migration_runs(id,source_version,snapshot_sha256,tool_version,state)
VALUES ($1,$2,$3,$4,'running')
ON CONFLICT (id) DO UPDATE SET state='running',error='',started_at=clock_timestamp()`, runID, opt.SourceVersion, s.report.ManifestHash, ToolVersion); err != nil {
		return res, err
	}
	for i, e := range s.entities {
		if opt.FailAfter > 0 && i >= opt.FailAfter {
			return res, fmt.Errorf("injected failure after %d entities", opt.FailAfter)
		}
		body, _ := json.Marshal(e.payload)
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.migration_entities(run_id,domain,entity_key,source_sha256,payload,status)
VALUES ($1,$2,$3,$4,$5,'staged') ON CONFLICT (run_id,domain,entity_key) DO UPDATE
SET source_sha256=EXCLUDED.source_sha256,payload=EXCLUDED.payload,status='staged',issue=''`, runID, e.domain, e.key, e.sha, body); err != nil {
			return res, err
		}
	}
	ids := map[string]int64{}
	kinds, err := importCatalog(ctx, tx, s.entities)
	if err != nil {
		_ = markFailed(ctx, tx, runID, err)
		return res, err
	}
	for _, e := range s.accounts {
		id, err := importAccount(ctx, tx, runID, e, kinds)
		if err != nil {
			_ = markFailed(ctx, tx, runID, err)
			return res, err
		}
		ids[accountKey(e)] = id
		if legacyID := stringValue(e.payload, "id"); legacyID != "" {
			ids[strings.ToLower(legacyID)] = id
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.legacy_id_map(run_id,domain,legacy_id,new_id) VALUES($1,'account',$2,$3) ON CONFLICT DO NOTHING`, runID, legacyID, strconv.FormatInt(id, 10)); err != nil {
				return res, err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.legacy_id_map(run_id,domain,legacy_id,new_id) VALUES($1,'account',$2,$3) ON CONFLICT DO NOTHING`, runID, e.key, strconv.FormatInt(id, 10)); err != nil {
			return res, err
		}
		if err := markEntity(ctx, tx, runID, e.domain, e.key, "imported", ""); err != nil {
			return res, err
		}
	}
	if err := importMarkets(ctx, tx, runID, s.entities, ids); err != nil {
		_ = markFailed(ctx, tx, runID, err)
		return res, err
	}
	if err := importWiki(ctx, tx, runID, s.entities, ids); err != nil {
		_ = markFailed(ctx, tx, runID, err)
		return res, err
	}
	res.Gaps = append(res.Gaps, unsupportedGaps(s.entities)...)
	for _, g := range res.Gaps {
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.migration_gaps(run_id,domain,entity_key,code,detail,blocking)
VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, runID, g.Domain, g.Entity, g.Code, g.Detail, g.Blocking); err != nil {
			return res, err
		}
	}
	blocking := false
	for _, g := range res.Gaps {
		if g.Blocking {
			blocking = true
			break
		}
	}
	if blocking {
		_ = markFailed(ctx, tx, runID, ErrBlocked)
		res.State = "failed"
		return res, ErrBlocked
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.migration_entities SET status='reconciled' WHERE run_id=$1 AND status IN ('staged','imported')`, runID); err != nil {
		return res, err
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.migration_runs SET state='reconciled',finished_at=clock_timestamp() WHERE id=$1`, runID); err != nil {
		return res, err
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	res.State, res.Reconciled = "reconciled", true
	res.Entities = len(s.entities)
	return res, nil
}

func load(root, version string) (snapshot, error) {
	report, err := legacy.Scan(root, version)
	if err != nil {
		return snapshot{}, err
	}
	if len(report.Issues) > 0 {
		return snapshot{}, fmt.Errorf("snapshot scan found %d blocking findings", len(report.Issues))
	}
	s := snapshot{report: report}
	paths := map[string][]string{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr == nil && info != nil && !info.IsDir() && filepath.Ext(path) == ".json" {
			if h, err := fileHash(path); err == nil {
				paths[h] = append(paths[h], path)
			}
		}
		return nil
	})
	used := map[string]bool{}
	rootNames := map[string][]string{
		"market": {"market.json"}, "records": {"records.json"}, "economy": {"economy.json"}, "config": {"config.json"},
		"feedback": {"feedback.json"}, "stats": {"stats.json"}, "admin": {"admin.json"}, "legacy-users": {"users.json"},
		"legacy-world": {"world.json"}, "legacy-wiki": {"wiki.json", "wiki-guides.json"},
	}
	for _, f := range report.Files {
		var rel string
		candidates := paths[f.SHA256]
		if names, ok := rootNames[f.Domain]; ok {
			candidates = nil
			for _, name := range names {
				candidates = append(candidates, filepath.Join(root, name))
			}
		} else if f.Domain == "account" {
			candidates = nil
			_ = filepath.Walk(filepath.Join(root, "accounts"), func(path string, info os.FileInfo, walkErr error) error {
				if walkErr == nil && info != nil && !info.IsDir() && filepath.Ext(path) == ".json" {
					candidates = append(candidates, path)
				}
				return nil
			})
		}
		for _, p := range candidates {
			if used[p] {
				continue
			}
			if h, err := fileHash(p); err == nil && h == f.SHA256 {
				rel = p
				used[p] = true
				break
			}
		}
		if rel == "" {
			if f.Domain == "wiki-sqlite" {
				s.entities = append(s.entities, entity{f.Domain, f.Ref, f.SHA256, map[string]any{"ref": f.Ref, "sha256": f.SHA256}})
			} else {
				return snapshot{}, fmt.Errorf("snapshot changed or file cannot be resolved for %s", f.Ref)
			}
			continue
		}
		value, err := readObject(rel)
		if err != nil {
			return snapshot{}, fmt.Errorf("%s: %w", f.Domain, err)
		}
		key := filepath.Base(rel)
		if f.Domain == "account" {
			key = strings.TrimSuffix(key, filepath.Ext(key))
			s.accounts = append(s.accounts, entity{"account", key, f.SHA256, value})
		}
		s.entities = append(s.entities, entity{f.Domain, key, f.SHA256, value})
	}
	sort.Slice(s.entities, func(i, j int) bool {
		if s.entities[i].domain == s.entities[j].domain {
			return s.entities[i].key < s.entities[j].key
		}
		return s.entities[i].domain < s.entities[j].domain
	})
	return s, nil
}

func readObject(path string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	dec := json.NewDecoder(io.LimitReader(f, legacy.MaxJSONBytes+1))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("expected JSON object")
	}
	return m, nil
}

func fileHash(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func deterministicRunID(manifest, version string) string {
	h := sha256.Sum256([]byte(version + "\x00" + manifest))
	h[6] = (h[6] & 0x0f) | 0x50
	h[8] = (h[8] & 0x3f) | 0x80
	b := hex.EncodeToString(h[:])
	return b[:8] + "-" + b[8:12] + "-" + b[12:16] + "-" + b[16:20] + "-" + b[20:]
}

func accountKey(e entity) string { return strings.ToLower(e.key) }

func importAccount(ctx context.Context, tx pgx.Tx, runID string, e entity, kinds map[string]string) (int64, error) {
	m := e.payload
	username := strings.ToLower(stringValue(m, "username"))
	if username == "" {
		username = strings.ToLower(e.key)
	}
	display := stringValue(m, "displayName")
	if display == "" {
		display = stringValue(m, "name")
	}
	if display == "" {
		display = username
	}
	qq := stringValue(m, "qq")
	hash := stringValue(m, "pwHash")
	if hash == "" {
		hash = stringValue(m, "passwordHash")
	}
	if qq == "" || hash == "" {
		return 0, fmt.Errorf("account %s missing credential or qq", e.key)
	}
	coins, ok := integer(m["coins"])
	if !ok || coins.Sign() < 0 || !coins.IsInt64() {
		return 0, fmt.Errorf("account %s has invalid coins", e.key)
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.accounts DEFAULT VALUES RETURNING id`).Scan(&id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.player_state(account_id) VALUES($1)`, id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,$2)`, id, coins.Int64()); err != nil {
		return 0, err
	}
	admin := boolValue(m, "admin")
	banned := boolValue(m, "banned")
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,legacy_salt,banned,admin,mfa_secret)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)`, id, username, display, qq, hash, stringValue(m, "salt"), banned, admin); err != nil {
		return 0, err
	}
	request := "migration:" + runID + ":" + e.key
	rh := sha256.Sum256([]byte(request))
	body := map[string]any{"source": "legacy", "legacyId": e.key, "coins": coins.String()}
	raw, _ := json.Marshal(body)
	var op int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,$4) RETURNING actor_id`, id, request, rh[:], raw).Scan(new(int64)); err != nil {
		return 0, err
	}
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,'asset_change',$3) RETURNING id`, id, request, ToolVersion).Scan(&op); err != nil {
		return 0, err
	}
	if coins.Sign() > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES($1,$2,$3,$3)`, op, id, coins.Int64()); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES($1,'assets_changed',$2)`, op, raw); err != nil {
		return 0, err
	}
	inv, _ := m["inventory"].(map[string]any)
	bigfish, _ := m["bigfish"].(map[string]any)
	for item, rawQty := range inv {
		q, ok := integer(rawQty)
		if !ok || q.Sign() < 0 || !q.IsInt64() {
			return 0, fmt.Errorf("account %s invalid inventory %s", e.key, item)
		}
		tierQ := map[string]int64{"normal": q.Int64()}
		if bf, ok := bigfish[item].(map[string]any); ok {
			l, okL := integer(bf["L"])
			g, okG := integer(bf["G"])
			if !okL || !okG || l.Sign() < 0 || g.Sign() < 0 {
				return 0, fmt.Errorf("account %s invalid reserved inventory", e.key)
			}
			total := new(big.Int).Add(new(big.Int).Set(l), g)
			if total.Cmp(q) > 0 {
				return 0, fmt.Errorf("account %s reserved inventory exceeds total", e.key)
			}
			tierQ["large"], tierQ["giant"] = l.Int64(), g.Int64()
			tierQ["normal"] = q.Int64() - l.Int64() - g.Int64()
		}
		kind, exists := kinds[item]
		if !exists {
			return 0, fmt.Errorf("account %s item %s has no catalog definition", e.key, item)
		}
		for tier, n := range tierQ {
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,$3,$4,$5)`, id, item, kind, tier, n); err != nil {
				return 0, err
			}
		}
	}
	if err := importAccountExtras(ctx, tx, id, op, e, kinds); err != nil {
		return 0, err
	}
	return id, nil
}

func importAccountExtras(ctx context.Context, tx pgx.Tx, id, op int64, e entity, kinds map[string]string) error {
	if codex, ok := e.payload["codex"].(map[string]any); ok {
		for item, raw := range codex {
			m, _ := raw.(map[string]any)
			count := int64(1)
			if n, ok := integer(m["count"]); ok && n.IsInt64() && n.Sign() > 0 {
				count = n.Int64()
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, item, count); err != nil {
				return err
			}
		}
	}
	if rules, ok := e.payload["autoSell"].(map[string]any); ok {
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,include_tiers,rules) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, boolValue(rules, "includeTiers"), jsonBytes(rules, []byte("{}"))); err != nil {
			return err
		}
	}
	components := map[string]int64{}
	if bd, ok := e.payload["bd"].(map[string]any); ok {
		for old, raw := range bd {
			m, ok := raw.(map[string]any)
			if !ok {
				return errors.New("equipment payload is not object")
			}
			part := stringValue(m, "part")
			if part == "" {
				return fmt.Errorf("equipment %s missing part", old)
			}
			attrs := jsonBytes(m, []byte("{}"))
			var eid int64
			if err := tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES($1,$2,$3,$4,$5) RETURNING id`, id, old, part, attrs, op).Scan(&eid); err != nil {
				return err
			}
			components[old] = eid
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, op, eid, id); err != nil {
				return err
			}
		}
	}
	if slots, ok := e.payload["rodSlots"].([]any); ok {
		for i, raw := range slots {
			if raw == nil {
				continue
			}
			slot, ok := raw.(map[string]any)
			if !ok {
				return errors.New("rod slot is not object")
			}
			name := stringValue(slot, "name")
			if len(name) > 20 {
				name = name[:20]
			}
			active := i == intNumber(e.payload["rodActiveSlot"])
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,$2,$3,$4)`, id, i, name, active); err != nil {
				return err
			}
			parts, _ := slot["components"].([]any)
			for _, partRaw := range parts {
				old, _ := partRaw.(string)
				eid, ok := components[old]
				if !ok {
					return fmt.Errorf("rod slot references unknown equipment %s", old)
				}
				part := "accessory"
				if bd, ok := e.payload["bd"].(map[string]any); ok {
					if m, ok := bd[old].(map[string]any); ok && stringValue(m, "part") != "" {
						part = stringValue(m, "part")
					}
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, id, i, part, eid); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func intNumber(v any) int {
	if n, ok := integer(v); ok && n.IsInt64() {
		return int(n.Int64())
	}
	return -999
}
func stringValue(m map[string]any, k string) string {
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}
func boolValue(m map[string]any, k string) bool { b, _ := m[k].(bool); return b }
func integer(v any) (*big.Int, bool) {
	switch x := v.(type) {
	case json.Number:
		n, ok := new(big.Int).SetString(string(x), 10)
		return n, ok
	case float64:
		return big.NewInt(int64(x)), true
	case int64:
		return big.NewInt(x), true
	case int:
		return big.NewInt(int64(x)), true
	}
	return nil, false
}

func importCatalog(ctx context.Context, tx pgx.Tx, es []entity) (map[string]string, error) {
	out := map[string]string{}
	for _, e := range es {
		if e.domain != "config" {
			continue
		}
		if items, ok := e.payload["items"].([]any); ok {
			for _, raw := range items {
				m, ok := raw.(map[string]any)
				if !ok {
					return nil, errors.New("catalog item is not object")
				}
				id := stringValue(m, "id")
				kind := stringValue(m, "kind")
				part := stringValue(m, "part")
				if id == "" || kind == "" {
					return nil, errors.New("catalog item missing id/kind")
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.item_definitions(id,kind,part) VALUES($1,$2,NULLIF($3,'')) ON CONFLICT(id) DO NOTHING`, id, kind, part); err != nil {
					return nil, err
				}
				out[id] = kind
			}
		}
	}
	return out, nil
}

func importMarkets(ctx context.Context, tx pgx.Tx, runID string, es []entity, ids map[string]int64) error {
	for _, e := range es {
		if e.domain != "market" {
			continue
		}
		rows, ok := e.payload["listings"].([]any)
		if !ok {
			continue
		}
		for i, raw := range rows {
			m, ok := raw.(map[string]any)
			if !ok {
				return errors.New("listing is not object")
			}
			seller := strings.ToLower(stringValue(m, "seller"))
			sid, ok := ids[seller]
			if !ok {
				return fmt.Errorf("listing %d has unknown seller", i)
			}
			item := stringValue(m, "id")
			q, ok := integer(m["qty"])
			if !ok || q.Sign() <= 0 || !q.IsInt64() {
				return fmt.Errorf("listing %d invalid qty", i)
			}
			price, ok := integer(m["price"])
			if !ok || price.Sign() <= 0 || !price.IsInt64() {
				return fmt.Errorf("listing %d invalid price", i)
			}
			request := fmt.Sprintf("migration:%s:listing:%d", runID, i)
			rh := sha256.Sum256([]byte(request))
			var op int64
			if err := tx.QueryRow(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,'{}') RETURNING actor_id`, sid, request, rh[:]).Scan(new(int64)); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,'market_list',$3) RETURNING id`, sid, request, ToolVersion).Scan(&op); err != nil {
				return err
			}
			state := stringValue(m, "state")
			if state == "" || state == "escrowed" {
				state = "open"
			}
			if state != "open" {
				return fmt.Errorf("listing %d state %q requires a closed-operation mapper", i, state)
			}
			remaining := q.Int64()
			if n, ok := integer(m["remaining"]); ok {
				remaining = n.Int64()
			}
			if remaining < 0 || remaining > q.Int64() {
				return errors.New("listing remaining outside quantity")
			}
			if remaining == 0 {
				return fmt.Errorf("listing %d has no remaining quantity and needs a closed-operation mapper", i)
			}
			expires := time.Now().Add(24 * time.Hour)
			if ts := stringValue(m, "expiresAt"); ts != "" {
				t, err := time.Parse(time.RFC3339, ts)
				if err != nil {
					return fmt.Errorf("listing %d has invalid expiresAt: %w", i, err)
				}
				expires = t
			}
			if tag, err := tx.Exec(ctx, `UPDATE fishing.inventory_stacks SET quantity=quantity-$3 WHERE owner_id=$1 AND item_id=$2 AND tier='normal' AND quantity >= $3`, sid, item, remaining); err != nil {
				return err
			} else if tag.RowsAffected() != 1 {
				return fmt.Errorf("listing %d has insufficient available normal inventory", i)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.market_orders(seller_id,kind,item_id,quantity,remaining,unit_price,hours,state,created_operation,expires_at) VALUES($1,'stack',$2,$3,$4,$5,24,$6,$7,$8)`, sid, item, q.Int64(), remaining, price.Int64(), state, op, expires); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.migration_entities(run_id,domain,entity_key,source_sha256,payload,status) VALUES($1,'market',$2,$3,$4,'imported') ON CONFLICT DO NOTHING`, runID, fmt.Sprintf("listing:%v", m["lid"]), e.sha, m); err != nil {
				return err
			}
		}
	}
	return nil
}

func importWiki(ctx context.Context, tx pgx.Tx, runID string, es []entity, ids map[string]int64) error {
	for _, e := range es {
		if e.domain != "legacy-wiki" {
			continue
		}
		guides, ok := e.payload["guides"].([]any)
		if !ok {
			if w, ok2 := e.payload["wikiContent"].(map[string]any); ok2 {
				guides, _ = w["guides"].([]any)
			}
		}
		if !ok && guides == nil {
			guides, ok = e.payload["wikiUserGuides"].([]any)
		}
		if guides == nil {
			continue
		}
		for _, raw := range guides {
			m, ok := raw.(map[string]any)
			if !ok {
				return errors.New("wiki guide is not object")
			}
			id := stringValue(m, "id")
			title := stringValue(m, "title")
			if id == "" || title == "" {
				return errors.New("wiki guide missing id/title")
			}
			kind := stringValue(m, "kind")
			if kind == "" {
				kind = "official"
			}
			status := stringValue(m, "status")
			if status == "" {
				status = "published"
			}
			var owner any
			ownerName := stringValue(m, "owner")
			if ownerName == "" {
				ownerName = stringValue(m, "authorKey")
			}
			if ownerName != "" {
				owner = ids[strings.ToLower(ownerName)]
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.wiki_guides(id,kind,status,title,category,summary,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`, id, kind, status, title, stringValue(m, "category"), stringValue(m, "summary"), owner); err != nil {
				return err
			}
			sections, _ := m["sections"].([]any)
			for i, rawSection := range sections {
				sm, ok := rawSection.(map[string]any)
				if !ok {
					return errors.New("wiki section is not object")
				}
				heading := stringValue(sm, "heading")
				if heading == "" {
					heading = stringValue(sm, "h")
				}
				body := stringValue(sm, "body")
				if body == "" {
					body = stringValue(sm, "text")
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.wiki_sections(guide_id,ordinal,heading,type,body,items) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, id, i, heading, stringValue(sm, "type"), body, jsonBytes(sm["items"], []byte("[]"))); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func jsonBytes(v any, fallback []byte) []byte {
	if v == nil {
		return fallback
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fallback
	}
	return b
}

func unsupportedGaps(es []entity) []Gap {
	var out []Gap
	for _, e := range es {
		if len(e.payload) == 0 {
			continue
		}
		switch e.domain {
		case "account":
			for _, field := range []string{"trades", "social", "sea", "history"} {
				if _, ok := e.payload[field]; ok {
					out = append(out, Gap{e.domain, safeEntity(e), "account-field-requires-mapper", "field '" + field + "' is staged but has no target writer", true})
				}
			}
			if m, ok := e.payload["mfa"].(map[string]any); ok && stringValue(m, "secret") != "" {
				out = append(out, Gap{e.domain, safeEntity(e), "mfa-requires-keyed-import", "MFA secret is never copied without the separately controlled key ceremony", true})
			}
		case "market", "legacy-wiki":
			// These have explicit writers above. Unknown rows still remain in the ledger.
		case "config":
			keys := make([]string, 0, len(e.payload))
			for k := range e.payload {
				if k != "items" {
					keys = append(keys, k)
				}
			}
			if len(keys) > 0 {
				sort.Strings(keys)
				out = append(out, Gap{e.domain, e.key, "config-fields-require-versioned-mapper", "unmapped operator configuration: " + strings.Join(keys, ","), true})
			}
		case "sessions":
			out = append(out, Gap{e.domain, e.key, "sessions-not-imported", "session tokens are intentionally invalidated; re-login is required", false})
		case "wiki-sqlite":
			out = append(out, Gap{e.domain, e.key, "sqlite-wal-integrity-required", "run SQLite integrity_check and verify JSON/WAL pair before Wiki cutover", true})
		case "historical-snapshot":
			out = append(out, Gap{e.domain, e.key, "historical-snapshot-review-required", "historical copies are staged for review and never merged into current balances", true})
		default:
			out = append(out, Gap{e.domain, e.key, "domain-requires-field-mapper", "payload staged verbatim; no target writer is enabled for this domain", true})
		}
	}
	return out
}

func safeEntity(e entity) string {
	if e.domain == "account" && len(e.sha) >= 12 {
		return "entity-" + e.sha[:12]
	}
	return e.key
}
func markEntity(ctx context.Context, tx pgx.Tx, run, domain, key, status, issue string) error {
	_, err := tx.Exec(ctx, `UPDATE fishing.migration_entities SET status=$4,issue=$5 WHERE run_id=$1 AND domain=$2 AND entity_key=$3`, run, domain, key, status, issue)
	return err
}
func markFailed(ctx context.Context, tx pgx.Tx, run string, e error) error {
	_, err := tx.Exec(ctx, `UPDATE fishing.migration_runs SET state='failed',error=$2,finished_at=clock_timestamp() WHERE id=$1`, run, e.Error())
	return err
}

// Reconcile returns row-level counts and asset conservation checks. It is kept
// separate from Import so operators can rerun it after restore without writes.
func Reconcile(ctx context.Context, pool *pgxpool.Pool, runID string) (Result, error) {
	var r Result
	r.RunID = runID
	if err := pool.QueryRow(ctx, `SELECT state,snapshot_sha256 FROM fishing.migration_runs WHERE id=$1`, runID).Scan(&r.State, &r.Manifest); err != nil {
		return r, err
	}
	if r.State != "imported" && r.State != "reconciled" {
		return r, fmt.Errorf("cannot reconcile migration run in state %q", r.State)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.migration_entities WHERE run_id=$1 AND status IN ('imported','reconciled')`, runID).Scan(&n); err != nil {
		return r, err
	}
	r.Entities = n
	var pending int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.migration_entities WHERE run_id=$1 AND status <> 'reconciled'`, runID).Scan(&pending); err != nil {
		return r, err
	}
	if pending != 0 {
		return r, fmt.Errorf("migration run has %d unreconciled entities", pending)
	}
	var gaps int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM fishing.migration_gaps WHERE run_id=$1 AND blocking`, runID).Scan(&gaps); err != nil {
		return r, err
	}
	if gaps > 0 {
		return r, ErrBlocked
	}
	rows, err := pool.Query(ctx, `SELECT e.entity_key,e.source_sha256,e.payload,COALESCE(m.new_id,'') FROM fishing.migration_entities e
LEFT JOIN fishing.legacy_id_map m ON m.run_id=e.run_id AND m.domain='account' AND m.legacy_id=COALESCE(e.payload->>'id',e.entity_key)
WHERE e.run_id=$1 AND e.domain='account' ORDER BY e.entity_key`, runID)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, sourceHash, newID string
		var raw []byte
		if err := rows.Scan(&key, &sourceHash, &raw, &newID); err != nil {
			return r, err
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return r, err
		}
		id, err := strconv.ParseInt(newID, 10, 64)
		if err != nil {
			r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" has no new id")
			continue
		}
		want, ok := integer(payload["coins"])
		if !ok {
			r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" invalid source coins")
			continue
		}
		var got int64
		if err := pool.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1`, id).Scan(&got); err != nil {
			r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" missing wallet")
			continue
		}
		if !want.IsInt64() || got != want.Int64() {
			r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" coins differ")
		}
		if inv, ok := payload["inventory"].(map[string]any); ok {
			for item, rawQty := range inv {
				q, ok := integer(rawQty)
				if !ok || !q.IsInt64() {
					r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" invalid "+item)
					continue
				}
				var total int64
				if err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT sum(quantity) FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2),0)+COALESCE((SELECT sum(remaining) FROM fishing.market_orders WHERE seller_id=$1 AND item_id=$2 AND state='open'),0)`, id, item).Scan(&total); err != nil {
					r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" missing "+item)
					continue
				}
				if total != q.Int64() {
					r.Diffs = append(r.Diffs, "account "+safeText(sourceHash)+" inventory "+item+" differs")
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return r, err
	}
	if len(r.Diffs) > 0 {
		return r, errors.New("field-level reconciliation differences")
	}
	r.Reconciled = true
	return r, nil
}

func safeText(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// Keep strconv imported in older Go toolchains where json.Number aliases are
// formatted through String in diagnostics.
var _ = strconv.IntSize
