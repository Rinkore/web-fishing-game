package breeding

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
)

const SpawnInterval = 10 * time.Minute

var habitatCaps = map[string]int{"aquarium": 8, "freshwater": 12, "marine": 10}
var habitatLabels = map[string]string{"aquarium": "淡水观赏鱼缸", "freshwater": "淡水养殖场", "marine": "海水养殖场"}

type Habitat struct {
	ID              string   `json:"id"`
	Kind            string   `json:"kind"`
	Name            string   `json:"name"`
	Capacity        int      `json:"capacity"`
	FishIDs         []string `json:"fishIds"`
	CompatiblePairs int      `json:"compatiblePairs"`
	NextSpawnAt     int64    `json:"nextSpawnAt"`
	Status          string   `json:"status"`
	cycle           int64
}

func CanHouse(kind string, fish Fish) bool {
	species, exists := Catalog.Species[fish.Species]
	if !exists || species.Group != "fish" {
		return false
	}
	phenotype, err := Express(fish)
	if err != nil {
		return false
	}
	switch kind {
	case "aquarium":
		return species.Habitat == "freshwater" && species.Ornamental && phenotype.Size == "normal"
	case "freshwater":
		return species.Habitat == "freshwater"
	case "marine":
		return species.Habitat == "marine"
	}
	return false
}

func readHabitat(ctx context.Context, q assets.SQL, owner int64, id string) (Habitat, error) {
	n, err := parseID(id)
	if err != nil {
		return Habitat{}, err
	}
	var h Habitat
	var slot int
	err = q.QueryRow(ctx, `SELECT id,kind,slot,capacity,cycle,(extract(epoch FROM next_spawn_at)*1000)::bigint FROM fishing.fish_habitats WHERE owner_id=$1 AND id=$2`, owner, n).Scan(&h.ID, &h.Kind, &slot, &h.Capacity, &h.cycle, &h.NextSpawnAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return h, assets.Rejection("breeding_habitat_not_found")
	}
	h.Name = fmt.Sprintf("%s %d", habitatLabels[h.Kind], slot)
	return h, err
}

func (s *Service) habitats(ctx context.Context, owner int64, fish []Individual) ([]Habitat, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,kind,slot,capacity,cycle,(extract(epoch FROM next_spawn_at)*1000)::bigint FROM fishing.fish_habitats WHERE owner_id=$1 ORDER BY id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Habitat{}
	for rows.Next() {
		var h Habitat
		var slot int
		if err = rows.Scan(&h.ID, &h.Kind, &slot, &h.Capacity, &h.cycle, &h.NextSpawnAt); err != nil {
			return nil, err
		}
		h.Name = fmt.Sprintf("%s %d", habitatLabels[h.Kind], slot)
		h.FishIDs = []string{}
		residents := []Fish{}
		for _, f := range fish {
			if f.Active && f.HabitatID == h.ID {
				h.FishIDs = append(h.FishIDs, f.ID)
				residents = append(residents, f.Fish)
			}
		}
		for i := range residents {
			for j := i + 1; j < len(residents); j++ {
				if CanPair(residents[i], residents[j]) {
					h.CompatiblePairs++
				}
			}
		}
		h.Status = "waiting"
		if len(residents) >= h.Capacity {
			h.Status = "full"
		} else if h.CompatiblePairs == 0 {
			h.Status = "no_pair"
		}
		result = append(result, h)
	}
	return result, rows.Err()
}

func resetHabitat(ctx context.Context, q assets.SQL, owner int64, id string) error {
	if id == "" {
		return nil
	}
	n, err := parseID(id)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `UPDATE fishing.fish_habitats SET cycle=cycle+1,next_spawn_at=clock_timestamp()+interval '10 minutes' WHERE owner_id=$1 AND id=$2`, owner, n)
	return err
}

func checkRoom(ctx context.Context, q assets.SQL, owner int64, id string, fish Fish) error {
	h, err := readHabitat(ctx, q, owner, id)
	if err != nil {
		return err
	}
	if !CanHouse(h.Kind, fish) {
		return assets.Rejection("breeding_wrong_habitat")
	}
	var count int
	if err = q.QueryRow(ctx, `SELECT count(*) FROM fishing.breeding_fish WHERE owner_id=$1 AND habitat_id=$2::bigint AND active AND (NULLIF($3,'') IS NULL OR id<>NULLIF($3,'')::bigint)`, owner, id, fish.ID).Scan(&count); err != nil {
		return err
	}
	if count >= h.Capacity {
		return assets.Rejection("breeding_habitat_full")
	}
	return nil
}

