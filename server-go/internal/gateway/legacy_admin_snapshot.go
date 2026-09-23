package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// Snapshots intentionally live in operator_settings. This keeps the queue
// durable without introducing a second account-state model; each row stores a
// JSON array under users:snapshots:<account id>.
const (
	legacySnapshotCfgKey  = "snapshot"
	legacySnapshotKeepMax = 50
)

var legacySnapshotName = regexp.MustCompile(`^[0-9]{6,}(-[0-9]{1,3})?\.json$`)

type legacySnapshotCfg struct {
	Enabled     bool `json:"enabled"`
	IntervalMin int  `json:"intervalMin"`
	Keep        int  `json:"keep"`
}

type legacySnapshotRecord struct {
	Name string         `json:"name"`
	TS   int64          `json:"ts"`
	View map[string]any `json:"view"`
}

type legacySnapshotLoadout struct {
	Bindings map[string]bindingCount `json:"bindings,omitempty"`
	Slot     int                     `json:"slot"`
	Name     string                  `json:"name"`
	Active   bool                    `json:"active"`
	Parts    map[string]string       `json:"parts"`
}

func readLegacySnapshotLoadouts(ctx context.Context, tx pgx.Tx, owner int64) ([]legacySnapshotLoadout, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',r.slot,'name',r.name,'active',r.active,'bindings',(SELECT COALESCE(jsonb_object_agg(c.part,jsonb_build_object('bound',CASE WHEN e.reward_bound THEN 1 ELSE 0 END,'inherit',CASE WHEN e.bind_outputs THEN 1 ELSE 0 END)),'{}'::jsonb) FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id=r.owner_id AND c.slot=r.slot),'parts',
 (SELECT COALESCE(jsonb_object_agg(c.part,e.attributes->>'signature'),'{}'::jsonb)
 FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id=r.owner_id AND c.slot=r.slot)) ORDER BY r.slot),'[]'::jsonb)
 FROM fishing.rod_loadouts r WHERE r.owner_id=$1`, owner).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var loadouts []legacySnapshotLoadout
	err = json.Unmarshal(raw, &loadouts)
	return loadouts, err
}

func legacySnapshotRodState(ctx context.Context, tx pgx.Tx, owner int64) ([]byte, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',r.slot,'name',r.name,'active',r.active,'bindings',(SELECT COALESCE(jsonb_object_agg(c.part,jsonb_build_object('bound',CASE WHEN e.reward_bound THEN 1 ELSE 0 END,'inherit',CASE WHEN e.bind_outputs THEN 1 ELSE 0 END)),'{}'::jsonb) FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id=r.owner_id AND c.slot=r.slot),'parts',
 (SELECT COALESCE(jsonb_object_agg(c.part,c.equipment_id::text),'{}'::jsonb) FROM fishing.rod_components c WHERE c.owner_id=r.owner_id AND c.slot=r.slot)) ORDER BY r.slot),'[]'::jsonb)
 FROM fishing.rod_loadouts r WHERE r.owner_id=$1`, owner).Scan(&raw)
	return raw, err
}

func recordLegacySnapshotRodChange(ctx context.Context, tx pgx.Tx, owner, operation int64, before []byte) error {
	after, err := legacySnapshotRodState(ctx, tx, owner)
	if err != nil || bytes.Equal(before, after) {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_entries(operation_id,owner_id,before_state,after_state) VALUES($1,$2,$3,$4)`, operation, owner, before, after); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE fishing.player_state SET loadout_rev=loadout_rev+1 WHERE account_id=$1`, owner)
	return err
}

type snapshotSettingReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// Use the same ordered player guards as asset commands. Locking identities or
// existing inventory rows alone cannot protect absent stacks or a snapshot
// assembled from several queries while a player command is committing.
func legacyAdminWriteGuard(ctx context.Context, tx pgx.Tx, actor identity.Session, owners ...int64) error {
	ids := append([]int64{actor.AccountID}, owners...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for i, id := range ids {
		if i > 0 && ids[i-1] == id {
			continue
		}
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return identity.ErrStorage
		}
	}
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fishing.auth_sessions s JOIN fishing.identities i ON i.account_id=s.account_id
 WHERE s.token_hash=$1 AND s.account_id=$2 AND s.admin AND s.expires_at>clock_timestamp() AND i.admin AND NOT i.banned AND NOT i.retired)`, actor.Hash[:], actor.AccountID).Scan(&valid); err != nil {
		return identity.ErrStorage
	}
	if !valid {
		return identity.ErrCredentials
	}
	return nil
}

func defaultLegacySnapshotCfg() legacySnapshotCfg {
	return legacySnapshotCfg{Enabled: true, IntervalMin: 30, Keep: 5}
}

func normalizeLegacySnapshotCfg(cfg legacySnapshotCfg) legacySnapshotCfg {
	if cfg.IntervalMin < 1 {
		cfg.IntervalMin = 1
	}
	if cfg.IntervalMin > 24*60 {
		cfg.IntervalMin = 24 * 60
	}
	if cfg.Keep < 1 {
		cfg.Keep = 1
	}
	if cfg.Keep > legacySnapshotKeepMax {
		cfg.Keep = legacySnapshotKeepMax
	}
	return cfg
}

func readLegacySnapshotCfg(ctx context.Context, q snapshotSettingReader) (legacySnapshotCfg, error) {
	cfg := defaultLegacySnapshotCfg()
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key=$1`, legacySnapshotCfgKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return defaultLegacySnapshotCfg(), nil
	}
	return normalizeLegacySnapshotCfg(cfg), nil
}

func snapshotSettingKey(id int64) string {
	return "users:snapshots:" + strconv.FormatInt(id, 10)
}

func readLegacySnapshotRecords(ctx context.Context, q snapshotSettingReader, id int64, lock bool) ([]legacySnapshotRecord, error) {
	query := `SELECT value FROM fishing.operator_settings WHERE key=$1`
	if lock {
		query += " FOR UPDATE"
	}
	var raw []byte
	err := q.QueryRow(ctx, query, snapshotSettingKey(id)).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return []legacySnapshotRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	var records []legacySnapshotRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}
	return records, nil
}

