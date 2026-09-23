package migration

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// RealAccountSummary deliberately contains no account identifiers or credentials.
type RealAccountSummary struct {
	Accounts  int `json:"accounts"`
	Equipment int `json:"equipment"`
	Stacks    int `json:"stacks"`
	Codex     int `json:"codex"`
	Friends   int `json:"friendRelations"`
	MFA       int `json:"mfaAccounts"`
}

type realStack struct {
	Item, Kind, Tier string
	Quantity         int64
}
type realRod struct {
	Slot   int
	Name   string
	Active bool
	Parts  map[string]string
}
type realAccountPlan struct {
	Source                                      RealAccount
	Username, Name, QQ, Hash, Salt, Secret      string
	Coins, Catches, Capacity, Listings, MFAStep int64
	Created                                     time.Time
	Admin, Banned                               bool
	Stacks                                      []realStack
	Loose                                       map[string]int64
	Rods                                        []realRod
	Codex                                       map[string]any
	Auto, Sub, Pity, Mall, Ship, Sea            map[string]any
}

var realUsername = regexp.MustCompile(`^[a-z0-9_]{3,20}$`)
var realQQ = regexp.MustCompile(`^[0-9]{5,12}$`)
var realHash = regexp.MustCompile(`^(scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{64}|[a-f0-9]{64})$`)
var realLegacyMFAHex = regexp.MustCompile(`^[a-fA-F0-9]{40}$`)

func realMFASecret(source string) (string, error) {
	if source == "" {
		return "", nil
	}
	// Node security.totp used Buffer.from(secret, 'hex'); its enrollment URL
	// displayed those same bytes as Base32. Go stores that Base32 representation
	// under authenticated encryption, preserving every existing authenticator.
	if realLegacyMFAHex.MatchString(source) {
		raw, e := hex.DecodeString(source)
		if e != nil {
			return "", errors.New("mfa_encoding_invalid")
		}
		return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw), nil
	}
	normal := strings.ToUpper(strings.TrimRight(source, "="))
	raw, e := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normal)
	if e != nil || len(raw) < 10 {
		return "", errors.New("mfa_encoding_invalid")
	}
	return normal, nil
}

func realObject(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}
func realArray(v any) []any   { a, _ := v.([]any); return a }
func realString(v any) string { s, _ := v.(string); return s }
func realBool(v any) bool     { b, _ := v.(bool); return b }
func realInteger(v any, fallback int64) (int64, error) {
	if v == nil {
		return fallback, nil
	}
	var n int64
	switch x := v.(type) {
	case json.Number:
		var err error
		n, err = x.Int64()
		if err != nil {
			return 0, errors.New("non_integer")
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Trunc(x) != x || math.Abs(x) > 9007199254740991 {
			return 0, errors.New("non_integer")
		}
		n = int64(x)
	case int64:
		n = x
	case int:
		n = int64(x)
	default:
		return 0, errors.New("non_integer")
	}
	if n < -9007199254740991 || n > 9007199254740991 {
		return 0, errors.New("integer_range")
	}
	return n, nil
}
func realNonnegative(v any, fallback int64) (int64, error) {
	n, e := realInteger(v, fallback)
	if e != nil || n < 0 {
		return 0, errors.New("nonnegative_required")
	}
	return n, nil
}
func realOptionalFloat(v any) (*float64, error) {
	if v == nil {
		return nil, nil
	}
	var n float64
	switch x := v.(type) {
	case json.Number:
		var e error
		n, e = x.Float64()
		if e != nil {
			return nil, errors.New("invalid_decimal")
		}
	case float64:
		n = x
	case int64:
		n = float64(x)
	case int:
		n = float64(x)
	default:
		return nil, errors.New("invalid_decimal")
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return nil, errors.New("invalid_positive_decimal")
	}
	return &n, nil
}
func realJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func realKeys(m map[string]any) []string {
	k := make([]string, 0, len(m))
	for s := range m {
		k = append(k, s)
	}
	sort.Strings(k)
	return k
}

func realParts(c *rules.Catalog, value any) (map[string]string, error) {
	out := map[string]string{}
	for part, raw := range realObject(value) {
		if raw == nil {
			continue
		}
		sig := realString(realObject(raw)["compId"])
		// Legacy empty equipment UI slots retain metadata with an empty compId;
		// rodPartsOfBd ignored these and they represent no owned asset.
		if sig == "" {
			continue
		}
		base, _, _, ok := c.Instance(sig)
		if !ok || base.Part != part {
			return nil, errors.New("rod_component_invalid")
		}
		out[part] = sig
	}
	return out, nil
}

// Every nested object has an explicit schema. Cached display fields (component
// name/affixes/rare/isCharm), rod slot timestamp t, quest kind, xpNotified and
// lastFishing are retained in the immutable source archive; the signature,
// binding, quest ID and durable progress are the gameplay authorities. Allowing
// these known legacy fields does not authorize silently accepting future fields.
func realCheckKeys(value any, allowed, label string) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("invalid_account_" + label + "_structure")
	}
	known := map[string]bool{}
	for _, key := range strings.Fields(allowed) {
		known[key] = true
	}
	for key := range m {
		if !known[key] {
			return nil, errors.New("unmapped_account_" + label + "_field")
		}
	}
	return m, nil
}

func realCheckObject(value any, label string) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("invalid_account_" + label + "_structure")
	}
	return m, nil
}