func (s *Service) habitatAction(ctx context.Context, owner int64, in Command) (assets.Result, error) {
	if in.ItemID != "" || in.TargetGene != "" {
		return assets.Result{}, assets.ErrInvalid
	}
	return assets.New(s.pool).Run(ctx, assets.Command{ActorID: owner, RequestKey: in.RequestKey, Kind: "fish_breeding", RuleVersion: "fish-habitats-v1", Players: []int64{owner}, Input: in}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		if in.Action == "habitat_create" {
			cap, ok := habitatCaps[in.HabitatKind]
			if !ok {
				return assets.Result{}, assets.ErrInvalid
			}
			var slot int
			err := tx.SQL().QueryRow(ctx, `SELECT COALESCE(min(n),0) FROM generate_series(1,2) n WHERE NOT EXISTS(SELECT 1 FROM fishing.fish_habitats WHERE owner_id=$1 AND kind=$2 AND slot=n)`, owner, in.HabitatKind).Scan(&slot)
			if err != nil {
				return assets.Result{}, err
			}
			if slot == 0 {
				return assets.Result{}, assets.Rejection("breeding_habitat_limit")
			}
			var id string
			err = tx.SQL().QueryRow(ctx, `INSERT INTO fishing.fish_habitats(owner_id,kind,slot,capacity) VALUES($1,$2,$3,$4) RETURNING id`, owner, in.HabitatKind, slot, cap).Scan(&id)
			return assets.Result{Status: "habitat_created", ResourceID: id}, err
		}
		fish, err := read(ctx, tx.SQL(), owner, in.ID)
		if err != nil {
			return assets.Result{}, err
		}
		if !fish.Active {
			return assets.Result{}, assets.Rejection("breeding_already_released")
		}
		previous, err := fishHabitat(ctx, tx.SQL(), owner, in.ID)
		if err != nil {
			return assets.Result{}, err
		}
		target := in.HabitatID
		if in.Action == "unstock" {
			target = ""
		}
		if target == previous {
			return assets.Result{Status: "fish_moved", ResourceID: fish.ID}, nil
		}
		if target == "" {
			if err = checkWorkbenchRoom(ctx, tx.SQL(), owner); err != nil {
				return assets.Result{}, err
			}
		}
		if target != "" {
			if err = checkRoom(ctx, tx.SQL(), owner, target, fish); err != nil {
				return assets.Result{}, err
			}
		}
		if _, err = tx.SQL().Exec(ctx, `UPDATE fishing.breeding_fish SET habitat_id=NULLIF($3,'')::bigint WHERE owner_id=$1 AND id=$2::bigint`, owner, in.ID, target); err != nil {
			return assets.Result{}, err
		}
		if err = resetHabitat(ctx, tx.SQL(), owner, previous); err != nil {
			return assets.Result{}, err
		}
		if err = resetHabitat(ctx, tx.SQL(), owner, target); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "fish_moved", ResourceID: fish.ID}, nil
	})
}

func fishHabitat(ctx context.Context, q assets.SQL, owner int64, id string) (string, error) {
	var habitat string
	err := q.QueryRow(ctx, `SELECT COALESCE(habitat_id::text,'') FROM fishing.breeding_fish WHERE owner_id=$1 AND id=$2::bigint`, owner, id).Scan(&habitat)
	return habitat, err
}

