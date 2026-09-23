package market

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

type storedSupplyRule struct {
	original        json.RawMessage
	ID              string         `json:"id"`
	Enabled         bool           `json:"enabled"`
	Mode            string         `json:"mode"`
	Recipe          map[string]any `json:"recipe"`
	Batch           int            `json:"batch"`
	IntervalSeconds int            `json:"intervalSeconds"`
	Threshold       int            `json:"threshold"`
	Target          int            `json:"target"`
	Remaining       int            `json:"remaining"`
	RemainingCounts map[string]int `json:"remainingCounts"`
	Refilling       bool           `json:"refilling"`
	Created         int            `json:"created"`
	NextAt          int64          `json:"nextAt"`
	Error           string         `json:"error"`
}

type storedSupplyRecipe struct {
	Sellers  []string            `json:"sellers"`
	Seller   string              `json:"seller"`
	Counts   map[string]int      `json:"counts"`
	Picks    map[string][]string `json:"picks"`
	Part     string              `json:"part"`
	Quality  map[string]float64  `json:"quality"`
	AffixMin int                 `json:"affixMin"`
	AffixMax int                 `json:"affixMax"`
	QtyMin   int                 `json:"qtyMin"`
	QtyMax   int                 `json:"qtyMax"`
	MulMin   float64             `json:"mulMin"`
	MulMax   float64             `json:"mulMax"`
	Hours    int                 `json:"hours"`
}

func (s *Service) readSupplyRule(ctx context.Context) (storedSupplyRule, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key='market_supply'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedSupplyRule{}, nil
	}
	if err != nil {
		return storedSupplyRule{}, err
	}
	var rule storedSupplyRule
	if err := json.Unmarshal(raw, &rule); err != nil || rule.ID == "" {
		return storedSupplyRule{}, errors.New("invalid market supply rule")
	}
	rule.original = append(json.RawMessage(nil), raw...)
	return rule, nil
}