func realCheckArray(value any, label string) ([]any, error) {
	if value == nil {
		return nil, nil
	}
	a, ok := value.([]any)
	if !ok {
		return nil, errors.New("invalid_account_" + label + "_structure")
	}
	return a, nil
}

func validateRealBD(value any) error {
	bd, e := realCheckKeys(value, "rod line hook bait reel accessory charm", "bd")
	if e != nil {
		return e
	}
	for _, raw := range bd {
		component, e := realCheckKeys(raw, "compId name affixes rare isCharm", "component")
		if e != nil {
			return e
		}
		affixes, e := realCheckArray(component["affixes"], "component_affixes")
		if e != nil {
			return e
		}
		for _, affix := range affixes {
			if _, e = realCheckKeys(affix, "type value extra src srcExplicit", "component_affix"); e != nil {
				return e
			}
		}
	}
	return nil
}

func validateRealAccountStructures(c *rules.Catalog, m map[string]any) error {
	if e := validateRealBD(m["bd"]); e != nil {
		return e
	}
	slots, e := realCheckArray(m["rodSlots"], "rod_slots")
	if e != nil {
		return e
	}
	for _, raw := range slots {
		slot, e := realCheckKeys(raw, "name bd t", "rod_slot")
		if e != nil {
			return e
		}
		if e = validateRealBD(slot["bd"]); e != nil {
			return e
		}
	}
	if _, e = realCheckObject(m["inventory"], "inventory"); e != nil {
		return e
	}
	codex, e := realCheckObject(m["codex"], "codex")
	if e != nil {
		return e
	}
	for item, raw := range codex {
		if _, ok := c.Item(item); !ok {
			return errors.New("unknown_codex_item")
		}
		if _, e = realCheckKeys(raw, "count first min max tier", "codex_entry"); e != nil {
			return e
		}
	}
	bigfish, e := realCheckObject(m["bigfish"], "bigfish")
	if e != nil {
		return e
	}
	for item, raw := range bigfish {
		base, ok := c.Item(item)
		if !ok || base.Kind != "fish" {
			return errors.New("unknown_bigfish_item")
		}
		if _, e = realCheckKeys(raw, "L G", "bigfish_entry"); e != nil {
			return e
		}
	}
	pity, e := realCheckObject(m["chestPity"], "chest_pity")
	if e != nil {
		return e
	}
	for item, raw := range pity {
		base, ok := c.Item(item)
		if !ok || base.Kind != "chest" {
			return errors.New("unknown_chest_pity_item")
		}
		if _, e = realNonnegative(raw, 0); e != nil {
			return errors.New("invalid_chest_pity_count")
		}
	}
	mall, e := realCheckKeys(m["mall"], "key bought", "mall")
	if e != nil {
		return e
	}
	bought, e := realCheckObject(mall["bought"], "mall_bought")
	if e != nil {
		return e
	}
	for item, raw := range bought {
		if _, ok := c.Item(item); !ok {
			return errors.New("unknown_mall_item")
		}
		if _, e = realNonnegative(raw, 0); e != nil {
			return errors.New("invalid_mall_quantity")
		}
	}
	if _, e = realCheckKeys(m["ship"], "lv xp", "ship"); e != nil {
		return e
	}
	sea, e := realCheckKeys(m["sea"], "charts zones quests xpNotified", "sea")
	if e != nil {
		return e
	}
	if _, e = realCheckArray(sea["zones"], "sea_zones"); e != nil {
		return e
	}
	quests, e := realCheckKeys(sea["quests"], "day list", "sea_quests")
	if e != nil {
		return e
	}
	list, e := realCheckArray(quests["list"], "sea_quest_list")
	if e != nil {
		return e
	}
	for _, raw := range list {
		q, e := realCheckKeys(raw, "id kind progress claimed", "sea_quest")
		if e != nil {
			return e
		}
		id := realString(q["id"])
		found := false
		for _, tpl := range c.SeaConfig().Quests {
			if tpl.ID == id {
				found = true
				break
			}
		}
		if !found {
			return errors.New("unknown_quest_template")
		}
		// Node resolved the current quest template by ID too. Saved kind is a
		// historical display cache: old submit_deepscale rows now use submit.
		// Keep the original kind in the source archive without rewriting it.
		if kind, exists := q["kind"]; exists {
			if _, ok := kind.(string); !ok {
				return errors.New("invalid_quest_kind_cache")
			}
		}
	}
	if _, e = realCheckKeys(m["subNotify"], "on baseId quality affixType min max badge blink", "subscription"); e != nil {
		return e
	}
	auto, e := realCheckKeys(m["autoSell"], "items tier", "autosell")
	if e != nil {
		return e
	}
	items, e := realCheckObject(auto["items"], "autosell_items")
	if e != nil {
		return e
	}
	for item, raw := range items {
		if _, ok := c.Item(item); !ok {
			return errors.New("unknown_autosell_item")
		}
		if _, e = realCheckKeys(raw, "on minPct minPrice slackPct slackPrice keep", "autosell_rule"); e != nil {
			return e
		}
	}
	if _, e = realCheckKeys(m["lastFishing"], "groundId spotId at", "last_fishing"); e != nil {
		return e
	}
	for _, field := range []string{"friends", "freqIn", "freqOut"} {
		values, e := realCheckArray(m[field], "social")
		if e != nil {
			return e
		}
		for _, v := range values {
			if _, ok := v.(string); !ok {
				return errors.New("invalid_social_reference")
			}
		}
	}
	return nil
}

