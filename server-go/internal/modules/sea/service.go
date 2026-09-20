package sea

import (
	"context"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Service struct {
	pool     *pgxpool.Pool
	assets   *assets.Service
	catalog  *rules.Catalog
	location *time.Location
}

func New(pool *pgxpool.Pool, c *rules.Catalog, locations ...*time.Location) *Service {
	loc := time.Local
	if len(locations) > 0 && locations[0] != nil {
		loc = locations[0]
	}
	return &Service{pool, assets.New(pool), c, loc}
}

type State struct {
	Level      int   `json:"level"`
	Experience int64 `json:"experience"`
	Charts     int64 `json:"charts"`
}
type ShipConfig struct {
	XPNeed  []int64 `json:"xpNeed"`
	UpCoins []int64 `json:"upCoins"`
	UpScale []int64 `json:"upScale"`
}

func (s *Service) View(ctx context.Context, owner int64) (State, error) {
	return readState(ctx, s.pool, owner)
}
func readState(ctx context.Context, q assets.SQL, owner int64) (State, error) {
	var v State
	if owner < 1 {
		return v, assets.ErrInvalid
	}
	if err := q.QueryRow(ctx, `SELECT COALESCE(s.level,1),COALESCE(s.experience,0),COALESCE(s.charts,0) FROM fishing.player_state p LEFT JOIN fishing.sea_players s ON s.owner_id=p.account_id WHERE p.account_id=$1`, owner).Scan(&v.Level, &v.Experience, &v.Charts); err != nil {
		return v, assets.ErrUnavailable
	}
	return v, nil
}

type Command struct {
	ActorID            int64
	RequestKey, Action string
	ExpectedLevel      int
}

func (s *Service) Apply(ctx context.Context, r Command) (assets.Result, error) {
	if r.ActorID < 1 || (r.Action != "upgrade" && r.Action != "chart") || r.Action == "upgrade" && (r.ExpectedLevel < 1 || r.ExpectedLevel > 5) {
		return assets.Result{}, assets.ErrInvalid
	}
	kind := "chart_craft"
	if r.Action == "upgrade" {
		kind = "ship_upgrade"
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: kind, RuleVersion: s.catalog.Version + ":" + s.catalog.SourceSHA256, Players: []int64{r.ActorID}, Input: r}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		v, err := state(ctx, t, r.ActorID)
		if err != nil {
			return assets.Result{}, err
		}
		field := "charts"
		after := v.Charts + 1
		if r.Action == "chart" {
			var cfg struct {
				Cost int64 `json:"chartCost"`
			}
			if err := s.catalog.Constant("SEA", &cfg); err != nil || cfg.Cost < 1 {
				return assets.Result{}, assets.ErrInvalid
			}
			if v.Charts >= assets.MaxCoins {
				return assets.Result{}, assets.Rejection("chart_overflow")
			}
			if err := t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: "chartfrag", Tier: "normal", Quantity: -cfg.Cost}}); err != nil {
				return assets.Result{}, err
			}
			v.Charts++
		} else {
			if v.Level != r.ExpectedLevel {
				return assets.Result{}, assets.Rejection("ship_level_changed")
			}
			if v.Level >= 5 {
				return assets.Result{}, assets.Rejection("ship_max_level")
			}
			var cfg ShipConfig
			if err := s.catalog.Constant("SHIP", &cfg); err != nil || len(cfg.XPNeed) != 5 || len(cfg.UpCoins) != 5 || len(cfg.UpScale) != 5 {
				return assets.Result{}, assets.ErrInvalid
			}
			if v.Experience < cfg.XPNeed[v.Level] {
				return assets.Result{}, assets.Rejection("ship_experience_insufficient")
			}
			if err := t.Coins(ctx, r.ActorID, -cfg.UpCoins[v.Level]); err != nil {
				return assets.Result{}, err
			}
			if err := t.Stacks(ctx, r.ActorID, []assets.StackDelta{{ItemID: "deepscale", Tier: "normal", Quantity: -cfg.UpScale[v.Level]}}); err != nil {
				return assets.Result{}, err
			}
			v.Level++
			field = "level"
			after = int64(v.Level)
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.sea_players SET level=$2,charts=$3 WHERE owner_id=$1`, r.ActorID, v.Level, v.Charts); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.sea_progress_entries(operation_id,owner_id,field,delta,after_value) VALUES($1,$2,$3,1,$4)`, t.OperationID(), r.ActorID, field, after); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(v)
		return assets.Result{Status: map[string]string{"chart": "crafted", "upgrade": "upgraded"}[r.Action], Details: details}, nil
	})
}
func state(ctx context.Context, t *assets.Transaction, owner int64) (State, error) {
	var v State
	err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.sea_players(owner_id) VALUES($1) ON CONFLICT(owner_id) DO UPDATE SET owner_id=excluded.owner_id RETURNING level,experience,charts`, owner).Scan(&v.Level, &v.Experience, &v.Charts)
	return v, err
}