func writeLegacySnapshotRecords(ctx context.Context, tx pgx.Tx, id int64, records []legacySnapshotRecord) error {
	raw, err := json.Marshal(records)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp())
 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, snapshotSettingKey(id), raw)
	return err
}

func snapshotRecordSummary(record legacySnapshotRecord) map[string]any {
	view := record.View
	inv, _ := view["inventory"].(map[string]any)
	total := int64(0)
	for _, value := range inv {
		if n, ok := snapshotNumber(value); ok && n > 0 {
			total += int64(n)
		}
	}
	rodSlots := 0
	if slots, ok := view["rodSlots"].([]any); ok {
		for _, slot := range slots {
			if slot != nil {
				rodSlots++
			}
		}
	}
	catchCount, _ := snapshotNumber(view["catchCount"])
	coins, _ := snapshotNumber(view["coins"])
	return map[string]any{"name": record.Name, "ts": record.TS, "size": snapshotJSONSize(record),
		"coins": int64(coins), "kinds": len(inv), "total": total,
		"rodSlots": rodSlots, "catchCount": int64(catchCount)}
}

func snapshotJSONSize(record legacySnapshotRecord) int64 {
	b, _ := json.Marshal(record.View)
	return int64(len(b))
}

func snapshotNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	default:
		return 0, false
	}
}

func legacySnapshotRodDetails(c *rules.Catalog, bd map[string]any) (map[string]float64, float64) {
	parts := map[string]struct {
		CompID string `json:"compId"`
	}{}
	for part, raw := range bd {
		var value struct {
			CompID string `json:"compId"`
		}
		encoded, _ := json.Marshal(raw)
		if json.Unmarshal(encoded, &value) == nil {
			parts[part] = value
		}
	}
	effects := c.RodEffects(parts)
	info := c.CastRules(nil).Info(effects, rules.Spot{})
	return map[string]float64{
		"speed": effects["speed"], "skill": effects["skill"], "rare": effects["rare"],
		"material": effects["material"], "size": effects["size"], "double": effects["double"],
	}, info.Interval
}

// legacyAdminSnapshotView contains the durable player assets represented by
// the old profile. Inventory is flattened to the old map and bigfish retains
// the large/giant split so a rollback does not lose fish tiers.
func (a *API) legacyAdminSnapshotView(ctx context.Context, owner int64) (map[string]any, error) {
	var coins, revision, catchCount int64
	if err := a.pool.QueryRow(ctx, `SELECT w.coins,p.assets_rev,p.catch_count FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, owner).Scan(&coins, &revision, &catchCount); err != nil {
		return nil, err
	}
	bindings, bindingErr := rewardBindings(ctx, a.pool, owner)
	if bindingErr != nil {
		return nil, bindingErr
	}
	inventory, bigfish, err := a.legacyInventory(ctx, owner)
	if err != nil {
		return nil, err
	}
	codex := map[string]any{}
	rows, err := a.pool.Query(ctx, `SELECT item_id,count,first_at,min_size,max_size,best_tier FROM fishing.player_codex WHERE owner_id=$1`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, tier string
		var count int64
		var first time.Time
		var minSize, maxSize *float64
		if err := rows.Scan(&id, &count, &first, &minSize, &maxSize, &tier); err != nil {
			rows.Close()
			return nil, err
		}
		codex[id] = map[string]any{"count": count, "first": first.UnixMilli(), "min": minSize, "max": maxSize, "tier": tier}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	bd := map[string]any{}
	rodSlots := []any{}
	rodActiveSlot := -1
	rodName := ""
	var capacity int
	if err := a.pool.QueryRow(ctx, `SELECT rod_capacity FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&capacity); err == nil {
		if c, err := a.catalog(ctx); err == nil {
			if active, slots, slot, name, _, err := a.legacyRod(ctx, c, owner, capacity); err == nil {
				for part, value := range active {
					bd[part] = value
				}
				rodSlots, rodActiveSlot, rodName = slots, slot, name
			}
		}
	}
	effects := map[string]float64{}
	interval := float64(0)
	if c, err := a.catalog(ctx); err == nil {
		effects, interval = legacySnapshotRodDetails(c, bd)
	}
	return map[string]any{
		"rewardBindings": bindings, "coins": coins, "inventory": inventory, "bigfish": bigfish, "codex": codex,
		"catchCount": catchCount, "invRev": strconv.FormatInt(revision, 10),
		"bd": bd, "effects": effects, "interval": interval, "rodSlots": rodSlots, "rodActiveSlot": rodActiveSlot, "rodName": rodName,
	}, nil
}

func nextLegacySnapshotName(records []legacySnapshotRecord, now int64) string {
	base := strconv.FormatInt(now, 10)
	name := base + ".json"
	seen := map[string]bool{}
	for _, record := range records {
		seen[record.Name] = true
	}
	if !seen[name] {
		return name
	}
	for i := 1; i <= 999; i++ {
		name = base + "-" + strconv.Itoa(i) + ".json"
		if !seen[name] {
			return name
		}
	}
	return base + "-999.json"
}

func appendLegacySnapshot(records []legacySnapshotRecord, record legacySnapshotRecord, keep int) []legacySnapshotRecord {
	records = append(records, record)
	sort.SliceStable(records, func(i, j int) bool {
		return records[i].TS < records[j].TS || records[i].TS == records[j].TS && records[i].Name < records[j].Name
	})
	if len(records) > keep {
		records = records[len(records)-keep:]
	}
	return records
}

func (a *API) writeLegacySnapshotTx(ctx context.Context, tx pgx.Tx, owner int64, cfg legacySnapshotCfg) (legacySnapshotRecord, error) {
	view, err := a.legacyAdminSnapshotViewTx(ctx, tx, owner)
	if err != nil {
		return legacySnapshotRecord{}, err
	}
	records, err := readLegacySnapshotRecords(ctx, tx, owner, true)
	if err != nil {
		return legacySnapshotRecord{}, err
	}
	now := time.Now().UnixMilli()
	record := legacySnapshotRecord{Name: nextLegacySnapshotName(records, now), TS: now, View: view}
	records = appendLegacySnapshot(records, record, cfg.Keep)
	return record, writeLegacySnapshotRecords(ctx, tx, owner, records)
}

