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
	Fish          []Individual `json:"fish"`
	Stock         []Stock      `json:"stock"`
	MaxGeneration int          `json:"maxGeneration"`
	Capacity      int          `json:"capacity"`
	BreedCost     int          `json:"breedCost"`
	MutationRate  float64      `json:"mutationRate"`
	Catalog       int          `json:"catalogVersion"`
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
	return fish, nil
}

func (s *Service) View(ctx context.Context, owner int64) (View, error) {
	view := View{Fish: []Individual{}, Stock: []Stock{}, MaxGeneration: MaxGeneration, Capacity: Capacity, BreedCost: BreedCost, MutationRate: MutationRate, Catalog: Catalog.Version}
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
	defer rows.Close()
	for rows.Next() {
		var stock Stock
		if err = rows.Scan(&stock.Species, &stock.Tier, &stock.Quantity); err != nil {
			return View{}, err
		}
		if species, supported := Catalog.Species[stock.Species]; supported && species.Group == "fish" {
			view.Stock = append(view.Stock, stock)
		}
	}
	return view, rows.Err()
}

func (s *Service) Apply(ctx context.Context, owner int64, in Command) (assets.Result, error) {
	if in.Action != "founder" && in.Action != "breed" && in.Action != "release" {
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
		RuleVersion: "fish-genetics-v2", Players: []int64{owner}, Input: in,
	}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
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

		var active, total int
		if err := tx.SQL().QueryRow(ctx, `SELECT count(*) FILTER(WHERE active),count(*) FROM fishing.breeding_fish WHERE owner_id=$1`, owner).Scan(&active, &total); err != nil {
			return assets.Result{}, err
		}
		if active >= Capacity {
			return assets.Result{}, assets.Rejection("breeding_capacity")
		}
		// Released fish remain immutable ancestry. Bound the archive instead of
		// silently deleting a parent that a later generation still references.
		if total >= 2000 {
			return assets.Result{}, assets.Rejection("breeding_archive_capacity")
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
			fish, err = Breed(a, b, seed)
			if err != nil {
				return assets.Result{}, assets.Rejection("breeding_incompatible")
			}
			if err = tx.Coins(ctx, owner, -BreedCost); err != nil {
				return assets.Result{}, err
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