func planRealAccount(rc *RealContext, a RealAccount) (realAccountPlan, error) {
	m := a.Payload
	allowed := strings.Fields("username salt pwHash passwordHash name displayName qq coins inventory bd codex catchCount createdAt rodSlots mall bigfish chestPity rodName rodActiveSlot ship sea lastFishing freqIn freqOut rodSlotsCount autoSell friends admin adminTotpSecret adminTotpStep subNotify partyId listingCap partyInv banned id")
	known := map[string]bool{}
	for _, k := range allowed {
		known[k] = true
	}
	for k := range m {
		if !known[k] {
			return realAccountPlan{}, errors.New("unmapped_account_field")
		}
	}
	if err := validateRealAccountStructures(rc.Catalog, m); err != nil {
		return realAccountPlan{}, err
	}
	p := realAccountPlan{Source: a, Username: strings.ToLower(realString(m["username"])), Name: realString(m["name"]), QQ: realString(m["qq"]), Hash: realString(m["pwHash"]), Salt: realString(m["salt"]), Secret: realString(m["adminTotpSecret"]), Admin: realBool(m["admin"]), Banned: realBool(m["banned"]), Loose: map[string]int64{}, Codex: realObject(m["codex"]), Auto: realObject(m["autoSell"]), Sub: realObject(m["subNotify"]), Pity: realObject(m["chestPity"]), Mall: realObject(m["mall"]), Ship: realObject(m["ship"]), Sea: realObject(m["sea"])}
	if p.Username == "" {
		p.Username = strings.ToLower(a.Key)
	}
	if p.Name == "" {
		p.Name = realString(m["displayName"])
	}
	if p.Hash == "" {
		p.Hash = realString(m["passwordHash"])
	}
	if !realUsername.MatchString(p.Username) || !realQQ.MatchString(p.QQ) || !realHash.MatchString(p.Hash) || len([]rune(p.Name)) < 1 || len([]rune(p.Name)) > 40 {
		return p, errors.New("invalid_identity")
	}
	var err error
	p.Secret, err = realMFASecret(p.Secret)
	if err != nil {
		return p, err
	}
	for _, f := range []struct {
		raw      any
		fallback int64
		dest     *int64
	}{{m["coins"], 0, &p.Coins}, {m["catchCount"], 0, &p.Catches}, {m["rodSlotsCount"], 1, &p.Capacity}, {m["listingCap"], 40, &p.Listings}} {
		*f.dest, err = realNonnegative(f.raw, f.fallback)
		if err != nil {
			return p, err
		}
	}
	if p.Capacity < 1 || p.Capacity > 8 || p.Listings > 10000 {
		return p, errors.New("invalid_capacity")
	}
	p.MFAStep, err = realInteger(m["adminTotpStep"], -1)
	if err != nil || p.MFAStep < -1 {
		return p, errors.New("invalid_mfa_step")
	}
	created, err := realNonnegative(m["createdAt"], 0)
	if err != nil || created == 0 {
		return p, errors.New("invalid_created_at")
	}
	p.Created = time.UnixMilli(created)
	for _, item := range realKeys(realObject(m["inventory"])) {
		qty, e := realNonnegative(realObject(m["inventory"])[item], 0)
		if e != nil {
			return p, e
		}
		if base, _, _, ok := rc.Catalog.Instance(item); ok && base.Part != "" {
			p.Loose[item] = qty
			continue
		}
		base, ok := rc.Catalog.Item(item)
		if !ok || base.Kind == "component" {
			return p, errors.New("unknown_inventory_item")
		}
		kind := base.Kind
		if kind != "fish" && kind != "material" && kind != "chest" {
			return p, errors.New("invalid_inventory_kind")
		}
		bf := realObject(realObject(m["bigfish"])[item])
		large, e := realNonnegative(bf["L"], 0)
		if e != nil {
			return p, e
		}
		giant, e := realNonnegative(bf["G"], 0)
		if e != nil {
			return p, e
		}
		if large+giant > qty || (kind != "fish" && (large+giant) > 0) {
			return p, errors.New("invalid_tier_reservation")
		}
		p.Stacks = append(p.Stacks, realStack{item, kind, "normal", qty - large - giant})
		if kind == "fish" {
			p.Stacks = append(p.Stacks, realStack{item, kind, "large", large}, realStack{item, kind, "giant", giant})
		}
	}
	for item, raw := range realObject(m["bigfish"]) {
		if _, ok := realObject(m["inventory"])[item]; !ok {
			bf := realObject(raw)
			l, _ := realNonnegative(bf["L"], 0)
			g, _ := realNonnegative(bf["G"], 0)
			if l+g > 0 {
				return p, errors.New("orphan_tier_reservation")
			}
		}
	}
	active, e := realInteger(m["rodActiveSlot"], -1)
	if e != nil || active < -1 || active > 7 {
		return p, errors.New("invalid_active_slot")
	}
	bd, e := realParts(rc.Catalog, m["bd"])
	if e != nil {
		return p, e
	}
	slots := realArray(m["rodSlots"])
	if len(slots) > 8 {
		return p, errors.New("too_many_rod_slots")
	}
	for i, raw := range slots {
		if raw == nil {
			continue
		}
		s := realObject(raw)
		parts, e := realParts(rc.Catalog, s["bd"])
		if e != nil {
			return p, e
		}
		if len(parts) == 0 {
			continue
		}
		if int64(i) >= p.Capacity {
			return p, errors.New("locked_rod_slot")
		}
		name := realString(s["name"])
		if len([]rune(name)) > 20 {
			return p, errors.New("rod_name_too_long")
		}
		p.Rods = append(p.Rods, realRod{i, name, int64(i) == active, parts})
	}
	if active >= 0 {
		found := false
		for _, r := range p.Rods {
			if r.Active {
				found = true
				if !reflect.DeepEqual(r.Parts, bd) {
					return p, errors.New("active_rod_differs")
				}
			}
		}
		if !found {
			return p, errors.New("active_rod_missing")
		}
	} else {
		name := realString(m["rodName"])
		if len([]rune(name)) > 20 {
			return p, errors.New("rod_name_too_long")
		}
		p.Rods = append(p.Rods, realRod{-1, name, true, bd})
	}
	if len(realArray(p.Sea["zones"])) != 0 {
		return p, errors.New("sea_zones_require_mapper")
	}
	return p, nil
}