func (a *API) legacyAdminSnapshotViewTx(ctx context.Context, tx pgx.Tx, owner int64) (map[string]any, error) {
	catalog, err := a.catalog(ctx)
	if err != nil {
		return nil, err
	}
	var coins, revision, catchCount int64
	if err := tx.QueryRow(ctx, `SELECT w.coins,p.assets_rev,p.catch_count FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, owner).Scan(&coins, &revision, &catchCount); err != nil {
		return nil, err
	}
	bindings, bindingErr := rewardBindings(ctx, tx, owner)
	if bindingErr != nil {
		return nil, bindingErr
	}
	inventory, bigfish, err := legacyInventoryFrom(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	codex := map[string]any{}
	rows, err := tx.Query(ctx, `SELECT item_id,count,first_at,min_size,max_size,best_tier FROM fishing.player_codex WHERE owner_id=$1`, owner)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, tier string
		var count int64
		var first time.Time
		var minSize, maxSize *float64
		if err := rows.Scan(&id, &count, &first, &minSize, &maxSize, &tier); err != nil {
			rows.Close()
			return nil, err
		}
		codex[id] = map[string]any{"count": count, "first": first.UnixMilli(), "min": minSize, "max": maxSize, "tier": tier}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	bd := map[string]any{}
	loadouts, err := readLegacySnapshotLoadouts(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	active, rodName := -1, ""
	rodSlots := make([]any, 8)
	for _, loadout := range loadouts {
		if loadout.Slot >= 0 && len(loadout.Parts) > 0 {
			rodSlots[loadout.Slot] = map[string]any{"slot": loadout.Slot, "name": loadout.Name, "parts": loadout.Parts}
		}
		if !loadout.Active {
			continue
		}
		active, rodName = loadout.Slot, loadout.Name
		for part, signature := range loadout.Parts {
			entry := map[string]any{"compId": signature, "isCharm": part == "charm"}
			if meta, ok := catalog.ComponentMeta(signature); ok {
				entry["name"] = meta.Name
				entry["affixes"] = meta.Affixes
				entry["rare"] = meta.Quality
			}
			bd[part] = entry
		}
	}
	effects := map[string]float64{}
	interval := float64(0)
	if c, err := a.catalog(ctx); err == nil {
		effects, interval = legacySnapshotRodDetails(c, bd)
	}
	return map[string]any{"rewardBindings": bindings, "coins": coins, "inventory": inventory, "bigfish": bigfish, "codex": codex,
		"catchCount": catchCount, "invRev": strconv.FormatInt(revision, 10), "bd": bd, "effects": effects, "interval": interval,
		"rodSlots": rodSlots, "rodActiveSlot": active, "rodName": rodName, "_rodLoadouts": loadouts}, nil
}

func (a *API) legacyAdminUserSnapshot(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	target := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("key")))
	id, exists, err := a.legacyAdminTarget(r.Context(), target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	var name, username, qq string
	var admin bool
	if err := a.pool.QueryRow(r.Context(), `SELECT username,display_name,qq,admin FROM fishing.identities WHERE account_id=$1`, id).Scan(&username, &name, &qq, &admin); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	view, err := a.legacyAdminSnapshotView(r.Context(), id)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	view["ok"], view["key"], view["name"], view["username"], view["qq"], view["admin"] = true, target, name, username, qq, admin
	write(w, 200, view)
}

type legacySnapshotSaveInput struct {
	Target    string                     `json:"target"`
	Coins     *float64                   `json:"coins"`
	Inventory map[string]json.RawMessage `json:"inventory"`
	BD        json.RawMessage            `json:"bd"`
}

func decodeSnapshotInventory(raw map[string]json.RawMessage) (map[string]int64, error) {
	if raw == nil {
		return nil, nil
	}
	out := map[string]int64{}
	for rawID, value := range raw {
		id := strings.TrimSpace(rawID)
		if id == "" {
			return nil, errors.New("invalid inventory")
		}
		var n float64
		if err := json.Unmarshal(value, &n); err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return nil, errors.New("invalid inventory")
		}
		n = math.Floor(n)
		if n <= 0 {
			continue
		}
		if n > 9007199254740991 {
			return nil, errors.New("invalid inventory")
		}
		out[id] = int64(n)
	}
	return out, nil
}

func (a *API) validateSnapshotInventory(ctx context.Context, ids map[string]int64) (map[string]string, map[string]rules.Item, error) {
	kinds := map[string]string{}
	components := map[string]rules.Item{}
	catalog, catalogErr := a.catalog(ctx)
	if catalogErr != nil {
		return nil, nil, catalogErr
	}
	for id, quantity := range ids {
		if id == "" || quantity <= 0 {
			continue
		}
		var kind string
		err := a.pool.QueryRow(ctx, `SELECT kind FROM fishing.item_definitions WHERE id=$1`, id).Scan(&kind)
		if errors.Is(err, pgx.ErrNoRows) {
			base, _, _, ok := catalog.Instance(id)
			if !ok {
				return nil, nil, errors.New("unknown item: " + id)
			}
			kinds[id] = "equipment"
			components[id] = base
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		if kind == "equipment" {
			base, _, _, ok := catalog.Instance(id)
			if !ok {
				return nil, nil, errors.New("unknown item: " + id)
			}
			components[id] = base
		}
		kinds[id] = kind
	}
	return kinds, components, nil
}

func legacySnapshotOperation(ctx context.Context, tx pgx.Tx, actor int64) (int64, error) {
	key := "legacy:snapshot:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	hash := sha256.Sum256([]byte(key))
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,'{}')`, actor, key, hash[:]); err != nil {
		return 0, err
	}
	var operation int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,'admin_grant','legacy-admin-snapshot') RETURNING id`, actor, key).Scan(&operation); err != nil {
		return 0, err
	}
	return operation, nil
}

type legacySnapshotStack struct {
	Kind, Tier string
	Quantity   int64
}

func readLegacySnapshotStacks(ctx context.Context, tx pgx.Tx, owner int64) (map[string]legacySnapshotStack, error) {
	rows, err := tx.Query(ctx, `SELECT item_id,kind,tier,quantity FROM fishing.inventory_stacks WHERE owner_id=$1`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]legacySnapshotStack{}
	for rows.Next() {
		var item legacySnapshotStack
		var id string
		if err := rows.Scan(&id, &item.Kind, &item.Tier, &item.Quantity); err != nil {
			return nil, err
		}
		out[id+"\x00"+item.Tier] = item
	}
	return out, rows.Err()
}

func recordLegacySnapshotStackDeltas(ctx context.Context, tx pgx.Tx, operation, owner int64, before map[string]legacySnapshotStack) error {
	after, err := readLegacySnapshotStacks(ctx, tx, owner)
	if err != nil {
		return err
	}
	keys := map[string]bool{}
	for key := range before {
		keys[key] = true
	}
	for key := range after {
		keys[key] = true
	}
	for key := range keys {
		old, oldOK := before[key]
		cur, curOK := after[key]
		if !oldOK {
			old = cur
			old.Quantity = 0
		}
		if !curOK {
			cur = old
			cur.Quantity = 0
		}
		delta := cur.Quantity - old.Quantity
		if delta == 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.inventory_entries(operation_id,owner_id,item_id,tier,delta,quantity_after) VALUES($1,$2,$3,$4,$5,$6)`, operation, owner, strings.SplitN(key, "\x00", 2)[0], cur.Tier, delta, cur.Quantity); err != nil {
			return err
		}
	}
	return nil
}

