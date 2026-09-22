package market

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

const BulkListMax = 500

type BulkOptions struct {
	Counts   map[string]int
	Picks    map[string][]string
	Part     string
	Quality  map[string]float64
	AffixMin int
	AffixMax int
	QtyMin   int
	QtyMax   int
	MulMin   float64
	MulMax   float64
	Hours    int
}

type BulkItem struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Kind         string          `json:"kind"`
	Quantity     int64           `json:"qty"`
	Price        int64           `json:"price"`
	DefinitionID string          `json:"definitionId,omitempty"`
	Part         string          `json:"part,omitempty"`
	Attributes   json.RawMessage `json:"attributes,omitempty"`
}

type BulkPlan struct {
	Items  []BulkItem     `json:"items"`
	Hours  int            `json:"hours"`
	Mul    string         `json:"mul"`
	ByKind map[string]int `json:"byKind"`
}

func normalizeBulkOptions(o BulkOptions) (BulkOptions, error) {
	if o.Counts == nil {
		o.Counts = map[string]int{}
	}
	kinds := []string{"fish", "material", "chest", "component"}
	total := 0
	active := false
	for _, kind := range kinds {
		n := o.Counts[kind]
		if n < 0 {
			n = 0
		}
		if n > BulkListMax {
			return o, fmt.Errorf("单类最多 %d 条，请调小：%s", BulkListMax, kind)
		}
		o.Counts[kind] = n
		if n > 0 {
			active = true
			total += n
		}
	}
	if !active {
		return o, errors.New("请至少给一类物品设置条数")
	}
	if total > BulkListMax {
		return o, fmt.Errorf("单次最多上架 %d 条（当前 %d 条）", BulkListMax, total)
	}
	if o.Quality == nil {
		o.Quality = map[string]float64{}
	}
	for _, q := range []string{"common", "rare", "epic", "mythic"} {
		if _, ok := o.Quality[q]; !ok {
			switch q {
			case "common":
				o.Quality[q] = 3
			case "rare":
				o.Quality[q] = 2
			case "epic":
				o.Quality[q] = 1
			default:
				o.Quality[q] = 0
			}
		}
		if o.Quality[q] < 0 || math.IsNaN(o.Quality[q]) || math.IsInf(o.Quality[q], 0) {
			o.Quality[q] = 0
		}
	}
	if o.Counts["component"] > 0 {
		positive := false
		for _, q := range []string{"common", "rare", "epic", "mythic"} {
			positive = positive || o.Quality[q] > 0
		}
		if !positive {
			return o, errors.New("组件的品质权重至少要有一项大于 0")
		}
	}
	o.AffixMin = clampInt(o.AffixMin, 1, 1, 4)
	o.AffixMax = clampInt(o.AffixMax, 0, 0, 4)
	if o.Counts["component"] > 0 && o.AffixMax > 0 && o.AffixMax < o.AffixMin {
		return o, errors.New("词条数量上限不能低于下限")
	}
	o.QtyMin = clampInt(o.QtyMin, 1, 1, 999)
	o.QtyMax = clampInt(o.QtyMax, 1, 1, 999)
	if o.QtyMax < o.QtyMin {
		o.QtyMax = o.QtyMin
	}
	o.MulMin = clampFloat(o.MulMin, 1, .1, 10)
	o.MulMax = clampFloat(o.MulMax, 1, .1, 10)
	if o.MulMin > o.MulMax {
		o.MulMin, o.MulMax = o.MulMax, o.MulMin
	}
	if o.Hours != 6 && o.Hours != 12 && o.Hours != 24 {
		o.Hours = 24
	}
	return o, nil
}

func clampInt(v, def, lo, hi int) int {
	if v == 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
func clampFloat(v, def, lo, hi float64) float64 {
	if v == 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return def
	}
	v = math.Round(v*100) / 100
	return math.Max(lo, math.Min(hi, v))
}

func BulkSeed(key string) int64 {
	h := sha256.Sum256([]byte(key))
	return int64(binarySeed(h[:]))
}

func binarySeed(raw []byte) uint64 {
	var n uint64
	for _, b := range raw[:8] {
		n = n<<8 | uint64(b)
	}
	return n
}

