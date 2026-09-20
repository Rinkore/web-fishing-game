package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/rules"
)

// Legacy profile projection. The original frontend consumes the legacy
// profileOf shape, so this handler maps the durable Go schema back to that
// contract without duplicating any gameplay authority.

var rodPartOrder = []string{"rod", "line", "hook", "bait", "reel", "accessory", "charm"}
var rodSlotPrices = []int64{10000, 50000, 100000, 200000, 400000, 800000, 1600000}

type legacyBdPart struct {
	CompID  string            `json:"compId"`
	Name    string            `json:"name"`
	Affixes []rules.MetaAffix `json:"affixes"`
	Rare    string            `json:"rare"`
	IsCharm bool              `json:"isCharm"`
}

type legacyRodSlot struct {
	Slot    int               `json:"slot"`
	Name    string            `json:"name"`
	Parts   map[string]string `json:"parts"`
	RodID   string            `json:"rodId"`
	Count   int               `json:"count"`
	Affixes []map[string]any  `json:"affixes"`
	Price   float64           `json:"price"`
	Active  bool              `json:"active"`
}

func (a *API) legacyMe(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	profile, err := a.legacyProfile(r, c, session)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, profile)
}

func (a *API) legacyProfile(r *http.Request, c *rules.Catalog, session identity.Session) (map[string]any, error) {
	ctx := r.Context()
	var username, name, qq string
	var coins, rev, catchCount, listingCap int64
	var admin bool
	var rodCapacity int
	if err := a.pool.QueryRow(ctx, `SELECT i.username,i.display_name,i.qq,i.admin,w.coins,p.assets_rev,p.catch_count,p.listing_capacity,p.rod_capacity
 FROM fishing.identities i JOIN fishing.wallets w ON w.account_id=i.account_id JOIN fishing.player_state p ON p.account_id=i.account_id WHERE i.account_id=$1`, session.AccountID).
		Scan(&username, &name, &qq, &admin, &coins, &rev, &catchCount, &listingCap, &rodCapacity); err != nil {
		return nil, identity.ErrStorage
	}

	// inventory_stacks holds fish in three tier rows; legacy flattens them to a
	// single count plus a bigfish.L/G split for large and giant.
	inventory := map[string]int64{}
	bigfish := map[string]map[string]int64{}
	rows, err := a.pool.Query(ctx, `SELECT item_id,kind,tier,quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND quantity>0`, session.AccountID)
	if err != nil {
		return nil, identity.ErrStorage
	}
	for rows.Next() {
		var id, kind, tier string
		var q int64
		if err := rows.Scan(&id, &kind, &tier, &q); err != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		inventory[id] += q
		if kind == "fish" && (tier == "large" || tier == "giant") {
			key := "L"
			if tier == "giant" {
				key = "G"
			}
			if bigfish[id] == nil {
				bigfish[id] = map[string]int64{}
			}
			bigfish[id][key] += q
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()
	bf := map[string]map[string]int64{}
	for id, m := range bigfish {
		if m["L"] > 0 || m["G"] > 0 {
			bf[id] = m
		}
	}

	codex := map[string]map[string]any{}
	rows, err = a.pool.Query(ctx, `SELECT item_id,count,first_at,min_size,max_size,best_tier FROM fishing.player_codex WHERE owner_id=$1`, session.AccountID)
	if err != nil {
		return nil, identity.ErrStorage
	}
	for rows.Next() {
		var id string
		var count int64
		var first time.Time
		var minSize, maxSize *float64
		var tier string
		if err := rows.Scan(&id, &count, &first, &minSize, &maxSize, &tier); err != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		var legacyTier any
		switch tier {
		case "large":
			legacyTier = "L"
		case "giant":
			legacyTier = "G"
		}
		codex[id] = map[string]any{"count": count, "first": first.UnixMilli(), "max": maxSize, "min": minSize, "tier": legacyTier}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, identity.ErrStorage
	}
	rows.Close()

	features := map[string]bool{}
	if f, err := operations.New(a.pool).Features(ctx); err == nil {
		features = f.Flags
	}

	autoSell := any(nil)
	if s, err := economy.New(a.pool, c).Settings(ctx, session.AccountID); err == nil && len(s.Rules) > 0 {
		autoSell = map[string]any{"items": s.Rules, "tier": s.IncludeTiers}
	}

	bd, rodSlots, rodActiveSlot, rodName, rodLocked, err := a.legacyRod(ctx, c, session.AccountID, rodCapacity)
	if err != nil {
		return nil, identity.ErrStorage
	}

	nextPrice := any(nil)
	if rodCapacity < 8 {
		nextPrice = rodSlotPrices[rodCapacity-1]
	}
	freeSlot := -1
	for i := 0; i < rodCapacity; i++ {
		if rodSlots[i] == nil {
			freeSlot = i
			break
		}
	}

	return map[string]any{
		"features":         features,
		"featureOrder":     map[string]any{},
		"username":         username,
		"name":             name,
		"coins":            coins,
		"qq":               qq,
		"inventory":        inventory,
		"bd":               bd,
		"invRev":           strconv.FormatInt(rev, 10),
		"bigfish":          bf,
		"codex":            codex,
		"catchCount":       catchCount,
		"admin":            admin,
		"listingCap":       listingCap,
		"listingCapSet":    false,
		"autoSell":         autoSell,
		"subNotify":        nil,
		"rodName":          rodName,
		"rodSlotsCount":    rodCapacity,
		"rodSlotsMax":      8,
		"rodActiveSlot":    rodActiveSlot,
		"freeRodSlots":     freeSlot,
		"rodSlots":         rodSlots,
		"nextRodSlotPrice": nextPrice,
		"rodLocked":        rodLocked,
	}, nil
}

// legacyRod reads the active assembly (bd), the saved slot view, and the
// per-component lock counts used by the legacy rod UI.
func (a *API) legacyRod(ctx context.Context, c *rules.Catalog, owner int64, capacity int) (map[string]legacyBdPart, []any, int, string, map[string]int64, error) {
	type loadoutRow struct {
		Slot   int
		Name   string
		Active bool
	}
	loadouts := map[int]loadoutRow{}
	active := -1
	rows, err := a.pool.Query(ctx, `SELECT slot,name,active FROM fishing.rod_loadouts WHERE owner_id=$1`, owner)
	if err != nil {
		return nil, nil, -1, "", nil, err
	}
	for rows.Next() {
		var lo loadoutRow
		if err := rows.Scan(&lo.Slot, &lo.Name, &lo.Active); err != nil {
			rows.Close()
			return nil, nil, -1, "", nil, err
		}
		loadouts[lo.Slot] = lo
		if lo.Active {
			active = lo.Slot
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, -1, "", nil, err
	}
	rows.Close()

	type compRow struct {
		Slot      int
		Part      string
		Signature string
	}
	comps := map[int]map[string]string{}
	rows, err = a.pool.Query(ctx, `SELECT c.slot,c.part,e.attributes->>'signature' FROM fishing.rod_components c JOIN fishing.equipment_instances e ON e.id=c.equipment_id WHERE c.owner_id=$1`, owner)
	if err != nil {
		return nil, nil, -1, "", nil, err
	}
	for rows.Next() {
		var cr compRow
		if err := rows.Scan(&cr.Slot, &cr.Part, &cr.Signature); err != nil {
			rows.Close()
			return nil, nil, -1, "", nil, err
		}
		if comps[cr.Slot] == nil {
			comps[cr.Slot] = map[string]string{}
		}
		comps[cr.Slot][cr.Part] = cr.Signature
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, -1, "", nil, err
	}
	rows.Close()

	bd := legacyBdParts(c, comps[active])

	slots := make([]any, 8)
	for i := 0; i < 8; i++ {
		parts := comps[i]
		if len(parts) == 0 {
			continue
		}
		meta := rodSetMeta(c, parts)
		if meta == nil {
			continue
		}
		lo := loadouts[i]
		slots[i] = legacyRodSlot{
			Slot:    i,
			Name:    lo.Name,
			Parts:   parts,
			RodID:   meta.RodID,
			Count:   len(parts),
			Affixes: meta.Affixes,
			Price:   meta.Price,
			Active:  i == active,
		}
	}

	rodName := ""
	if active >= 0 {
		rodName = loadouts[active].Name
	}

	// Legacy rodLocked counts each component id used by the active assembly plus
	// every non-active saved slot.
	locked := map[string]int64{}
	countParts := func(parts map[string]string) {
		for _, sig := range parts {
			locked[sig]++
		}
	}
	countParts(comps[active])
	for i := 0; i < 8; i++ {
		if i != active {
			countParts(comps[i])
		}
	}

	return bd, slots, active, rodName, locked, nil
}

func legacyBdParts(c *rules.Catalog, parts map[string]string) map[string]legacyBdPart {
	if len(parts) == 0 {
		return map[string]legacyBdPart{}
	}
	out := map[string]legacyBdPart{}
	for _, part := range rodPartOrder {
		sig, ok := parts[part]
		if !ok {
			continue
		}
		m, ok := c.ComponentMeta(sig)
		if !ok {
			continue
		}
		out[part] = legacyBdPart{
			CompID:  sig,
			Name:    m.Name,
			Affixes: m.Affixes,
			Rare:    m.Quality,
			IsCharm: part == "charm",
		}
	}
	return out
}

type rodAggregate struct {
	RodID   string
	Affixes []map[string]any
	Price   float64
}

func rodSetMeta(c *rules.Catalog, parts map[string]string) *rodAggregate {
	segs := []string{}
	agg := map[string]float64{}
	price := 0.0
	for _, part := range rodPartOrder {
		sig, ok := parts[part]
		if !ok {
			continue
		}
		m, ok := c.ComponentMeta(sig)
		if !ok {
			return nil
		}
		segs = append(segs, part+"="+sig)
		price += m.Price
		for _, a := range m.Affixes {
			agg[a.Type] += a.Value
		}
	}
	if len(segs) == 0 {
		return nil
	}
	affixTypes := make([]string, 0, len(agg))
	for t := range agg {
		affixTypes = append(affixTypes, t)
	}
	sort.Strings(affixTypes)
	affixes := make([]map[string]any, 0, len(affixTypes))
	for _, t := range affixTypes {
		affixes = append(affixes, map[string]any{"type": t, "value": agg[t]})
	}
	return &rodAggregate{RodID: "rodset:" + joinStrings(segs, ";"), Affixes: affixes, Price: price}
}

func joinStrings(items []string, sep string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

func (a *API) legacyVersion(w http.ResponseWriter, r *http.Request) {
	c, err := a.catalog(r.Context())
	if err != nil {
		failure(w, err)
		return
	}
	var version, build string
	if err := json.Unmarshal(c.Constants["VERSION"], &version); err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	_ = json.Unmarshal(c.Constants["BUILD"], &build)
	write(w, 200, map[string]any{"version": version, "build": build})
}