func (a *API) applySnapshotInventory(ctx context.Context, tx pgx.Tx, owner, operation int64, view map[string]any) error {
	inv, ok := view["inventory"].(map[string]any)
	if !ok {
		return errors.New("invalid snapshot inventory")
	}
	currentBindings, bindingErr := rewardBindings(ctx, tx, owner)
	if bindingErr != nil {
		return bindingErr
	}
	bindings := view["rewardBindings"]
	if bindings == nil {
		bindings = currentBindings
	}
	before, err := readLegacySnapshotStacks(ctx, tx, owner)
	if err != nil {
		return err
	}
	ids := map[string]int64{}
	for id, value := range inv {
		n, valid := snapshotNumber(value)
		if !valid || n <= 0 || n > 9007199254740991 {
			continue
		}
		ids[id] = int64(math.Floor(n))
	}
	catalog, err := a.catalog(ctx)
	if err != nil {
		return err
	}
	equipment := map[string]rules.Item{}
	for id := range ids {
		var kind string
		err := tx.QueryRow(ctx, `SELECT kind FROM fishing.item_definitions WHERE id=$1`, id).Scan(&kind)
		if errors.Is(err, pgx.ErrNoRows) {
			base, _, _, ok := catalog.Instance(id)
			if !ok {
				return errors.New("unknown snapshot item: " + id)
			}
			equipment[id] = base
			continue
		}
		if err != nil {
			return err
		}
		if kind == "equipment" {
			base, _, _, ok := catalog.Instance(id)
			if !ok {
				return errors.New("unknown snapshot equipment: " + id)
			}
			equipment[id] = base
		}
	}
	rows, err := tx.Query(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) FOR UPDATE`, owner)
	if err != nil {
		return err
	}
	var loose []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		loose = append(loose, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, id := range loose {
		if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed',escrow_listing_id=NULL WHERE id=$1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume')`, operation, id, owner); err != nil {
			return err
		}
	}
	// A legacy map contains the total quantity; restore the large/giant rows
	// from the companion bigfish projection where available.
	bigfish, _ := view["bigfish"].(map[string]any)
	if _, err := tx.Exec(ctx, `UPDATE fishing.inventory_stacks SET quantity=0,bound_quantity=0,inherit_quantity=0 WHERE owner_id=$1`, owner); err != nil {
		return err
	}
	for id, quantity := range ids {
		if base, ok := equipment[id]; ok {
			attrs, _ := json.Marshal(map[string]any{"signature": id})
			for i := int64(0); i < quantity; i++ {
				var equipmentID int64
				if err := tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES($1,$2,$3,$4,$5) RETURNING id`, owner, base.ID, base.Part, attrs, operation).Scan(&equipmentID); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, operation, equipmentID, owner); err != nil {
					return err
				}
			}
			continue
		}
		kind := ""
		if err := tx.QueryRow(ctx, `SELECT kind FROM fishing.item_definitions WHERE id=$1`, id).Scan(&kind); err != nil {
			return err
		}
		if kind == "fish" {
			large, giant := int64(0), int64(0)
			if raw, ok := bigfish[id].(map[string]any); ok {
				if n, valid := snapshotNumber(raw["L"]); valid && n > 0 {
					large = int64(math.Floor(n))
				}
				if n, valid := snapshotNumber(raw["G"]); valid && n > 0 {
					giant = int64(math.Floor(n))
				}
			}
			normal := quantity - large - giant
			if normal < 0 {
				normal = 0
			}
			for tier, q := range map[string]int64{"normal": normal, "large": large, "giant": giant} {
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=excluded.quantity`, owner, id, kind, tier, q); err != nil {
					return err
				}
			}
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,$3,'normal',$4)
 ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=excluded.quantity`, owner, id, kind, quantity); err != nil {
			return err
		}
	}
	if err := restoreRewardBindings(ctx, tx, owner, operation, bindings); err != nil {
		return err
	}
	return recordLegacySnapshotStackDeltas(ctx, tx, operation, owner, before)
}

func (a *API) legacyAdminUserSnapshotSave(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in legacySnapshotSaveInput
	if !decode(w, r, &in) {
		return
	}
	target := strings.ToLower(strings.TrimSpace(in.Target))
	id, exists, err := a.legacyAdminTarget(r.Context(), target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	if in.Coins != nil && (math.IsNaN(*in.Coins) || math.IsInf(*in.Coins, 0) || *in.Coins < 0 || *in.Coins > 1e12) {
		legacyTradeError(w, 400, "金币数无效")
		return
	}
	ids, err := decodeSnapshotInventory(in.Inventory)
	if err != nil {
		legacyTradeError(w, 400, "背包格式错误")
		return
	}
	kinds, components, err := a.validateSnapshotInventory(r.Context(), ids)
	if err != nil {
		if strings.HasPrefix(err.Error(), "unknown item:") {
			legacyTradeError(w, 400, "未知物品："+strings.TrimPrefix(err.Error(), "unknown item: "))
		} else {
			failure(w, identity.ErrStorage)
		}
		return
	}
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := legacyAdminWriteGuard(ctx, tx, actor, id); err != nil {
		failure(w, err)
		return
	}
	var operation int64
	bdRequested := len(in.BD) > 0 && string(in.BD) != "null"
	if in.Coins != nil || in.Inventory != nil || bdRequested {
		operation, err = legacySnapshotOperation(ctx, tx, actor.AccountID)
		if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
	}
	if in.Coins != nil {
		var before int64
		if err = tx.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1 FOR UPDATE`, id).Scan(&before); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		after := int64(math.Floor(*in.Coins))
		if _, err = tx.Exec(ctx, `UPDATE fishing.wallets SET coins=$2 WHERE account_id=$1`, id, after); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if delta := after - before; delta != 0 {
			if _, err = tx.Exec(ctx, `INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES($1,$2,$3,$4)`, operation, id, delta, after); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
		}
	}
	assetsChanged := in.Coins != nil
	if in.Inventory != nil {
		bindings, bindingErr := rewardBindings(ctx, tx, id)
		if bindingErr != nil {
			failure(w, identity.ErrStorage)
			return
		}
		beforeStacks, readErr := readLegacySnapshotStacks(ctx, tx, id)
		if readErr != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.inventory_stacks SET quantity=0,bound_quantity=0,inherit_quantity=0 WHERE owner_id=$1`, id); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		// Replace only loose component instances. Bound equipment remains part
		// of the active/saved rod and is therefore still visible in the legacy
		// projection.
		rows, qerr := tx.Query(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.lifecycle='available' AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) FOR UPDATE`, id)
		if qerr != nil {
			failure(w, identity.ErrStorage)
			return
		}
		var loose []int64
		for rows.Next() {
			var equipment int64
			if qerr = rows.Scan(&equipment); qerr != nil {
				rows.Close()
				failure(w, identity.ErrStorage)
				return
			}
			loose = append(loose, equipment)
		}
		if qerr = rows.Err(); qerr != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		rows.Close()
		for _, equipment := range loose {
			if _, err = tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed',escrow_listing_id=NULL WHERE id=$1`, equipment); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
			if _, err = tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume')`, operation, equipment, id); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
		}
		for item, qty := range ids {
			if kinds[item] == "equipment" {
				base := components[item]
				for i := int64(0); i < qty; i++ {
					attrs, _ := json.Marshal(map[string]any{"signature": item})
					var equipment int64
					if err = tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES($1,$2,$3,$4,$5) RETURNING id`, id, base.ID, base.Part, attrs, operation).Scan(&equipment); err != nil {
						failure(w, identity.ErrStorage)
						return
					}
					if _, err = tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, operation, equipment, id); err != nil {
						failure(w, identity.ErrStorage)
						return
					}
				}
				continue
			}
			if _, err = tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,$3,'normal',$4)
 ON CONFLICT(owner_id,item_id,tier) DO UPDATE SET quantity=excluded.quantity`, id, item, kinds[item], qty); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=$1`, id); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err = restoreRewardBindings(ctx, tx, id, operation, bindings); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err = recordLegacySnapshotStackDeltas(ctx, tx, operation, id, beforeStacks); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		assetsChanged = true
	}
	bdChanged, bdErr := a.applyLegacySnapshotBD(ctx, tx, id, in.BD, operation)
	if bdErr != nil {
		if errors.Is(bdErr, identity.ErrInvalid) {
			legacyTradeError(w, 400, "钓竿配置格式错误")
		} else {
			failure(w, identity.ErrStorage)
		}
		return
	}
	if bdChanged && in.Inventory == nil {
		if _, err = tx.Exec(ctx, `UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=$1`, id); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		assetsChanged = true
	}
	if assetsChanged {
		if in.Inventory == nil && !bdChanged {
			if err = tx.QueryRow(ctx, `UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=$1 RETURNING assets_rev`, id).Scan(new(int64)); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
		}
		// Inventory/rod branches already advance assets_rev above. The event is
		// inserted after all entries so one SSE frame represents the full edit.
		var revision int64
		if err = tx.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, id).Scan(&revision); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		payload, _ := json.Marshal(map[string]any{"actor": strconv.FormatInt(actor.AccountID, 10), "players": []string{strconv.FormatInt(id, 10)}})
		var outboxID int64
		if err = tx.QueryRow(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES($1,'assets_changed',$2) RETURNING id`, operation, payload).Scan(&outboxID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.player_events(owner_id,revision,outbox_id) VALUES($1,$2,$3)`, id, revision, outboxID); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
	}
	if err = legacyAdminAudit(ctx, tx, actor, "users/snapshot", &id, target, "资产快照编辑"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	view, err := a.legacyAdminSnapshotView(ctx, id)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "key": target, "coins": view["coins"], "inventory": view["inventory"], "invRev": view["invRev"], "bd": view["bd"]})
}

func (a *API) applyLegacySnapshotBD(ctx context.Context, tx pgx.Tx, owner int64, raw json.RawMessage, operation int64) (bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, nil
	}
	before, err := legacySnapshotRodState(ctx, tx, owner)
	if err != nil {
		return false, err
	}
	if operation == 0 {
		operation, err = legacySnapshotOperation(ctx, tx, owner)
		if err != nil {
			return false, err
		}
	}
	changed, err := a.applyLegacySnapshotBDParts(ctx, tx, owner, raw, operation)
	if err == nil && changed {
		err = recordLegacySnapshotRodChange(ctx, tx, owner, operation, before)
	}
	return changed, err
}

func (a *API) applyLegacySnapshotBDParts(ctx context.Context, tx pgx.Tx, owner int64, raw json.RawMessage, operation int64) (bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return false, nil
	}
	var requested map[string]json.RawMessage
	if json.Unmarshal(raw, &requested) != nil {
		return false, identity.ErrInvalid
	}
	c, err := a.catalog(ctx)
	if err != nil {
		return false, err
	}
	validPart := map[string]bool{"rod": true, "line": true, "hook": true, "bait": true, "reel": true, "accessory": true, "charm": true}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,active) VALUES($1,-1,true) ON CONFLICT(owner_id,slot) DO NOTHING`, owner); err != nil {
		return false, err
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT slot FROM fishing.rod_loadouts WHERE owner_id=$1 AND active FOR UPDATE`, owner).Scan(&active); err != nil {
		return false, err
	}
	if operation == 0 {
		var err error
		operation, err = legacySnapshotOperation(ctx, tx, owner)
		if err != nil {
			return false, err
		}
	}
	changed := false
	if len(requested) == 0 {
		rows, err := tx.Query(ctx, `SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 FOR UPDATE`, owner, active)
		if err != nil {
			return false, err
		}
		var previous []int64
		for rows.Next() {
			var equipment int64
			if err := rows.Scan(&equipment); err != nil {
				rows.Close()
				return false, err
			}
			previous = append(previous, equipment)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return false, err
		}
		rows.Close()
		if _, err := tx.Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2`, owner, active); err != nil {
			return false, err
		}
		for _, equipment := range previous {
			if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed' WHERE id=$1 AND lifecycle='available'`, equipment); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume') ON CONFLICT DO NOTHING`, operation, equipment, owner); err != nil {
				return false, err
			}
		}
		return true, nil
	}
	for part, encoded := range requested {
		if !validPart[part] {
			return false, identity.ErrInvalid
		}
		var value any
		if json.Unmarshal(encoded, &value) != nil {
			return false, identity.ErrInvalid
		}
		compID := ""
		switch v := value.(type) {
		case string:
			compID = strings.TrimSpace(v)
		case map[string]any:
			if rawID, ok := v["compId"].(string); ok {
				compID = strings.TrimSpace(rawID)
			}
		case nil:
		default:
			return false, identity.ErrInvalid
		}
		if compID != "" {
			base, _, _, ok := c.Instance(compID)
			if !ok || base.Part != part {
				return false, identity.ErrInvalid
			}
			var boundEquipment int64
			boundErr := tx.QueryRow(ctx, `SELECT e.id FROM fishing.rod_components r JOIN fishing.equipment_instances e ON e.id=r.equipment_id
 WHERE r.owner_id=$1 AND r.slot=$2 AND r.part=$3 AND e.attributes->>'signature'=$4`, owner, active, part, compID).Scan(&boundEquipment)
			if boundErr == nil {
				// The requested component is already installed. Keep it in place;
				// this makes an idempotent admin save harmless.
				changed = true
				continue
			}
			if !errors.Is(boundErr, pgx.ErrNoRows) {
				return false, boundErr
			}
			var equipment int64
			err := tx.QueryRow(ctx, `SELECT e.id FROM fishing.equipment_instances e
 WHERE e.owner_id=$1 AND e.part=$2 AND e.lifecycle='available' AND e.attributes->>'signature'=$3
 AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id)
 ORDER BY e.id LIMIT 1 FOR UPDATE`, owner, part, compID).Scan(&equipment)
			if errors.Is(err, pgx.ErrNoRows) {
				return false, identity.ErrInvalid
			}
			if err != nil {
				return false, err
			}
			var previous int64
			_ = tx.QueryRow(ctx, `SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3`, owner, active, part).Scan(&previous)
			if _, err := tx.Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3`, owner, active, part); err != nil {
				return false, err
			}
			if previous > 0 {
				if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed' WHERE id=$1 AND lifecycle='available'`, previous); err != nil {
					return false, err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume') ON CONFLICT DO NOTHING`, operation, previous, owner); err != nil {
					return false, err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, owner, active, part, equipment); err != nil {
				return false, err
			}
		} else {
			var previous int64
			_ = tx.QueryRow(ctx, `SELECT equipment_id FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3`, owner, active, part).Scan(&previous)
			if _, err := tx.Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1 AND slot=$2 AND part=$3`, owner, active, part); err != nil {
				return false, err
			}
			if previous > 0 {
				if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET lifecycle='consumed' WHERE id=$1 AND lifecycle='available'`, previous); err != nil {
					return false, err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,previous_owner,action) VALUES($1,$2,$3,'consume') ON CONFLICT DO NOTHING`, operation, previous, owner); err != nil {
					return false, err
				}
			}
		}
		changed = true
	}
	return changed, nil
}

func (a *API) legacyAdminUserSnapshots(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorize(w, r, true); !ok {
		return
	}
	target := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("key")))
	id, exists, err := a.legacyAdminTarget(r.Context(), target)
	if err != nil {
		failure(w, err)
		return
	}
	if !exists {
		legacyTradeError(w, 404, "账号不存在")
		return
	}
	records, err := readLegacySnapshotRecords(r.Context(), a.pool, id, false)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	cfg, err := readLegacySnapshotCfg(r.Context(), a.pool)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	snapshots := make([]map[string]any, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		snapshots = append(snapshots, snapshotRecordSummary(records[i]))
	}
	write(w, 200, map[string]any{"ok": true, "key": target, "cfg": cfg, "count": len(snapshots), "snapshots": snapshots})
}

func (a *API) legacyAdminUserSnapshotNow(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target string `json:"target"`
	}
	if !decode(w, r, &in) {
		return
	}
	target := strings.ToLower(strings.TrimSpace(in.Target))
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cfg, err := readLegacySnapshotCfg(ctx, tx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	count := 0
	if target != "" {
		var id int64
		if err = tx.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1 AND NOT retired`, target).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
			legacyTradeError(w, 404, "账号不存在")
			return
		} else if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		if err := legacyAdminWriteGuard(ctx, tx, actor, id); err != nil {
			failure(w, err)
			return
		}
		if _, err = a.writeLegacySnapshotTx(ctx, tx, id, cfg); err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		count = 1
	} else {
		rows, qerr := tx.Query(ctx, `SELECT account_id FROM fishing.identities WHERE NOT retired ORDER BY account_id`)
		if qerr != nil {
			failure(w, identity.ErrStorage)
			return
		}
		var ids []int64
		for rows.Next() {
			var id int64
			if qerr = rows.Scan(&id); qerr != nil {
				rows.Close()
				failure(w, identity.ErrStorage)
				return
			}
			ids = append(ids, id)
		}
		if qerr = rows.Err(); qerr != nil {
			rows.Close()
			failure(w, identity.ErrStorage)
			return
		}
		rows.Close()
		if err := legacyAdminWriteGuard(ctx, tx, actor, ids...); err != nil {
			failure(w, err)
			return
		}
		for _, id := range ids {
			if _, err = a.writeLegacySnapshotTx(ctx, tx, id, cfg); err != nil {
				failure(w, identity.ErrStorage)
				return
			}
			count++
		}
	}
	if err = legacyAdminAudit(ctx, tx, actor, "users/snapshot-now", nil, target, "手动备份"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "key": func() any {
		if target == "" {
			return nil
		}
		return target
	}(), "count": count, "keep": cfg.Keep})
}