// ImportRealEquipment retains the exact component signature; catalog rules resolve
// it during normal gameplay. Equipment in rods and market escrow is additional to
// the old free inventory, as the old equip/list actions deducted it immediately.
func ImportRealEquipment(ctx context.Context, rc *RealContext, owner, operation int64, signature string) (int64, error) {
	base, _, _, ok := rc.Catalog.Instance(signature)
	if !ok {
		return 0, errors.New("invalid_equipment_signature")
	}
	var id int64
	if err := rc.Tx.QueryRow(ctx, `INSERT INTO fishing.equipment_instances(owner_id,definition_id,part,attributes,created_operation) VALUES($1,$2,$3,$4,$5) RETURNING id`, owner, base.ID, base.Part, realJSON(map[string]any{"signature": signature}), operation).Scan(&id); err != nil {
		return 0, err
	}
	_, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) VALUES($1,$2,$3,'create')`, operation, id, owner)
	return id, err
}

func realOperation(ctx context.Context, rc *RealContext, owner int64, suffix, kind string) (int64, error) {
	key := "legacy:" + rc.RunID + ":" + suffix
	h := sha256.Sum256([]byte(key))
	var op int64
	if _, e := rc.Tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash,result) VALUES($1,$2,$3,'{}')`, owner, key, h[:]); e != nil {
		return 0, e
	}
	if e := rc.Tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,$2,$3,$4) RETURNING id`, owner, key, kind, ToolVersion+":real").Scan(&op); e != nil {
		return 0, e
	}
	_, e := rc.Tx.Exec(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload,delivered_at) VALUES($1,'assets_changed','{}',clock_timestamp())`, op)
	return op, e
}