func (s *Service) supplySellers(ctx context.Context, recipe storedSupplyRecipe) ([]Seller, error) {
	keys := recipe.Sellers
	if len(keys) == 0 && recipe.Seller != "" {
		keys = []string{recipe.Seller}
	}
	if len(keys) < 1 || len(keys) > 100 {
		return nil, errors.New("seller list invalid")
	}
	rows, err := s.pool.Query(ctx, `SELECT lower(username),account_id,display_name,banned,retired FROM fishing.identities WHERE lower(username)=ANY($1::text[])`, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byKey := map[string]Seller{}
	for rows.Next() {
		var seller Seller
		var banned, retired bool
		if err := rows.Scan(&seller.Key, &seller.ID, &seller.Name, &banned, &retired); err != nil {
			return nil, err
		}
		if !banned && !retired {
			byKey[seller.Key] = seller
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]Seller, 0, len(keys))
	seen := map[string]bool{}
	for _, key := range keys {
		key = strings.ToLower(strings.TrimSpace(key))
		if seen[key] {
			continue
		}
		seen[key] = true
		seller, ok := byKey[key]
		if !ok {
			return nil, errors.New("seller unavailable")
		}
		out = append(out, seller)
	}
	return out, nil
}

func (s *Service) supplyStock(ctx context.Context, id string) (int, error) {
	var stock int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM fishing.market_orders WHERE source='admin' AND supply_id=$1 AND state='open' AND remaining>0 AND expires_at>clock_timestamp()`, id).Scan(&stock)
	return stock, err
}

func supplyCounts(rule storedSupplyRule, recipe storedSupplyRecipe, wanted int) map[string]int {
	counts := map[string]int{}
	kinds := []string{"fish", "material", "chest", "component"}
	if rule.Mode == "restock" {
		// Smooth weighted round robin spreads the recipe across small batches.
		// Continue from the persisted cursor so later categories cannot starve.
		total := 0
		for _, kind := range kinds {
			total += max(0, recipe.Counts[kind])
		}
		if total == 0 {
			return counts
		}
		weights := make([]int, len(kinds))
		offset := max(0, rule.Created) % total
		for i := 0; i < offset+wanted; i++ {
			selected := -1
			for j, kind := range kinds {
				if recipe.Counts[kind] <= 0 {
					continue
				}
				weights[j] += recipe.Counts[kind]
				if selected < 0 || weights[j] > weights[selected] {
					selected = j
				}
			}
			weights[selected] -= total
			if i >= offset {
				counts[kinds[selected]]++
			}
		}
		return counts
	}
	remaining := recipe.Counts
	if rule.Mode == "gradual" && len(rule.RemainingCounts) > 0 {
		remaining = rule.RemainingCounts
	}
	for _, kind := range kinds {
		if wanted == 0 {
			break
		}
		available := remaining[kind]
		if available <= 0 {
			continue
		}
		if available > wanted {
			available = wanted
		}
		counts[kind] = available
		wanted -= available
	}
	return counts
}

func (s *Service) saveSupplyError(ctx context.Context, rule storedSupplyRule, message string) error {
	rule.Enabled = false
	rule.Error = message
	return s.saveSupplyRule(ctx, rule)
}

func (s *Service) saveSupplyRule(ctx context.Context, rule storedSupplyRule) error {
	raw, _ := json.Marshal(rule)
	_, err := s.pool.Exec(ctx, `UPDATE fishing.operator_settings SET value=$1,updated_at=clock_timestamp() WHERE key='market_supply' AND value=$2::jsonb`, raw, rule.original)
	return err
}

// SupplyTick advances one persisted rule. The generated orders and the rule
// cursor are committed by the same asset command, so a crash cannot duplicate
// a batch or advance the cursor without its orders.
func (s *Service) SupplyTick(ctx context.Context, c *rules.Catalog) error {
	rule, err := s.readSupplyRule(ctx)
	if err != nil || rule.ID == "" || !rule.Enabled || time.Now().UnixMilli() < rule.NextAt {
		return err
	}
	var recipe storedSupplyRecipe
	rawRecipe, _ := json.Marshal(rule.Recipe)
	if err := json.Unmarshal(rawRecipe, &recipe); err != nil {
		return s.saveSupplyError(ctx, rule, "配方无效")
	}
	sellers, err := s.supplySellers(ctx, recipe)
	if err != nil {
		return s.saveSupplyError(ctx, rule, "卖家名单包含已删除或封禁账号，请修改后重新启动")
	}
	stock, err := s.supplyStock(ctx, rule.ID)
	if err != nil {
		return err
	}
	wanted := 0
	if rule.Mode == "gradual" {
		wanted = rule.Batch
		if wanted > rule.Remaining {
			wanted = rule.Remaining
		}
	} else if rule.Mode == "restock" && stock < rule.Threshold {
		rule.Refilling = true
	}
	if rule.Mode == "restock" && stock >= rule.Target {
		rule.Refilling = false
	}
	if rule.Mode == "restock" && rule.Refilling {
		wanted = rule.Target - stock
		if wanted > rule.Batch {
			wanted = rule.Batch
		}
	}
	if wanted <= 0 {
		rule.NextAt = time.Now().Add(time.Duration(rule.IntervalSeconds) * time.Second).UnixMilli()
		rule.Error = ""
		return s.saveSupplyRule(ctx, rule)
	}
	counts := supplyCounts(rule, recipe, wanted)
	if len(counts) == 0 {
		return s.saveSupplyError(ctx, rule, "计划已耗尽")
	}
	options := BulkOptions{Counts: counts, Picks: recipe.Picks, Part: recipe.Part, Quality: recipe.Quality, AffixMin: recipe.AffixMin, AffixMax: recipe.AffixMax, QtyMin: recipe.QtyMin, QtyMax: recipe.QtyMax, MulMin: recipe.MulMin, MulMax: recipe.MulMax, Hours: recipe.Hours}
	key := fmt.Sprintf("market:supply:%s:%d:%d", rule.ID, rule.Created, rule.NextAt)
	plan, err := BuildBulkPlan(c, options, BulkSeed(key))
	if err != nil || len(plan.Items) != wanted {
		if err == nil {
			err = errors.New("生成数量不符，计划已暂停")
		}
		return s.saveSupplyError(ctx, rule, err.Error())
	}
	rule.Created += wanted
	rule.NextAt = time.Now().Add(time.Duration(rule.IntervalSeconds) * time.Second).UnixMilli()
	rule.Error = ""
	if rule.Mode == "gradual" {
		rule.Remaining -= wanted
		for kind, n := range counts {
			rule.RemainingCounts[kind] -= n
		}
		if rule.Remaining <= 0 {
			rule.Remaining = 0
			rule.Enabled = false
		}
	}
	newRule, _ := json.Marshal(rule)
	_, err = s.AdminBulk(ctx, AdminBulkRequest{ActorID: sellers[0].ID, ActorName: sellers[0].Name, RequestKey: key, Sellers: sellers, Plan: plan, SupplyID: rule.ID, BeforeRule: rule.original, AfterRule: newRule})
	return err
}

func (s *Service) RunSupply(ctx context.Context, c *rules.Catalog, logger *slog.Logger) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		batchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if err := s.SupplyTick(batchCtx, c); err != nil && logger != nil {
			logger.Warn("market_supply_retry", "error", err)
		}
		cancel()
	}
}