func (a *API) legacyAdminUserRollback(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Target  string `json:"target"`
		Snap    string `json:"snap"`
		Confirm bool   `json:"confirm"`
	}
	if !decode(w, r, &in) {
		return
	}
	target := strings.ToLower(strings.TrimSpace(in.Target))
	if !in.Confirm {
		legacyTradeError(w, 400, "回档需要二次确认")
		return
	}
	if !legacySnapshotName.MatchString(in.Snap) {
		legacyTradeError(w, 400, "快照名无效")
		return
	}
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err = tx.QueryRow(ctx, `SELECT account_id FROM fishing.identities WHERE username=$1 AND NOT retired`, target).Scan(&id); errors.Is(err, pgx.ErrNoRows) {
		legacyTradeError(w, 404, "账号不存在")
		return
	} else if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err := legacyAdminWriteGuard(ctx, tx, actor, id); err != nil {
		failure(w, err)
		return
	}
	records, err := readLegacySnapshotRecords(ctx, tx, id, true)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	var selected *legacySnapshotRecord
	for i := range records {
		if records[i].Name == in.Snap {
			selected = &records[i]
			break
		}
	}
	if selected == nil {
		legacyTradeError(w, 404, "快照不存在或已损坏")
		return
	}
	cfg, err := readLegacySnapshotCfg(ctx, tx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if _, err = a.writeLegacySnapshotTx(ctx, tx, id, cfg); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = a.applyLegacySnapshotTx(ctx, tx, id, actor.AccountID, selected.View); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = legacyAdminAudit(ctx, tx, actor, "users/rollback", &id, target, in.Snap); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	view, err := a.legacyAdminSnapshotView(ctx, id)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	write(w, 200, map[string]any{"ok": true, "key": target, "snap": in.Snap, "coins": view["coins"], "inventory": view["inventory"], "invRev": view["invRev"]})
}

