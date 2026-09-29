package breeding

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

type Command struct {
	Action     string `json:"action"`
	RequestKey string `json:"requestKey"`
	Species    string `json:"species"`
	Tier       string `json:"tier"`
	ID         string `json:"id"`
	OtherID    string `json:"otherId"`
	ItemID     string `json:"itemId"`
	TargetGene string `json:"targetGene"`
}

type Individual struct {
	Fish
	Phenotype Phenotype `json:"phenotype"`
}

type Stock struct {
	Species  string `json:"species"`
	Tier     string `json:"tier"`
	Quantity int64  `json:"quantity"`
}

type View struct {
	Fish          []Individual     `json:"fish"`
	Stock         []Stock          `json:"stock"`
	Capacity      int              `json:"capacity"`
	BreedCost     int              `json:"breedCost"`
	MutationRate  float64          `json:"mutationRate"`
	Catalog       int              `json:"catalogVersion"`
	Reagents      map[string]int64 `json:"reagents"`
	ReagentPrices map[string]int64 `json:"reagentPrices"`
}

var directedItems = map[string]string{
	"gene_albino": "albino", "gene_star": "star", "gene_veil": "veil", "gene_glow": "glow", "gene_prism": "",
}
var reagentPrices = map[string]int64{
	"gene_albino": 1500, "gene_star": 1500, "gene_veil": 1800, "gene_glow": 1800, "gene_prism": 2200,
}

func directedTarget(in Command) (string, error) {
	if in.ItemID == "" {
		if in.TargetGene != "" {
			return "", assets.ErrInvalid
		}
		return "", nil
	}
	target, ok := directedItems[in.ItemID]
	if !ok {
		return "", assets.ErrInvalid
	}
	if in.ItemID == "gene_prism" {
		if _, ok := Catalog.Colors[in.TargetGene]; !ok {
			return "", assets.ErrInvalid
		}
		return in.TargetGene, nil
	}
	if in.TargetGene != "" && in.TargetGene != target {
		return "", assets.ErrInvalid
	}
	return target, nil
}

func parseID(id string) (int64, error) {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n < 1 {
		return 0, assets.ErrInvalid
	}
	return n, nil
}

func read(ctx context.Context, q assets.SQL, owner int64, id string) (Fish, error) {
	n, err := parseID(id)
	if err != nil {
		return Fish{}, err
	}
	var raw []byte
	err = q.QueryRow(ctx, `SELECT genome FROM fishing.breeding_fish WHERE owner_id=$1 AND id=$2`, owner, n).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Fish{}, assets.Rejection("breeding_parent_not_found")
	}
	if err != nil {
		return Fish{}, err
	}
	var fish Fish
	if err = json.Unmarshal(raw, &fish); err != nil || !Valid(fish) {
		return Fish{}, errors.New("stored breeding genome is invalid")
	}
	return normalizeLegacy(fish), nil
}