func ImportRealAccounts(ctx context.Context, rc *RealContext, accounts []RealAccount) (RealAccountSummary, error) {
	var summary RealAccountSummary
	if rc.IDs == nil {
		rc.IDs = map[string]int64{}
	}
	for index, a := range accounts {
		p, err := planRealAccount(rc, a)
		if err != nil {
			return summary, fmt.Errorf("account_%d:%w", index, err)
		}
		var id int64
		if err = rc.Tx.QueryRow(ctx, `INSERT INTO fishing.accounts(created_at) VALUES($1) RETURNING id`, p.Created).Scan(&id); err != nil {
			return summary, err
		}
		if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.player_state(account_id,catch_count,rod_capacity,listing_capacity) VALUES($1,$2,$3,$4)`, id, p.Catches, p.Capacity, p.Listings); err != nil {
			return summary, err
		}
		if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,$2)`, id, p.Coins); err != nil {
			return summary, err
		}
		var sealed []byte
		if p.Secret != "" {
			sealed, err = identity.EncryptMFA(rc.MFAKey, id, p.Secret)
			if err != nil {
				return summary, errors.New("mfa_encryption_failed")
			}
			summary.MFA++
		}
		if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.identities(account_id,username,display_name,qq,password_hash,legacy_salt,admin,banned,mfa_secret,mfa_last_step) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, p.Username, p.Name, p.QQ, p.Hash, p.Salt, p.Admin, p.Banned, sealed, p.MFAStep); err != nil {
			return summary, err
		}
		for _, alias := range []string{a.Key, p.Username, realString(a.Payload["id"])} {
			if alias != "" {
				key := strings.ToLower(alias)
				if old, ok := rc.IDs[key]; ok && old != id {
					return summary, errors.New("duplicate_account_alias")
				}
				rc.IDs[key] = id
			}
		}
		if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.legacy_id_map(run_id,domain,legacy_id,new_id) VALUES($1,'account',$2,$3)`, rc.RunID, a.Key, strconv.FormatInt(id, 10)); err != nil {
			return summary, err
		}
		op, err := realOperation(ctx, rc, id, "account-opening", "asset_change")
		if err != nil {
			return summary, err
		}
		if p.Coins > 0 {
			if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES($1,$2,$3,$3)`, op, id, p.Coins); err != nil {
				return summary, err
			}
		}
		for _, s := range p.Stacks {
			if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.inventory_stacks(owner_id,item_id,kind,tier,quantity) VALUES($1,$2,$3,$4,$5)`, id, s.Item, s.Kind, s.Tier, s.Quantity); err != nil {
				return summary, err
			}
			if s.Quantity > 0 {
				if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.inventory_entries(operation_id,owner_id,item_id,tier,delta,quantity_after) VALUES($1,$2,$3,$4,$5,$5)`, op, id, s.Item, s.Tier, s.Quantity); err != nil {
					return summary, err
				}
			}
			summary.Stacks++
		}
		looseRows := make([][]any, 0)
		for sig, n := range p.Loose {
			if n > 100000 {
				return summary, errors.New("equipment_quantity_requires_review")
			}
			base, _, _, ok := rc.Catalog.Instance(sig)
			if !ok {
				return summary, errors.New("invalid_equipment_signature")
			}
			attrs := realJSON(map[string]any{"signature": sig})
			for j := int64(0); j < n; j++ {
				looseRows = append(looseRows, []any{id, base.ID, base.Part, attrs, op})
				summary.Equipment++
			}
		}
		if len(looseRows) > 0 {
			if copied, e := rc.Tx.CopyFrom(ctx, pgx.Identifier{"fishing", "equipment_instances"}, []string{"owner_id", "definition_id", "part", "attributes", "created_operation"}, pgx.CopyFromRows(looseRows)); e != nil {
				return summary, e
			} else if copied != int64(len(looseRows)) {
				return summary, errors.New("equipment_copy_incomplete")
			}
			if _, e := rc.Tx.Exec(ctx, `INSERT INTO fishing.equipment_entries(operation_id,equipment_id,next_owner,action) SELECT $1,id,$2,'create' FROM fishing.equipment_instances WHERE created_operation=$1`, op, id); e != nil {
				return summary, e
			}
		}
		for _, rod := range p.Rods {
			if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.rod_loadouts(owner_id,slot,name,active) VALUES($1,$2,$3,$4)`, id, rod.Slot, rod.Name, rod.Active); err != nil {
				return summary, err
			}
			for part, sig := range rod.Parts {
				eid, e := ImportRealEquipment(ctx, rc, id, op, sig)
				if e != nil {
					return summary, e
				}
				if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.rod_components(owner_id,slot,part,equipment_id) VALUES($1,$2,$3,$4)`, id, rod.Slot, part, eid); err != nil {
					return summary, err
				}
				summary.Equipment++
			}
		}
		if _, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.rod_entries(operation_id,owner_id,before_state,after_state) VALUES($1,$2,'[]',$3)`, op, id, realJSON(p.Rods)); err != nil {
			return summary, err
		}
		if err = importRealPersonal(ctx, rc, id, op, p, &summary); err != nil {
			return summary, fmt.Errorf("account_%d:%w", index, err)
		}
		summary.Accounts++
	}
	n, err := importRealFriends(ctx, rc, accounts)
	summary.Friends = n
	return summary, err
}

func importRealPersonal(ctx context.Context, rc *RealContext, id, op int64, p realAccountPlan, summary *RealAccountSummary) error {
	for item, raw := range p.Codex {
		if _, ok := rc.Catalog.Item(item); !ok {
			return errors.New("unknown_codex_item")
		}
		m := realObject(raw)
		n, e := realNonnegative(m["count"], 0)
		if e != nil || n == 0 {
			return errors.New("invalid_codex_count")
		}
		first, e := realNonnegative(m["first"], 0)
		if e != nil || first == 0 {
			return errors.New("invalid_codex_first")
		}
		tier := map[string]string{"L": "large", "G": "giant", "large": "large", "giant": "giant", "normal": "normal", "": "normal"}[realString(m["tier"])]
		if tier == "" {
			return errors.New("invalid_codex_tier")
		}
		minSize, e := realOptionalFloat(m["min"])
		if e != nil {
			return e
		}
		maxSize, e := realOptionalFloat(m["max"])
		if e != nil {
			return e
		}
		if minSize != nil && maxSize != nil && *minSize > *maxSize {
			return errors.New("invalid_codex_size_range")
		}
		if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.player_codex(owner_id,item_id,count,first_at,min_size,max_size,best_tier) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, item, n, time.UnixMilli(first), minSize, maxSize, tier); e != nil {
			return e
		}
		summary.Codex++
	}
	if len(p.Auto) > 0 {
		if _, e := rc.Tx.Exec(ctx, `INSERT INTO fishing.autosell_settings(owner_id,include_tiers,rules) VALUES($1,$2,$3)`, id, realBool(p.Auto["tier"]), realJSON(realObject(p.Auto["items"]))); e != nil {
			return e
		}
	}
	if len(p.Sub) > 0 {
		if _, e := rc.Tx.Exec(ctx, `INSERT INTO fishing.subscription_settings(account_id,config) VALUES($1,$2)`, id, realJSON(p.Sub)); e != nil {
			return e
		}
	}
	for item, raw := range p.Pity {
		n, e := realNonnegative(raw, 0)
		if e != nil {
			return e
		}
		if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.chest_pity(owner_id,chest_id,misses) VALUES($1,$2,$3)`, id, item, n); e != nil {
			return e
		}
	}
	if len(p.Mall) > 0 {
		day := realString(p.Mall["key"])
		if _, e := time.Parse("2006-01-02", day); e != nil {
			return errors.New("invalid_mall_day")
		}
		for item, raw := range realObject(p.Mall["bought"]) {
			n, e := realNonnegative(raw, 0)
			if e != nil {
				return e
			}
			if n == 0 {
				continue
			}
			if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.mall_purchases(owner_id,item_id,cycle_key,quantity) VALUES($1,$2,$3::date,$4)`, id, item, day, n); e != nil {
				return e
			}
		}
	}
	if len(p.Ship) > 0 || len(p.Sea) > 0 {
		level, e := realNonnegative(p.Ship["lv"], 1)
		if e != nil || level < 1 || level > 5 {
			return errors.New("invalid_ship_level")
		}
		xp, e := realNonnegative(p.Ship["xp"], 0)
		if e != nil {
			return e
		}
		charts, e := realNonnegative(p.Sea["charts"], 0)
		if e != nil {
			return e
		}
		if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.sea_players(owner_id,level,experience,charts) VALUES($1,$2,$3,$4)`, id, level, xp, charts); e != nil {
			return e
		}
		for k, n := range map[string]int64{"level": level, "experience": xp, "charts": charts} {
			if n > 0 {
				if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.sea_progress_entries(operation_id,owner_id,field,delta,after_value) VALUES($1,$2,$3,$4,$4)`, op, id, k, n); e != nil {
					return e
				}
			}
		}
		if q := realObject(p.Sea["quests"]); len(q) > 0 {
			day, e := time.Parse("Mon Jan 02 2006", realString(q["day"]))
			if e != nil {
				day, e = time.Parse("2006-01-02", realString(q["day"]))
			}
			if e != nil {
				return errors.New("invalid_quest_day")
			}
			selected := []any{}
			for _, raw := range realArray(q["list"]) {
				v := realObject(raw)
				n, e := realNonnegative(v["progress"], 0)
				if e != nil {
					return e
				}
				qid := realString(v["id"])
				found := false
				for _, tpl := range rc.Catalog.SeaConfig().Quests {
					if tpl.ID == qid {
						found = true
						break
					}
				}
				if !found {
					return errors.New("unknown_quest_template")
				}
				selected = append(selected, map[string]any{"id": qid, "progress": n, "claimed": realBool(v["claimed"])})
			}
			if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.sea_quest_boards(owner_id,day,selected) VALUES($1,$2::date,$3)`, id, day.Format("2006-01-02"), realJSON(selected)); e != nil {
				return e
			}
			seed := make([]byte, 32)
			if _, e = rand.Read(seed); e != nil {
				return e
			}
			if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.sea_quest_roots(owner_id,private_seed) VALUES($1,$2)`, id, seed); e != nil {
				return e
			}
		}
	}
	return nil
}

type realFriend struct {
	A, B, Requester int64
	State           string
}

func realFriendPlan(rc *RealContext, accounts []RealAccount) ([]realFriend, error) {
	out := map[[2]int64]realFriend{}
	for _, a := range accounts {
		owner := rc.IDs[strings.ToLower(a.Key)]
		for _, field := range []string{"friends", "freqOut", "freqIn"} {
			for _, v := range realArray(a.Payload[field]) {
				other, ok := rc.IDs[strings.ToLower(realString(v))]
				if !ok || other == owner {
					return nil, errors.New("invalid_social_reference")
				}
				lo, hi := owner, other
				if lo > hi {
					lo, hi = hi, lo
				}
				k := [2]int64{lo, hi}
				r := realFriend{lo, hi, owner, "pending"}
				if field == "friends" {
					r.State = "accepted"
					r.Requester = lo
				} else if field == "freqIn" {
					r.Requester = other
				}
				if old, exists := out[k]; exists {
					if old.State == "accepted" {
						continue
					}
					if r.State != "accepted" && old.Requester != r.Requester {
						return nil, errors.New("conflicting_friend_requests")
					}
				}
				out[k] = r
			}
		}
	}
	rows := make([]realFriend, 0, len(out))
	for _, r := range out {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].A == rows[j].A {
			return rows[i].B < rows[j].B
		}
		return rows[i].A < rows[j].A
	})
	return rows, nil
}
func importRealFriends(ctx context.Context, rc *RealContext, accounts []RealAccount) (int, error) {
	rows, e := realFriendPlan(rc, accounts)
	if e != nil {
		return 0, e
	}
	for i, r := range rows {
		op, e := realOperation(ctx, rc, r.Requester, "friend-"+strconv.Itoa(i), "friend_change")
		if e != nil {
			return 0, e
		}
		if _, e = rc.Tx.Exec(ctx, `INSERT INTO fishing.friend_relations(a_id,b_id,requester_id,state,updated_operation) VALUES($1,$2,$3,$4,$5)`, r.A, r.B, r.Requester, r.State, op); e != nil {
			return 0, e
		}
	}
	return len(rows), nil
}

// ReconcileRealAccounts compares every live mapped field, exact signatures and
// ownership, not only totals. The caller keeps both source and candidate frozen.
func ReconcileRealAccounts(ctx context.Context, rc *RealContext, accounts []RealAccount) error {
	for index, a := range accounts {
		p, e := planRealAccount(rc, a)
		if e != nil {
			return e
		}
		id := rc.IDs[strings.ToLower(a.Key)]
		var username, name, qq, hash, salt string
		var admin, banned bool
		var coins, catches, capacity, listings, step, created int64
		var sealed []byte
		if e = rc.Tx.QueryRow(ctx, `SELECT i.username,i.display_name,i.qq,i.password_hash,i.legacy_salt,i.admin,i.banned,i.mfa_secret,i.mfa_last_step,w.coins,p.catch_count,p.rod_capacity,p.listing_capacity,(extract(epoch FROM a.created_at)*1000)::bigint FROM fishing.identities i JOIN fishing.accounts a ON a.id=i.account_id JOIN fishing.wallets w ON w.account_id=i.account_id JOIN fishing.player_state p ON p.account_id=i.account_id WHERE i.account_id=$1`, id).Scan(&username, &name, &qq, &hash, &salt, &admin, &banned, &sealed, &step, &coins, &catches, &capacity, &listings, &created); e != nil {
			return e
		}
		if username != p.Username || name != p.Name || qq != p.QQ || hash != p.Hash || salt != p.Salt || admin != p.Admin || banned != p.Banned || step != p.MFAStep || coins != p.Coins || catches != p.Catches || capacity != p.Capacity || listings != p.Listings || created != p.Created.UnixMilli() {
			return fmt.Errorf("account_%d:identity_or_balance_diff", index)
		}
		if p.Secret != "" {
			block, e := aes.NewCipher(rc.MFAKey)
			if e != nil {
				return e
			}
			gcm, e := cipher.NewGCM(block)
			if e != nil {
				return e
			}
			if len(sealed) < gcm.NonceSize() {
				return errors.New("mfa_missing")
			}
			plain, e := gcm.Open(nil, sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():], []byte(strconv.FormatInt(id, 10)))
			if e != nil || string(plain) != p.Secret {
				return errors.New("mfa_diff")
			}
		} else if len(sealed) > 0 {
			return errors.New("unexpected_mfa")
		}
		for _, s := range p.Stacks {
			var n int64
			var kind string
			if e = rc.Tx.QueryRow(ctx, `SELECT quantity,kind FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier=$3`, id, s.Item, s.Tier).Scan(&n, &kind); e != nil || n != s.Quantity || kind != s.Kind {
				return fmt.Errorf("account_%d:stack_diff", index)
			}
		}
		var actual []byte
		wantLoose := map[string]any{}
		for sig, n := range p.Loose {
			if n > 0 {
				wantLoose[sig] = n
			}
		}
		if e = rc.Tx.QueryRow(ctx, `SELECT COALESCE(jsonb_object_agg(signature,n),'{}') FROM (SELECT e.attributes->>'signature' signature,count(*) n FROM fishing.equipment_instances e WHERE e.owner_id=$1 AND e.lifecycle='available' AND NOT EXISTS(SELECT 1 FROM fishing.rod_components r WHERE r.equipment_id=e.id) AND NOT EXISTS(SELECT 1 FROM fishing.market_order_equipment me WHERE me.equipment_id=e.id) GROUP BY e.attributes->>'signature') q`, id).Scan(&actual); e != nil {
			return e
		}
		if !realEqualJSON(actual, wantLoose) {
			return fmt.Errorf("account_%d:loose_equipment_diff", index)
		}
		for _, rod := range p.Rods {
			var name string
			var active bool
			if e = rc.Tx.QueryRow(ctx, `SELECT name,active FROM fishing.rod_loadouts WHERE owner_id=$1 AND slot=$2`, id, rod.Slot).Scan(&name, &active); e != nil || name != rod.Name || active != rod.Active {
				return errors.New("rod_state_diff")
			}
			if e = rc.Tx.QueryRow(ctx, `SELECT COALESCE(jsonb_object_agg(r.part,e.attributes->>'signature'),'{}') FROM fishing.rod_components r JOIN fishing.equipment_instances e ON e.id=r.equipment_id WHERE r.owner_id=$1 AND r.slot=$2`, id, rod.Slot).Scan(&actual); e != nil {
				return e
			}
			if !realEqualJSON(actual, rod.Parts) {
				return errors.New("rod_parts_diff")
			}
		}
		if e = reconcileRealPersonal(ctx, rc, id, p); e != nil {
			return fmt.Errorf("account_%d:%w", index, e)
		}
		for _, check := range []struct {
			table, column string
			want          int
		}{
			{"inventory_stacks", "owner_id", len(p.Stacks)}, {"player_codex", "owner_id", len(p.Codex)},
			{"rod_loadouts", "owner_id", len(p.Rods)}, {"chest_pity", "owner_id", len(p.Pity)},
		} {
			var n int
			if e = rc.Tx.QueryRow(ctx, "SELECT count(*) FROM fishing."+check.table+" WHERE "+check.column+"=$1", id).Scan(&n); e != nil {
				return e
			}
			if n != check.want {
				return errors.New("unexpected_account_rows")
			}
		}
		var equipmentCount int64
		for _, n := range p.Loose {
			equipmentCount += n
		}
		for _, r := range p.Rods {
			equipmentCount += int64(len(r.Parts))
		}
		var gotEquipment int64
		if e = rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances WHERE owner_id=$1 AND lifecycle='available'`, id).Scan(&gotEquipment); e != nil {
			return e
		}
		if gotEquipment != equipmentCount {
			return errors.New("equipment_count_diff")
		}
		var mismatchedEquipment int64
		if e = rc.Tx.QueryRow(ctx, `SELECT count(*) FROM fishing.equipment_instances e JOIN fishing.item_definitions d ON d.id=e.definition_id WHERE e.owner_id=$1 AND (e.attributes->>'signature' IS NULL OR e.definition_id<>split_part(e.attributes->>'signature','#',1) OR e.part IS DISTINCT FROM d.part)`, id).Scan(&mismatchedEquipment); e != nil {
			return e
		}
		if mismatchedEquipment != 0 {
			return errors.New("equipment_definition_diff")
		}
	}
	friends, e := realFriendPlan(rc, accounts)
	if e != nil {
		return e
	}
	for _, r := range friends {
		var state string
		var requester int64
		if e = rc.Tx.QueryRow(ctx, `SELECT state,requester_id FROM fishing.friend_relations WHERE a_id=$1 AND b_id=$2`, r.A, r.B).Scan(&state, &requester); e != nil || state != r.State || requester != r.Requester {
			return errors.New("friend_relation_diff")
		}
	}
	return nil
}
func realEqualJSON(actual []byte, want any) bool {
	var a, b any
	if json.Unmarshal(actual, &a) != nil || json.Unmarshal(realJSON(want), &b) != nil {
		return false
	}
	return reflect.DeepEqual(a, b)
}
func reconcileRealPersonal(ctx context.Context, rc *RealContext, id int64, p realAccountPlan) error {
	for item, raw := range p.Codex {
		m := realObject(raw)
		var actual []byte
		if e := rc.Tx.QueryRow(ctx, `SELECT jsonb_build_object('count',count,'first',(extract(epoch FROM first_at)*1000)::bigint,'min',min_size,'max',max_size,'tier',CASE best_tier WHEN 'large' THEN 'L' WHEN 'giant' THEN 'G' ELSE '' END) FROM fishing.player_codex WHERE owner_id=$1 AND item_id=$2`, id, item).Scan(&actual); e != nil {
			return e
		}
		want := map[string]any{"count": m["count"], "first": m["first"], "min": m["min"], "max": m["max"], "tier": realString(m["tier"])}
		if !realEqualJSON(actual, want) {
			return errors.New("codex_diff")
		}
	}
	var actual []byte
	if len(p.Auto) > 0 {
		if e := rc.Tx.QueryRow(ctx, `SELECT jsonb_build_object('tier',include_tiers,'items',rules) FROM fishing.autosell_settings WHERE owner_id=$1`, id).Scan(&actual); e != nil {
			return e
		}
		if !realEqualJSON(actual, map[string]any{"tier": realBool(p.Auto["tier"]), "items": realObject(p.Auto["items"])}) {
			return errors.New("autosell_diff")
		}
	}
	if len(p.Sub) > 0 {
		if e := rc.Tx.QueryRow(ctx, `SELECT config FROM fishing.subscription_settings WHERE account_id=$1`, id).Scan(&actual); e != nil {
			return e
		}
		if !realEqualJSON(actual, p.Sub) {
			return errors.New("subscription_diff")
		}
	}
	for item, raw := range p.Pity {
		var n int64
		want, e := realNonnegative(raw, 0)
		if e != nil {
			return e
		}
		if e = rc.Tx.QueryRow(ctx, `SELECT misses FROM fishing.chest_pity WHERE owner_id=$1 AND chest_id=$2`, id, item).Scan(&n); e != nil || n != want {
			return errors.New("chest_pity_diff")
		}
	}
	for item, raw := range realObject(p.Mall["bought"]) {
		want, e := realNonnegative(raw, 0)
		if e != nil {
			return e
		}
		if want == 0 {
			continue
		}
		var n int64
		var day string
		if e = rc.Tx.QueryRow(ctx, `SELECT quantity,cycle_key::text FROM fishing.mall_purchases WHERE owner_id=$1 AND item_id=$2`, id, item).Scan(&n, &day); e != nil || n != want || day != realString(p.Mall["key"]) {
			return errors.New("mall_diff")
		}
	}
	if len(p.Ship) > 0 || len(p.Sea) > 0 {
		if e := rc.Tx.QueryRow(ctx, `SELECT jsonb_build_object('lv',level,'xp',experience,'charts',charts) FROM fishing.sea_players WHERE owner_id=$1`, id).Scan(&actual); e != nil {
			return e
		}
		lv, _ := realNonnegative(p.Ship["lv"], 1)
		xp, _ := realNonnegative(p.Ship["xp"], 0)
		charts, _ := realNonnegative(p.Sea["charts"], 0)
		if !realEqualJSON(actual, map[string]any{"lv": lv, "xp": xp, "charts": charts}) {
			return errors.New("sea_progress_diff")
		}
		if q := realObject(p.Sea["quests"]); len(q) > 0 {
			selected := []any{}
			for _, raw := range realArray(q["list"]) {
				v := realObject(raw)
				selected = append(selected, map[string]any{"id": v["id"], "progress": v["progress"], "claimed": realBool(v["claimed"])})
			}
			var day string
			if e := rc.Tx.QueryRow(ctx, `SELECT day::text,selected FROM fishing.sea_quest_boards WHERE owner_id=$1`, id).Scan(&day, &actual); e != nil {
				return e
			}
			parsed, e := time.Parse("Mon Jan 02 2006", realString(q["day"]))
			if e != nil {
				parsed, e = time.Parse("2006-01-02", realString(q["day"]))
			}
			if e != nil || day != parsed.Format("2006-01-02") || !realEqualJSON(actual, selected) {
				return errors.New("sea_quests_diff")
			}
		}
	}
	return nil
}