// Restore bindings before loose inventory: inventory deliberately excludes all
// saved/active rod components. A component that became loose since the snapshot
// must not be consumed before its original binding can be restored.
func (a *API) restoreLegacySnapshotRods(ctx context.Context, tx pgx.Tx, owner, operation int64, view map[string]any) error {
	loadouts, err := readLegacySnapshotLoadouts(ctx, tx, owner)
	if err != nil {
		return err
	}
	_, complete := view["_rodLoadouts"]
	if raw, ok := view["_rodLoadouts"]; ok {
		encoded, err := json.Marshal(raw)
		// Decode into fresh maps. Reusing the current slice lets json.Unmarshal
		// merge Parts maps and retain components absent from the snapshot.
		loadouts = nil
		if err != nil || json.Unmarshal(encoded, &loadouts) != nil {
			return identity.ErrInvalid
		}
	} else {
		// Old records only captured the active assembly. Retain other saved
		// rods, but replace the active parts exactly (including absent parts).
		raw, ok := view["bd"]
		if !ok {
			return nil
		}
		encoded, err := json.Marshal(raw)
		var bd map[string]struct {
			CompID string `json:"compId"`
		}
		if err != nil || json.Unmarshal(encoded, &bd) != nil {
			return identity.ErrInvalid
		}
		parts := map[string]string{}
		for part, value := range bd {
			if value.CompID != "" {
				parts[part] = value.CompID
			}
		}
		found := false
		for i := range loadouts {
			if loadouts[i].Active {
				loadouts[i].Parts, found = parts, true
			}
		}
		if !found {
			loadouts = append(loadouts, legacySnapshotLoadout{Slot: -1, Active: true, Parts: parts})
		}
	}
	if len(loadouts) == 0 {
		loadouts = []legacySnapshotLoadout{{Slot: -1, Active: true}}
	}
	catalog, err := a.catalog(ctx)
	if err != nil {
		return err
	}
	slots, activeCount := map[int]bool{}, 0
	for _, loadout := range loadouts {
		if loadout.Slot < -1 || loadout.Slot > 7 || slots[loadout.Slot] {
			return identity.ErrInvalid
		}
		slots[loadout.Slot] = true
		if loadout.Active {
			activeCount++
		}
		for part, signature := range loadout.Parts {
			if base, _, _, ok := catalog.Instance(signature); !ok || base.Part != part {
				return identity.ErrInvalid
			}
		}
	}
	if activeCount != 1 {
		return identity.ErrInvalid
	}
	before, err := legacySnapshotRodState(ctx, tx, owner)
	if err != nil {
		return err
	}
	// Select from every still-owned available instance, including saved rods.
	// Escrow and transferred/consumed instances must never be resurrected.
	rows, err := tx.Query(ctx, `SELECT id,COALESCE(attributes->>'signature','') FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available' ORDER BY id FOR UPDATE`, owner)
	if err != nil {
		return err
	}
	available := map[string][]int64{}
	for rows.Next() {
		var id int64
		var signature string
		if err := rows.Scan(&id, &signature); err != nil {
			rows.Close()
			return err
		}
		available[signature] = append(available[signature], id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if !complete {
		// An old snapshot cannot tell whether a currently saved component was
		// moved there from its active assembly. When no other held copy exists,
		// move that binding back instead of minting a duplicate of the asset.
		counts := map[string]int{}
		for _, loadout := range loadouts {
			for _, signature := range loadout.Parts {
				counts[signature]++
			}
		}
		for _, loadout := range loadouts {
			if loadout.Active {
				continue
			}
			for part, signature := range loadout.Parts {
				if counts[signature] > len(available[signature]) {
					delete(loadout.Parts, part)
					counts[signature]--
				}
			}
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM fishing.rod_components WHERE owner_id=$1`, owner); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE fishing.rod_loadouts SET active=false,name='' WHERE owner_id=$1`, owner); err != nil {
		return err
	}
	for _, loadout := range loadouts {
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,$2,$3,$4)
 ON CONFLICT(owner_id,slot) DO UPDATE SET name=excluded.name,active=excluded.active`, owner, loadout.Slot, loadout.Name, loadout.Active); err != nil {
			return err
		}
		for part, signature := range loadout.Parts {
			var id int64
			if candidates := available[signature]; len(candidates) > 0 {
				id, available[signature] = candidates[0], candidates[1:]
			} else {
				base, _, _, _ := catalog.Instance(signature)
				attributes, _ := json.Marshal(map[string]string{"signature": signature})
				if err := tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES($1,$2,$3,$4,$5) RETURNING id`, owner, base.ID, part, attributes, operation).Scan(&id); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, operation, id, owner); err != nil {
					return err
				}
			}
			if b := loadout.Bindings[part]; b.Bound > 0 {
				if _, err := tx.Exec(ctx, `UPDATE fishing.equipment_instances SET reward_bound=true,bind_outputs=bind_outputs OR $2 WHERE id=$1`, id, b.Inherit > 0); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, owner, loadout.Slot, part, id); err != nil {
				return err
			}
		}
	}
	return recordLegacySnapshotRodChange(ctx, tx, owner, operation, before)
}