// BuildBulkPlan mirrors the legacy admin generator while keeping all rule
// resolution in the immutable Go catalog. The seed makes retries reproduce
// the exact same generated orders before the asset command is committed.
func BuildBulkPlan(c *rules.Catalog, input BulkOptions, seed int64) (BulkPlan, error) {
	o, err := normalizeBulkOptions(input)
	if err != nil {
		return BulkPlan{}, err
	}
	if c == nil {
		return BulkPlan{}, assets.ErrUnavailable
	}
	byKind := map[string]int{}
	itemsByKind := map[string][]rules.Item{}
	for _, item := range c.Items {
		if item.Kind == "fish" || item.Kind == "material" || item.Kind == "chest" || item.Kind == "component" {
			itemsByKind[item.Kind] = append(itemsByKind[item.Kind], item)
		}
	}
	for _, kind := range []string{"fish", "material", "chest", "component"} {
		if o.Counts[kind] == 0 {
			continue
		}
		all := itemsByKind[kind]
		if kind == "component" && o.Part != "" {
			filtered := all[:0]
			for _, item := range all {
				if item.Part == o.Part {
					filtered = append(filtered, item)
				}
			}
			all = filtered
		}
		picks := o.Picks[kind]
		if len(picks) > 0 {
			selected := []rules.Item{}
			for _, id := range picks {
				found := false
				for _, item := range all {
					if item.ID == id {
						selected = append(selected, item)
						found = true
						break
					}
				}
				if !found {
					if kind == "component" {
						return BulkPlan{}, fmt.Errorf("限定物品包含未知或错误类型：%s", kind)
					}
					return BulkPlan{}, fmt.Errorf("限定物品包含未知或错误类型：%s", kind)
				}
			}
			all = selected
		}
		if len(all) == 0 {
			if kind == "component" && len(picks) > 0 {
				return BulkPlan{}, errors.New("限定的组件底材都不在所选部位下（换部位或清空底材限定）")
			}
			return BulkPlan{}, errors.New("所选部位下没有可用的底材（换部位或清空底材限定）")
		}
		itemsByKind[kind] = all
	}
	rng := rand.New(rand.NewSource(seed))
	draw := func() float64 { return rng.Float64() }
	qualityNames := []string{"common", "rare", "epic", "mythic"}
	qualityWeights := []float64{o.Quality["common"], o.Quality["rare"], o.Quality["epic"], o.Quality["mythic"]}
	countWeights := []float64{0, 0, 0, 0}
	for i := range countWeights {
		n := i + 1
		if n >= o.AffixMin && (o.AffixMax == 0 || n <= o.AffixMax) {
			countWeights[i] = 1
		}
	}
	plan := BulkPlan{Items: []BulkItem{}, Hours: o.Hours, ByKind: byKind}
	for _, kind := range []string{"fish", "material", "chest", "component"} {
		for i := 0; i < o.Counts[kind]; i++ {
			choices := itemsByKind[kind]
			item := choices[int(draw()*float64(len(choices)))%len(choices)]
			id, name, definition, part, attrs := item.ID, item.Name, "", "", json.RawMessage(nil)
			if kind == "component" {
				qIndex := weightedIndex(qualityWeights, draw)
				quality := qualityNames[qIndex]
				signature, ok := c.Generate(item.ID, quality, c.ComponentConfig(), rules.GenerateOptions{CountWeights: countWeights, MinAffixes: o.AffixMin}, draw)
				if !ok {
					continue
				}
				id = signature
				meta, ok := c.ComponentMeta(signature)
				if !ok {
					continue
				}
				name, definition, part = meta.Name, item.ID, item.Part
				attrs, _ = json.Marshal(map[string]string{"signature": signature})
			}
			qty := int64(1)
			if kind != "component" {
				qty = int64(o.QtyMin)
				if o.QtyMax > o.QtyMin {
					qty += int64(rng.Intn(o.QtyMax - o.QtyMin + 1))
				}
			}
			base := item.Price
			if base <= 0 {
				base = 10
			}
			price := int64(math.Round(base * (o.MulMin + draw()*(o.MulMax-o.MulMin))))
			if price < 1 {
				price = 1
			}
			plan.Items = append(plan.Items, BulkItem{ID: id, Name: name, Kind: kind, Quantity: qty, Price: price, DefinitionID: definition, Part: part, Attributes: attrs})
			byKind[kind]++
		}
	}
	if len(plan.Items) == 0 {
		return BulkPlan{}, errors.New("没有生成出任何可上架的物品（检查限定物品与品质权重）")
	}
	if o.MulMin == o.MulMax {
		plan.Mul = strconv.FormatFloat(o.MulMin, 'f', -1, 64)
	} else {
		plan.Mul = strconv.FormatFloat(o.MulMin, 'f', -1, 64) + "~" + strconv.FormatFloat(o.MulMax, 'f', -1, 64)
	}
	return plan, nil
}

func weightedIndex(weights []float64, draw func() float64) int {
	total := 0.0
	for _, weight := range weights {
		if weight > 0 {
			total += weight
		}
	}
	if total <= 0 {
		return 0
	}
	x := draw() * total
	for i, weight := range weights {
		if weight <= 0 {
			continue
		}
		x -= weight
		if x < 0 {
			return i
		}
	}
	return len(weights) - 1
}