// Both workflows share the owner transaction guard, but not their capacity.
func checkWorkbenchRoom(ctx context.Context, q assets.SQL, owner int64) error {
	var count int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM fishing.breeding_fish WHERE owner_id=$1 AND active AND habitat_id IS NULL`, owner).Scan(&count); err != nil {
		return err
	}
	if count >= Capacity {
		return assets.Rejection("breeding_capacity")
	}
	return nil
}

// Spawn serializes with stocking, releases and manual breeding under the owner
// guard. The persisted cycle key makes simultaneous workers produce one child.
func (s *Service) Spawn(ctx context.Context, owner int64, id string, cycle int64) (assets.Result, error) {
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return assets.Result{}, err
	}
	key := fmt.Sprintf("habitat:auto:%d:%s:%d", owner, id, cycle)
	return assets.New(s.pool).Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "fish_breeding", RuleVersion: "fish-habitats-v1", Players: []int64{owner}, Input: struct {
		ID    string
		Cycle int64
	}{id, cycle}}, func(ctx context.Context, tx *assets.Transaction) (assets.Result, error) {
		h, err := readHabitat(ctx, tx.SQL(), owner, id)
		if err != nil {
			return assets.Result{}, err
		}
		var now int64
		if err = tx.SQL().QueryRow(ctx, `SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint`).Scan(&now); err != nil {
			return assets.Result{}, err
		}
		if h.cycle != cycle {
			return assets.Result{Status: "not_due"}, nil
		}
		if now < h.NextSpawnAt {
			return assets.Result{}, assets.ErrDeferred
		}
		rows, err := tx.SQL().Query(ctx, `SELECT genome FROM fishing.breeding_fish WHERE owner_id=$1 AND habitat_id=$2::bigint AND active ORDER BY id`, owner, id)
		if err != nil {
			return assets.Result{}, err
		}
		residents := []Fish{}
		for rows.Next() {
			var raw []byte
			var f Fish
			if err = rows.Scan(&raw); err != nil {
				rows.Close()
				return assets.Result{}, err
			}
			if err = json.Unmarshal(raw, &f); err != nil {
				rows.Close()
				return assets.Result{}, err
			}
			if !Valid(f) {
				rows.Close()
				return assets.Result{}, errors.New("stored breeding genome is invalid")
			}
			residents = append(residents, normalizeLegacy(f))
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return assets.Result{}, err
		}
		pairs := [][2]int{}
		for i := range residents {
			for j := i + 1; j < len(residents); j++ {
				if CanPair(residents[i], residents[j]) {
					pairs = append(pairs, [2]int{i, j})
				}
			}
		}
		status := "no_pair"
		if len(residents) >= h.Capacity {
			status = "habitat_full"
		} else if len(pairs) > 0 {
			chosen := pairs[int(seed[0])%len(pairs)]
			child, breedErr := Breed(residents[chosen[0]], residents[chosen[1]], seed)
			if breedErr != nil {
				return assets.Result{}, breedErr
			}
			if !CanHouse(h.Kind, child) {
				return assets.Result{}, errors.New("offspring habitat mismatch")
			}
			child.ID = strconv.FormatInt(tx.OperationID(), 10)
			child.BornAt = now
			raw, marshalErr := json.Marshal(child)
			if marshalErr != nil {
				return assets.Result{}, marshalErr
			}
			if _, err = tx.SQL().Exec(ctx, `INSERT INTO fishing.breeding_fish(id,owner_id,generation,active,genome,habitat_id) VALUES($1,$2,$3,true,$4,$5::bigint)`, tx.OperationID(), owner, child.Generation, raw, id); err != nil {
				return assets.Result{}, err
			}
			status = "natural_offspring"
		}
		if err = resetHabitat(ctx, tx.SQL(), owner, id); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: status, ResourceID: strconv.FormatInt(tx.OperationID(), 10)}, nil
	})
}

func (s *Service) Sweep(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `SELECT h.owner_id,h.id::text,h.cycle FROM fishing.fish_habitats h JOIN fishing.identities i ON i.account_id=h.owner_id WHERE h.next_spawn_at<=clock_timestamp() AND NOT i.banned ORDER BY h.next_spawn_at,h.id LIMIT 32`)
	if err != nil {
		return err
	}
	type due struct {
		owner int64
		id    string
		cycle int64
	}
	list := []due{}
	for rows.Next() {
		var d due
		if err = rows.Scan(&d.owner, &d.id, &d.cycle); err != nil {
			rows.Close()
			return err
		}
		list = append(list, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, d := range list {
		if _, err = s.Spawn(ctx, d.owner, d.id, d.cycle); err != nil && !errors.Is(err, assets.ErrDeferred) {
			return err
		}
	}
	return nil
}

func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	var warned time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := s.Sweep(work)
		cancel()
		if err != nil && ctx.Err() == nil && time.Since(warned) > time.Minute {
			logger.Warn("aquaculture_retry")
			warned = time.Now()
		}
	}
}