func (a *API) applyLegacySnapshotTx(ctx context.Context, tx pgx.Tx, owner, actor int64, view map[string]any) error {
	coins, ok := snapshotNumber(view["coins"])
	if !ok || coins < 0 || coins > 9007199254740991 {
		return errors.New("invalid snapshot coins")
	}
	operation, err := legacySnapshotOperation(ctx, tx, actor)
	if err != nil {
		return err
	}
	var beforeCoins int64
	if err := tx.QueryRow(ctx, `SELECT coins FROM fishing.wallets WHERE account_id=$1 FOR UPDATE`, owner).Scan(&beforeCoins); err != nil {
		return err
	}
	afterCoins := int64(math.Floor(coins))
	if _, err := tx.Exec(ctx, `UPDATE fishing.wallets SET coins=$2 WHERE account_id=$1`, owner, afterCoins); err != nil {
		return err
	}
	if delta := afterCoins - beforeCoins; delta != 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES($1,$2,$3,$4)`, operation, owner, delta, afterCoins); err != nil {
			return err
		}
	}
	if err := a.restoreLegacySnapshotRods(ctx, tx, owner, operation, view); err != nil {
		return err
	}
	if err := a.applySnapshotInventory(ctx, tx, owner, operation, view); err != nil {
		return err
	}
	if n, valid := snapshotNumber(view["catchCount"]); valid && n >= 0 {
		if _, err := tx.Exec(ctx, `UPDATE fishing.player_state SET catch_count=$2,assets_rev=assets_rev+1 WHERE account_id=$1`, owner, int64(math.Floor(n))); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=$1`, owner); err != nil {
		return err
	}
	if raw, ok := view["codex"].(map[string]any); ok {
		if _, err := tx.Exec(ctx, `DELETE FROM fishing.player_codex WHERE owner_id=$1`, owner); err != nil {
			return err
		}
		for id, value := range raw {
			entry, ok := value.(map[string]any)
			if !ok {
				continue
			}
			count, valid := snapshotNumber(entry["count"])
			if !valid || count <= 0 {
				continue
			}
			first := time.Now()
			if n, valid := snapshotNumber(entry["first"]); valid && n > 0 {
				first = time.UnixMilli(int64(n))
			}
			tier := "normal"
			if t, ok := entry["tier"].(string); ok && (t == "large" || t == "giant") {
				tier = t
			}
			var minSize, maxSize *float64
			if n, valid := snapshotNumber(entry["min"]); valid {
				minSize = &n
			}
			if n, valid := snapshotNumber(entry["max"]); valid {
				maxSize = &n
			}
			if _, err := tx.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at,min_size,max_size,best_tier) VALUES($1,$2,$3,$4,$5,$6,$7)`, owner, id, int64(math.Floor(count)), first, minSize, maxSize, tier); err != nil {
				return err
			}
		}
	}
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT assets_rev FROM fishing.player_state WHERE account_id=$1`, owner).Scan(&revision); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"actor": strconv.FormatInt(owner, 10), "players": []string{strconv.FormatInt(owner, 10)}})
	var outboxID int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES($1,'assets_changed',$2) RETURNING id`, operation, payload).Scan(&outboxID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.player_events(owner_id,revision,outbox_id) VALUES($1,$2,$3)`, owner, revision, outboxID); err != nil {
		return err
	}
	return nil
}

