package sea

import (
	"context"
	"encoding/json"
	"errors"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/randomintent"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"strconv"
	"time"
)

func (s *Service) Voyage(ctx context.Context, owner int64, key string) (assets.Result, error) {
	questSeed, err := s.questSeed(ctx, owner)
	if err != nil {
		return assets.Result{}, err
	}
	version := s.catalog.Version + ":" + s.catalog.SourceSHA256
	seed, err := randomintent.Load(ctx, s.pool, owner, key, struct{ Kind, Version string }{"sea_voyage", version})
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_voyage", RuleVersion: version, Players: []int64{owner}, Input: struct{}{}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		v, err := state(ctx, t, owner)
		if err != nil {
			return assets.Result{}, err
		}
		if v.Charts < 1 {
			return assets.Result{}, assets.Rejection("chart_insufficient")
		}
		var now time.Time
		if err := t.SQL().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			return assets.Result{}, err
		}
		var live int
		if err := t.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.sea_zones WHERE owner_id=$1 AND expires_at>$2`, owner, now).Scan(&live); err != nil {
			return assets.Result{}, err
		}
		if live >= s.catalog.SeaConfig().ZoneMax {
			return assets.Result{}, assets.Rejection("sea_zone_limit")
		}
		zone := s.catalog.VoyageZone(now.UnixMilli(), rules.Stream(seed, "sea-voyage"))
		// Unique command identity replaces wall-clock uniqueness; random pool remains identical.
		zone.ID = "zone-" + strconv.FormatInt(t.OperationID(), 10)
		data, err := json.Marshal(zone)
		if err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.sea_zones(owner_id,id,data,expires_at,created_operation) VALUES($1,$2,$3,$4,$5)`, owner, zone.ID, data, time.UnixMilli(zone.Expire), t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.sea_players SET charts=charts-1 WHERE owner_id=$1`, owner); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.sea_progress_entries(operation_id,owner_id,field,delta,after_value) VALUES($1,$2,'charts',-1,$3)`, t.OperationID(), owner, v.Charts-1); err != nil {
			return assets.Result{}, err
		}
		if err := s.bumpQuest(ctx, t, owner, questSeed, "voyage", 1); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "voyaged", ResourceID: zone.ID, Details: data}, nil
	})
}
func (s *Service) Zones(ctx context.Context, owner int64) ([]rules.SeaZone, error) {
	return readZones(ctx, s.pool, owner)
}
func readZones(ctx context.Context, q assets.SQL, owner int64) ([]rules.SeaZone, error) {
	rows, err := q.Query(ctx, `SELECT data FROM fishing.sea_zones WHERE owner_id=$1 AND expires_at>statement_timestamp() ORDER BY created_operation`, owner)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	zones := []rules.SeaZone{}
	for rows.Next() {
		var data []byte
		var z rules.SeaZone
		if rows.Scan(&data) != nil || json.Unmarshal(data, &z) != nil {
			return nil, assets.ErrUnavailable
		}
		zones = append(zones, z)
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	return zones, nil
}
func (s *Service) Anchor(ctx context.Context, owner int64, key, zoneID string) (assets.Result, error) {
	if len(zoneID) < 1 || len(zoneID) > 128 {
		return assets.Result{}, assets.ErrInvalid
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_anchor", RuleVersion: s.catalog.Version + ":" + s.catalog.SourceSHA256, Players: []int64{owner}, Input: struct{ Zone string }{zoneID}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var data []byte
		var expires, now time.Time
		err := t.SQL().QueryRow(ctx, `SELECT data,expires_at,clock_timestamp() FROM fishing.sea_zones WHERE owner_id=$1 AND id=$2`, owner, zoneID).Scan(&data, &expires, &now)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !expires.After(now) {
			return assets.Result{}, assets.Rejection("sea_zone_expired")
		}
		if err != nil {
			return assets.Result{}, err
		}
		var zone rules.SeaZone
		if json.Unmarshal(data, &zone) != nil {
			return assets.Result{}, assets.ErrUnavailable
		}
		cfg := s.catalog.SeaConfig().Anchor
		if zone.Anchors >= cfg.MaxTimes {
			return assets.Result{}, assets.Rejection("sea_anchor_limit")
		}
		if err := t.Coins(ctx, owner, -cfg.Coins); err != nil {
			return assets.Result{}, err
		}
		if err := t.Stacks(ctx, owner, []assets.StackDelta{{ItemID: "deepscale", Tier: "normal", Quantity: -cfg.Scales}}); err != nil {
			return assets.Result{}, err
		}
		zone.Expire = now.UnixMilli() + cfg.ExtendMin*60000
		zone.Anchors++
		for i := range zone.Spots {
			for _, buff := range cfg.Buffs {
				found := false
				for j := range zone.Spots[i].Buffs {
					if zone.Spots[i].Buffs[j].Type == buff.Type {
						zone.Spots[i].Buffs[j].Value = max(-100, min(100, zone.Spots[i].Buffs[j].Value+buff.Value))
						found = true
						break
					}
				}
				if !found && buff.Value != 0 {
					zone.Spots[i].Buffs = append(zone.Spots[i].Buffs, buff)
				}
			}
		}
		data, _ = json.Marshal(zone)
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.sea_zones SET data=$3,expires_at=$4,anchors=$5 WHERE owner_id=$1 AND id=$2`, owner, zoneID, data, time.UnixMilli(zone.Expire), zone.Anchors); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "anchored", ResourceID: zoneID, Details: data}, nil
	})
}