func (s *Service) View(ctx context.Context, owner int64) (View, error) {
	view := View{Fish: []Individual{}, Stock: []Stock{}, Reagents: map[string]int64{}, ReagentPrices: reagentPrices, Capacity: Capacity, BreedCost: BreedCost, MutationRate: MutationRate, Catalog: Catalog.Version}
	rows, err := s.pool.Query(ctx, `SELECT genome FROM fishing.breeding_fish WHERE owner_id=$1 ORDER BY born_at,id`, owner)
	if err != nil {
		return View{}, err
	}
	for rows.Next() {
		var raw []byte
		var fish Fish
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return View{}, err
		}
		if err = json.Unmarshal(raw, &fish); err != nil {
			rows.Close()
			return View{}, err
		}
		fish = normalizeLegacy(fish)
		phenotype, expressErr := Express(fish)
		if expressErr != nil {
			rows.Close()
			return View{}, expressErr
		}
		view.Fish = append(view.Fish, Individual{Fish: fish, Phenotype: phenotype})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return View{}, err
	}

	rows, err = s.pool.Query(ctx, `SELECT s.item_id,s.tier,s.quantity
		FROM fishing.inventory_stacks s
		JOIN fishing.item_definitions d ON d.id=s.item_id
		WHERE s.owner_id=$1 AND d.kind='fish' AND s.quantity>0
		ORDER BY s.item_id,s.tier`, owner)
	if err != nil {
		return View{}, err
	}
	for rows.Next() {
		var stock Stock
		if err = rows.Scan(&stock.Species, &stock.Tier, &stock.Quantity); err != nil {
			return View{}, err
		}
		if species, supported := Catalog.Species[stock.Species]; supported && species.Group == "fish" {
			view.Stock = append(view.Stock, stock)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return View{}, err
	}
	rows, err = s.pool.Query(ctx, `SELECT item_id,quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND tier='normal' AND item_id=ANY($2) AND quantity>0`, owner,
		[]string{"gene_albino", "gene_star", "gene_veil", "gene_glow", "gene_prism"})
	if err != nil {
		return View{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var quantity int64
		if err = rows.Scan(&id, &quantity); err != nil {
			return View{}, err
		}
		view.Reagents[id] = quantity
	}
	return view, rows.Err()
}

func (s *Service) Apply(ctx context.Context, owner int64, in Command) (assets.Result, error) {
	if in.Action != "founder" && in.Action != "breed" && in.Action != "release" && in.Action != "buy_reagent" {
		return assets.Result{}, assets.ErrInvalid
	}
	target := ""
	if in.Action == "breed" {
		var err error
		target, err = directedTarget(in)
		if err != nil {
			return assets.Result{}, err
		}
	} else if in.Action == "buy_reagent" {
		if _, ok := reagentPrices[in.ItemID]; !ok || in.TargetGene != "" {
			return assets.Result{}, assets.ErrInvalid
		}
	} else if in.ItemID != "" || in.TargetGene != "" {
		return assets.Result{}, assets.ErrInvalid
	}
	var seed []byte
	if in.Action == "breed" {
		seed = make([]byte, 32)
		if _, err := rand.Read(seed); err != nil {
			return assets.Result{}, err
		}
	}
	return assets.New(s.pool).Run(ctx, assets.Command{
		ActorID: owner, RequestKey: in.RequestKey, Kind: "fish_breeding",
		RuleVersion: "fish-genetics-v3", Players: []int64{owner}, Input: in,
	}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		if in.Action == "buy_reagent" {
			if err := tx.Coins(ctx, owner, -reagentPrices[in.ItemID]); err != nil {
				return assets.Result{}, err
			}
			if err := tx.Stacks(ctx, owner, []assets.StackDelta{{ItemID: in.ItemID, Tier: "normal", Quantity: 1}}); err != nil {
				return assets.Result{}, err
			}
			return assets.Result{Status: "reagent_bought", ResourceID: in.ItemID}, nil
		}
		if in.Action == "release" {
			fish, err := read(ctx, tx.SQL(), owner, in.ID)
			if err != nil {
				return assets.Result{}, err
			}
			if !fish.Active {
				return assets.Result{}, assets.Rejection("breeding_already_released")
			}
			fish.Active = false
			raw, err := json.Marshal(fish)
			if err != nil {
				return assets.Result{}, err
			}
			n, _ := parseID(in.ID)
			_, err = tx.SQL().Exec(ctx, `UPDATE fishing.breeding_fish SET active=false,genome=$3 WHERE owner_id=$1 AND id=$2`, owner, n, raw)
			return assets.Result{Status: "released", ResourceID: in.ID}, err
		}

		var active int
		if err := tx.SQL().QueryRow(ctx, `SELECT count(*) FROM fishing.breeding_fish WHERE owner_id=$1 AND active`, owner).Scan(&active); err != nil {
			return assets.Result{}, err
		}
		if active >= Capacity {
			return assets.Result{}, assets.Rejection("breeding_capacity")
		}

		var fish Fish
		status := "founder_added"
		if in.Action == "founder" {
			var err error
			fish, err = Founder(in.Species, in.Tier)
			if err != nil {
				return assets.Result{}, assets.Rejection("breeding_invalid_founder")
			}
			if err = tx.Stacks(ctx, owner, []assets.StackDelta{{ItemID: in.Species, Tier: in.Tier, Quantity: -1}}); err != nil {
				return assets.Result{}, err
			}
		} else {
			a, err := read(ctx, tx.SQL(), owner, in.ID)
			if err != nil {
				return assets.Result{}, err
			}
			b, err := read(ctx, tx.SQL(), owner, in.OtherID)
			if err != nil {
				return assets.Result{}, err
			}
			fish, err = Breed(a, b, seed, target)
			if err != nil {
				return assets.Result{}, assets.Rejection("breeding_incompatible")
			}
			if err = tx.Coins(ctx, owner, -BreedCost); err != nil {
				return assets.Result{}, err
			}
			if in.ItemID != "" {
				if err = tx.Stacks(ctx, owner, []assets.StackDelta{{ItemID: in.ItemID, Tier: "normal", Quantity: -1}}); err != nil {
					return assets.Result{}, err
				}
			}
			status = "offspring_born"
		}

		fish.ID = strconv.FormatInt(tx.OperationID(), 10)
		fish.BornAt = time.Now().UnixMilli()
		raw, err := json.Marshal(fish)
		if err != nil {
			return assets.Result{}, err
		}
		if _, err = tx.SQL().Exec(ctx, `INSERT INTO fishing.breeding_fish(id,owner_id,generation,active,genome) VALUES($1,$2,$3,true,$4)`, tx.OperationID(), owner, fish.Generation, raw); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: status, ResourceID: fish.ID}, nil
	})
}