func (a *API) legacyAdminSnapshotConfig(w http.ResponseWriter, r *http.Request) {
	actor, ok := a.authorize(w, r, true)
	if !ok {
		return
	}
	var in struct {
		Cfg   map[string]json.RawMessage `json:"cfg"`
		Reset bool                       `json:"reset"`
	}
	if !decode(w, r, &in) {
		return
	}
	ctx := r.Context()
	cfg, err := readLegacySnapshotCfg(ctx, a.pool)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if in.Reset {
		cfg = defaultLegacySnapshotCfg()
	}
	if raw, ok := in.Cfg["enabled"]; ok {
		if err := json.Unmarshal(raw, &cfg.Enabled); err != nil {
			legacyTradeError(w, 400, "存档策略格式错误")
			return
		}
	}
	if raw, ok := in.Cfg["intervalMin"]; ok {
		var n float64
		if json.Unmarshal(raw, &n) != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			legacyTradeError(w, 400, "存档间隔无效")
			return
		}
		cfg.IntervalMin = int(math.Floor(n))
	}
	if raw, ok := in.Cfg["keep"]; ok {
		var n float64
		if json.Unmarshal(raw, &n) != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			legacyTradeError(w, 400, "保留份数无效")
			return
		}
		cfg.Keep = int(math.Floor(n))
	}
	cfg = normalizeLegacySnapshotCfg(cfg)
	raw, _ := json.Marshal(cfg)
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := legacyAdminWriteGuard(ctx, tx, actor); err != nil {
		failure(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, legacySnapshotCfgKey, raw); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = legacyAdminAudit(ctx, tx, actor, "snapshot/config", nil, "", "保存存档策略"); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, identity.ErrCommitUnknown)
		return
	}
	write(w, 200, map[string]any{"ok": true, "cfg": cfg})
}

// Compile-time assertion documents why tx can be passed to legacyInventoryFrom.
var _ assets.SQL = (pgx.Tx)(nil)
