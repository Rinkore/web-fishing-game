package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// The player's revision is serialized by the asset transaction guard. Page by
// whole operations, not fish rows: a recursive segment may contain more than
// 100 catches, including materials and components without catch_records rows.
type legacyPersonalPush struct {
	api      *API
	owner    int64
	name     string
	catalog  *rules.Catalog
	cursor   int64
	snapshot int64
}

func (p *legacyPersonalPush) init(ctx context.Context) (string, error) {
	frame, revision, err := p.api.legacyAssetsSnapshot(ctx, p.owner)
	if err != nil {
		return "", err
	}
	p.cursor, p.snapshot = revision, revision
	return frame, nil
}

func (p *legacyPersonalPush) poll(ctx context.Context) ([]string, error) {
	revision, err := p.api.assetsRevision(ctx, p.owner)
	if err != nil || revision == p.cursor {
		return nil, err
	}
	rows, err := p.api.pool.Query(ctx, `SELECT pe.revision,o.id,o.kind,e.payload,e.created_at
 FROM fishing.player_events pe JOIN fishing.outbox_events e ON e.id=pe.outbox_id
 JOIN fishing.asset_operations o ON o.id=e.operation_id
 WHERE pe.owner_id=$1 AND pe.revision>$2 ORDER BY pe.revision LIMIT 16`, p.owner, p.cursor)
	if err != nil {
		return nil, err
	}
	type event struct {
		revision, operation int64
		kind                string
		payload             []byte
		at                  time.Time
	}
	page := []event{}
	for rows.Next() {
		var e event
		if err := rows.Scan(&e.revision, &e.operation, &e.kind, &e.payload, &e.at); err != nil {
			rows.Close()
			return nil, err
		}
		page = append(page, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(page) == 0 {
		return nil, err
	}
	cfg, err := p.api.legacySubscription(ctx, p.owner)
	if err != nil {
		return nil, err
	}
	frames := []string{}
	for _, e := range page {
		if e.kind != "fishing_settle" {
			continue
		}
		var payload struct {
			Result struct {
				Details struct {
					Catches    []rules.Catch `json:"catches"`
					GroundID   string        `json:"groundId"`
					SpotID     string        `json:"spotId"`
					GroundName string        `json:"groundName"`
					SpotName   string        `json:"spotName"`
					CaughtAt   int64         `json:"caughtAt"`
				} `json:"details"`
			} `json:"result"`
		}
		if err := json.Unmarshal(e.payload, &payload); err != nil {
			return nil, err
		}
		d := payload.Result.Details
		at := d.CaughtAt
		if at == 0 {
			at = e.at.UnixMilli()
		}
		if d.Catches == nil {
			// Compatibility with pre-payload synthetic/old catch operations.
			// Never infer a location from the player's current fishing session.
			old, err := p.oldCatches(ctx, e.operation)
			if err != nil {
				return nil, err
			}
			frames = append(frames, old...)
			continue
		}
		ground, spot := legacyCatchLocation(p.catalog, d.GroundID, d.SpotID, d.GroundName, d.SpotName)
		for _, v := range d.Catches {
			item := legacyCatchItem(p.catalog, v)
			entry := map[string]any{"t": at, "who": p.name, "item": item, "ground": ground, "spot": spot, "size": v.Size}
			frames = append(frames, legacyFrame(map[string]any{"type": "catch", "entry": entry}))
			if v.Kind == "component" && legacyMatchesSubscription(p.catalog, v.ID, cfg) {
				frames = append(frames, legacyFrame(map[string]any{"type": "subalert", "item": item, "t": at}))
			}
		}
	}
	// One authoritative snapshot per poll also covers autosell, grants, chest
	// rewards and other tabs. Its revision and all contents share one MVCC view.
	// A snapshot may cover later pages; catch logs do not mutate the inventory.
	nextSnapshot := p.snapshot
	// A commit can land between the cheap wake-up read and the page query.
	// Never acknowledge a page newer than the last snapshot without refreshing.
	if max(revision, page[len(page)-1].revision) > p.snapshot {
		frame, rev, err := p.api.legacyAssetsSnapshot(ctx, p.owner)
		if err != nil {
			return nil, err
		}
		frames = append(frames, frame)
		nextSnapshot = rev
	}
	p.cursor, p.snapshot = page[len(page)-1].revision, nextSnapshot
	return frames, nil
}

func (p *legacyPersonalPush) oldCatches(ctx context.Context, operation int64) ([]string, error) {
	rows, err := p.api.pool.Query(ctx, `SELECT item_id,size,ground_id,spot_id,caught_at FROM fishing.catch_records
 WHERE operation_id=$1 AND owner_id=$2 ORDER BY ordinal`, operation, p.owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	frames := []string{}
	for rows.Next() {
		var id, ground, spot string
		var size float64
		var at time.Time
		if err := rows.Scan(&id, &size, &ground, &spot, &at); err != nil {
			return nil, err
		}
		ground, spot = legacyCatchLocation(p.catalog, ground, spot, "", "")
		v := rules.Catch{ID: id, Kind: "fish", Size: &size, Tier: p.catalog.SizeTier(id, size)}
		frames = append(frames, legacyFrame(map[string]any{"type": "catch", "entry": map[string]any{
			"t": at.UnixMilli(), "who": p.name, "item": legacyCatchItem(p.catalog, v), "ground": ground, "spot": spot, "size": size}}))
	}
	return frames, rows.Err()
}

func legacyCatchLocation(c *rules.Catalog, ground, spot, groundName, spotName string) (string, string) {
	if g, s, ok := c.FishingSpot(ground, spot); ok {
		if groundName == "" {
			groundName = g.Name
		}
		if spotName == "" {
			spotName = s.Name
		}
	}
	if groundName == "" {
		groundName = ground
	}
	if spotName == "" {
		spotName = spot
	}
	return groundName, spotName
}

func legacyCatchItem(c *rules.Catalog, v rules.Catch) map[string]any {
	if v.Kind == "component" {
		item := legacyComponentMeta(c, v.ID)
		if item == nil {
			return map[string]any{"id": v.ID, "name": v.ID, "kind": "component"}
		}
		item["kind"] = "component"
		return item
	}
	it, _ := c.Item(v.ID)
	return map[string]any{"id": v.ID, "name": it.Name, "kind": v.Kind, "rarity": it.Rarity, "size": v.Size, "tier": sizeTierLabel(v.Tier)}
}

type legacySubConfig struct {
	On        bool     `json:"on"`
	BaseID    string   `json:"baseId"`
	Quality   string   `json:"quality"`
	AffixType string   `json:"affixType"`
	Min       *float64 `json:"min"`
	Max       *float64 `json:"max"`
	Badge     bool     `json:"badge"`
	Blink     bool     `json:"blink"`
}

func (a *API) legacySubscription(ctx context.Context, owner int64) (*legacySubConfig, error) {
	var raw []byte
	err := a.pool.QueryRow(ctx, `SELECT config FROM fishing.subscription_settings WHERE account_id=$1`, owner).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg legacySubConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func legacyMatchesSubscription(c *rules.Catalog, id string, cfg *legacySubConfig) bool {
	if cfg == nil || !cfg.On {
		return false
	}
	meta, ok := c.ComponentMeta(id)
	if !ok || cfg.BaseID != "" && cfg.BaseID != meta.BaseID || cfg.Quality != "" && cfg.Quality != meta.Quality {
		return false
	}
	if cfg.AffixType == "" && cfg.Min == nil && cfg.Max == nil {
		return true
	}
	for _, a := range meta.Affixes {
		if (cfg.AffixType == "" || cfg.AffixType == a.Type) && (cfg.Min == nil || a.Value >= *cfg.Min) && (cfg.Max == nil || a.Value <= *cfg.Max) {
			return true
		}
	}
	return false
}

func (a *API) legacyAssetsSnapshot(ctx context.Context, owner int64) (string, int64, error) {
	tx, err := a.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var coins, revision, count int64
	if err := tx.QueryRow(ctx, `SELECT w.coins,p.assets_rev,p.catch_count FROM fishing.wallets w JOIN fishing.player_state p ON p.account_id=w.account_id WHERE w.account_id=$1`, owner).Scan(&coins, &revision, &count); err != nil {
		return "", 0, err
	}
	inv, big, err := legacyInventoryFrom(ctx, tx, owner)
	if err != nil {
		return "", 0, err
	}
	rows, err := tx.Query(ctx, `SELECT item_id,count,first_at,min_size,max_size,best_tier FROM fishing.player_codex WHERE owner_id=$1`, owner)
	if err != nil {
		return "", 0, err
	}
	codex := map[string]any{}
	for rows.Next() {
		var id, tier string
		var count int64
		var first time.Time
		var min, max *float64
		if err := rows.Scan(&id, &count, &first, &min, &max, &tier); err != nil {
			rows.Close()
			return "", 0, err
		}
		var label any
		if v := sizeTierLabel(tier); v != "" {
			label = v
		}
		codex[id] = map[string]any{"count": count, "first": first.UnixMilli(), "min": min, "max": max, "tier": label}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return legacyFrame(map[string]any{"type": "assets", "coins": coins, "inventory": inv, "bigfish": big,
		"codex": codex, "invRev": strconv.FormatInt(revision, 10), "catchCount": count}), revision, nil
}