type Seller struct {
	ID   int64
	Key  string
	Name string
}

type AdminBulkRequest struct {
	ActorID    int64
	ActorName  string
	RequestKey string
	Sellers    []Seller
	Plan       BulkPlan
	SupplyID   string
	AfterRule  json.RawMessage
}

func (s *Service) AdminBulk(ctx context.Context, r AdminBulkRequest) (assets.Result, error) {
	if r.ActorID < 1 || len(r.Sellers) < 1 || len(r.Sellers) > 100 || len(r.Plan.Items) < 1 || len(r.Plan.Items) > BulkListMax || (r.Plan.Hours != 6 && r.Plan.Hours != 12 && r.Plan.Hours != 24) {
		return assets.Result{}, assets.ErrInvalid
	}
	for _, item := range r.Plan.Items {
		if item.ID == "" || item.Quantity < 1 || item.Price < 1 || item.Price > assets.MaxCoins || item.Quantity > assets.MaxCoins/item.Price {
			return assets.Result{}, assets.ErrInvalid
		}
		switch item.Kind {
		case "fish", "material", "chest":
		case "component":
			if item.Quantity != 1 || item.DefinitionID == "" || item.Part == "" || len(item.Attributes) == 0 {
				return assets.Result{}, assets.ErrInvalid
			}
		default:
			return assets.Result{}, assets.ErrInvalid
		}
	}
	players := []int64{r.ActorID}
	for _, seller := range r.Sellers {
		if seller.ID < 1 {
			return assets.Result{}, assets.ErrInvalid
		}
		players = append(players, seller.ID)
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "admin_grant", RuleVersion: "admin-market-v1", Players: players, Input: struct {
		Plan      BulkPlan
		SupplyID  string
		AfterRule json.RawMessage
	}{r.Plan, r.SupplyID, r.AfterRule}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		if r.SupplyID != "" {
			var current []byte
			if err := t.SQL().QueryRow(ctx, `SELECT value FROM fishing.operator_settings WHERE key='market_supply' FOR UPDATE`).Scan(&current); err != nil {
				return assets.Result{}, err
			}
			var rule struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(current, &rule); err != nil || rule.ID != r.SupplyID {
				return assets.Result{}, assets.Rejection("supply_rule_changed")
			}
		}
		for _, seller := range r.Sellers {
			var active bool
			if err := t.SQL().QueryRow(ctx, `SELECT NOT banned AND NOT retired FROM fishing.identities WHERE account_id=$1`, seller.ID).Scan(&active); err != nil {
				return assets.Result{}, err
			}
			if !active {
				return assets.Result{}, assets.Rejection("seller_unavailable")
			}
		}
		created := make([]map[string]any, 0, len(r.Plan.Items))
		for i, item := range r.Plan.Items {
			seller := r.Sellers[i%len(r.Sellers)]
			kind := "stack"
			itemID := item.ID
			quantity := item.Quantity
			rodName := ""
			if item.Kind == "component" {
				kind = "equipment"
				itemID = ""
				quantity = 1
			}
			var orderID int64
			if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.market_orders(seller_id,kind,item_id,quantity,remaining,unit_price,rod_name,hours,created_operation,expires_at,source,supply_id)
 VALUES($1,$2,NULLIF($3,''),$4,$4,$5,$6,$7,$8,clock_timestamp()+($7::integer*interval '1 hour'),'admin',NULLIF($9,'')) RETURNING id`, seller.ID, kind, itemID, quantity, item.Price, rodName, r.Plan.Hours, t.OperationID(), r.SupplyID).Scan(&orderID); err != nil {
				return assets.Result{}, err
			}
			if item.Kind == "component" {
				id, err := t.CreateEquipment(ctx, seller.ID, assets.EquipmentSpec{DefinitionID: item.DefinitionID, Part: item.Part, Attributes: item.Attributes})
				if err != nil {
					return assets.Result{}, err
				}
				if err := t.HoldOrderEquipment(ctx, seller.ID, id, orderID); err != nil {
					return assets.Result{}, err
				}
			}
			created = append(created, map[string]any{"id": item.ID, "name": item.Name, "kind": item.Kind, "qty": item.Quantity, "price": item.Price, "orderId": strconv.FormatInt(orderID, 10), "seller": seller.Key})
		}
		if len(r.AfterRule) > 0 {
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.operator_settings(key,value,updated_at) VALUES('market_supply',$1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, r.AfterRule); err != nil {
				return assets.Result{}, err
			}
		}
		encoded, _ := json.Marshal(map[string]any{"created": created, "totalValue": totalValue(r.Plan.Items), "hours": r.Plan.Hours, "mul": r.Plan.Mul, "byKind": r.Plan.ByKind})
		action := "market/bulk"
		if r.SupplyID != "" {
			action = "market/supply/tick"
		}
		if err := insertAdminAudit(ctx, t.SQL(), r.ActorID, r.ActorName, action, nil, strings.Join(sellerKeys(r.Sellers), ","), fmt.Sprintf("created=%d", len(created))); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "supplied", Details: encoded}, nil
	})
}

func sellerKeys(sellers []Seller) []string {
	out := make([]string, 0, len(sellers))
	for _, seller := range sellers {
		out = append(out, seller.Key)
	}
	return out
}
func totalValue(items []BulkItem) int64 {
	total := int64(0)
	for _, item := range items {
		if item.Quantity > 0 && item.Price <= assets.MaxCoins/item.Quantity {
			total += item.Quantity * item.Price
		}
	}
	return total
}

type AdminReturnRequest struct {
	ActorID    int64
	ActorName  string
	RequestKey string
	OrderID    int64
}

func (s *Service) AdminReturn(ctx context.Context, r AdminReturnRequest) (assets.Result, error) {
	if r.ActorID < 1 || r.OrderID < 1 {
		return assets.Result{}, assets.ErrInvalid
	}
	var seller int64
	if err := s.pool.QueryRow(ctx, `SELECT seller_id FROM fishing.market_orders WHERE id=$1`, r.OrderID).Scan(&seller); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{Status: "listing_not_found"}, nil
		}
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: r.ActorID, RequestKey: r.RequestKey, Kind: "admin_grant", RuleVersion: "admin-market-v1", Players: []int64{r.ActorID, seller}, Input: struct{ OrderID int64 }{r.OrderID}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var kind, itemID, source, rodName, state string
		var sellerKey string
		var quantity, remaining, price int64
		var expires time.Time
		if err := t.SQL().QueryRow(ctx, `SELECT kind,COALESCE(item_id,''),source,rod_name,quantity,remaining,unit_price,expires_at,state FROM fishing.market_orders WHERE id=$1 AND seller_id=$2 FOR UPDATE`, r.OrderID, seller).Scan(&kind, &itemID, &source, &rodName, &quantity, &remaining, &price, &expires, &state); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return assets.Result{}, assets.Rejection("listing_not_found")
			}
			return assets.Result{}, err
		}
		var expired bool
		if err := t.SQL().QueryRow(ctx, `SELECT $1::timestamptz<=clock_timestamp()`, expires).Scan(&expired); err != nil {
			return assets.Result{}, err
		}
		if state != "open" || expired || remaining < 1 {
			return assets.Result{}, assets.Rejection("listing_not_found")
		}
		if err := t.SQL().QueryRow(ctx, `SELECT username FROM fishing.identities WHERE account_id=$1`, seller).Scan(&sellerKey); err != nil {
			return assets.Result{}, err
		}
		if source == "admin" {
			if kind != "stack" {
				if err := t.DiscardOrderEquipment(ctx, seller, r.OrderID); err != nil {
					return assets.Result{}, err
				}
			}
		} else if kind == "stack" {
			if err := t.Stacks(ctx, seller, []assets.StackDelta{{ItemID: itemID, Tier: "normal", Quantity: remaining}}); err != nil {
				return assets.Result{}, err
			}
		} else if err := t.ReturnOrderEquipment(ctx, seller, seller, r.OrderID, kind == "rod", rodName); err != nil {
			return assets.Result{}, err
		}
		if _, err := t.SQL().Exec(ctx, `UPDATE fishing.market_orders SET state='cancelled',remaining=0,closed_operation=$2 WHERE id=$1`, r.OrderID, t.OperationID()); err != nil {
			return assets.Result{}, err
		}
		returned := map[string]any{"lid": r.OrderID, "id": itemID, "name": itemID, "qty": remaining, "seller": sellerKey, "price": price}
		if source == "admin" && kind != "stack" {
			returned["qty"] = quantity
		}
		encoded, _ := json.Marshal(returned)
		if err := insertAdminAudit(ctx, t.SQL(), r.ActorID, r.ActorName, "market/return", &seller, strconv.FormatInt(r.OrderID, 10), "source="+source); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "returned", Details: encoded}, nil
	})
}

func insertAdminAudit(ctx context.Context, q assets.SQL, actor int64, name, action string, subject *int64, target, detail string) error {
	_, err := q.Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,$4,$5,$6)`, actor, name, subject, action, target, detail)
	return err
}
