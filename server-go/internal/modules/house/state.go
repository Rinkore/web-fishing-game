// Package house owns the fish house ("渔屋"): a multi-phase drying-rack income
// system, its two growth lines (companions and roles) and the friend-steal
// ledger. Every write goes through the shared asset command boundary, so
// idempotency, feature gates and the operator audit trail behave exactly like
// the rest of the game.
//
// Income comes exclusively from placing fish on drying racks and collecting
// finished batches. There is no passive time-based income. Pets have four
// functional archetypes: guard (intercepts steals), production (speeds drying
// and raises premium chance), collect (auto-harvests finished batches), and
// scout (reserved for future fishing integration).
package house

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
)

// Pets maps a companion id to its affinity level (0..affinityMax).
type Pets map[string]int

// Roles maps a growth track ("cook"|"brine"|"trader") to invested points.
type Roles map[string]int

// RackPhase is one step in a batch's processing chain.
// "pre"  = brining/curing  (optional, requires brine role points)
// "dry"  = drying          (mandatory)
// "post" = pressing/fermentation (optional, requires cook role points)
type RackPhase = string

const (
	PhasePrep = "pre"
	PhaseDry  = "dry"
	PhasePost = "post"
)

// RackSlot is one drying-rack position. It is stored in the house_state jsonb
// extras and carries the full lifecycle of one batch: placed → drying (each
// phase completes in sequence) → ready (awaiting collect).
type RackSlot struct {
	SlotIdx   int         `json:"slotIdx"`           // position on the rack (0-based)
	FishID    string      `json:"fishId"`            // catalog item id of the raw fish
	FishTier  string      `json:"fishTier"`          // rarity tier ("common"…"legendary")
	FishPrice int64       `json:"fishPrice"`         // base sell price of the raw fish
	Phases    []RackPhase `json:"phases"`            // ordered processing chain
	PhaseIdx  int         `json:"phaseIdx"`          // index of the current active phase
	StartedAt time.Time   `json:"startedAt"`         // wall time when current phase started
	Premium   bool        `json:"premium,omitempty"` // set at collect time when premium roll succeeds
	Done      bool        `json:"done,omitempty"`    // true once all phases finished
}

// State is the player-owned part of a house row.
type State struct {
	Level   int   `json:"level"`
	Endless int   `json:"endless"`
	Pets    Pets  `json:"pets"`
	Roles   Roles `json:"roles"`
}

// Cost is an upgrade or renovation price.
type Cost struct {
	Coins int64            `json:"coins"`
	Items map[string]int64 `json:"items,omitempty"`
}

// StealView is the social budget shown on the steal tab. The coin limit is the
// one place the design keeps a hard amount cap: stealing is the only free coin
// injection channel left once the hut itself is time-bounded.
type StealView struct {
	PicksLeft int   `json:"picksLeft"`
	PicksMax  int   `json:"picksMax"`
	CoinCap   int64 `json:"coinCap"`
	CoinUsed  int64 `json:"coinUsed"`
	Heat      int   `json:"heat"`
}

// RackSlotView is the client-facing projection of one rack slot.
// ReadyAt is zero when the batch is still processing.
type RackSlotView struct {
	SlotIdx  int         `json:"slotIdx"`
	FishID   string      `json:"fishId"`
	FishTier string      `json:"fishTier"`
	Phases   []RackPhase `json:"phases"`
	PhaseIdx int         `json:"phaseIdx"`
	ReadyAt  time.Time   `json:"readyAt"` // estimated wall time all phases finish
	Done     bool        `json:"done"`
	Premium  bool        `json:"premium,omitempty"`
}

// View is the authoritative player projection returned by GET /api/house and by
// every write command.
type View struct {
	OwnerID      int64          `json:"ownerId,string"`
	Level        int            `json:"level"`
	Endless      int            `json:"endless"`
	Prestige     int            `json:"prestige"`
	Pets         Pets           `json:"pets"`
	Roles        Roles          `json:"roles"`
	Stationed    []string       `json:"stationed"`
	Slots        int            `json:"slots"`
	RackSlots    []RackSlotView `json:"rackSlots"`
	RackCapacity int            `json:"rackCapacity"` // total rack positions at current level
	NextCost     *Cost          `json:"nextCost,omitempty"`
	RenovateCost *Cost          `json:"renovateCost,omitempty"`
	Steal        StealView      `json:"steal"`
}

// extras is the part of a house row without a dedicated column. It lives in the
// row's state jsonb, mirroring how gear keeps its whole state in one column.
type extras struct {
	Stationed []string   `json:"stationed,omitempty"`
	Frozen    bool       `json:"frozen,omitempty"`
	Heat      int        `json:"heat,omitempty"`
	Racks     []RackSlot `json:"racks,omitempty"`
}

// row is a full house row: the columns plus the jsonb extras.
type row struct {
	Level    int
	Endless  int
	Prestige int
	Pets     Pets
	Roles    Roles
	extras
}

func (r row) state() State {
	return State{Level: r.Level, Endless: r.Endless, Pets: r.Pets, Roles: r.Roles}
}

func (r *row) normalize() {
	if r.Level < 1 {
		r.Level = 1
	}
	if r.Endless < 0 {
		r.Endless = 0
	}
	if r.Prestige < 0 {
		r.Prestige = 0
	}
	if r.Pets == nil {
		r.Pets = Pets{}
	}
	if r.Roles == nil {
		r.Roles = Roles{}
	}
	kept := r.Stationed[:0]
	for _, id := range r.Stationed {
		if id != "" {
			kept = append(kept, id)
		}
	}
	r.Stationed = kept
}

// Read mirrors gear.Read: a missing row reads as a level 1 house with nothing
// invested. The returned maps are always writable.
func Read(ctx context.Context, q assets.SQL, owner int64) (State, error) {
	r, err := readRow(ctx, q, owner)
	if err != nil {
		return State{}, err
	}
	return r.state(), nil
}

// Write mirrors gear.Write: it upserts the player-owned part of the row and
// leaves settled_at/enabled_at/prestige/state untouched on an existing row, so
// writing progress can never rewind or grant accrual.
func Write(ctx context.Context, t *assets.Transaction, owner int64, v State) error {
	return writeState(ctx, t.SQL(), owner, v)
}

func readRow(ctx context.Context, q assets.SQL, owner int64) (row, error) {
	r := row{Level: 1, Pets: Pets{}, Roles: Roles{}}
	var pets, roles, extra []byte
	err := q.QueryRow(ctx, `SELECT level,endless,prestige,pets,roles,state FROM fishing.house_state WHERE owner_id=$1`, owner).
		Scan(&r.Level, &r.Endless, &r.Prestige, &pets, &roles, &extra)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if len(pets) > 0 {
		if err = json.Unmarshal(pets, &r.Pets); err != nil {
			return r, err
		}
	}
	if len(roles) > 0 {
		if err = json.Unmarshal(roles, &r.Roles); err != nil {
			return r, err
		}
	}
	if len(extra) > 0 {
		if err = json.Unmarshal(extra, &r.extras); err != nil {
			return r, err
		}
	}
	r.normalize()
	return r, nil
}

// writeRow persists the whole row. settled_at/enabled_at are only initialised on
// insert: an existing row keeps its accrual window.
func writeRow(ctx context.Context, t *assets.Transaction, owner int64, r row) error {
	r.normalize()
	pets, err := json.Marshal(r.Pets)
	if err != nil {
		return err
	}
	roles, err := json.Marshal(r.Roles)
	if err != nil {
		return err
	}
	extra, err := json.Marshal(r.extras)
	if err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `INSERT INTO fishing.house_state(owner_id,level,endless,prestige,pets,roles,state)
VALUES($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT(owner_id) DO UPDATE SET level=excluded.level,endless=excluded.endless,prestige=excluded.prestige,pets=excluded.pets,roles=excluded.roles,state=excluded.state`,
		owner, r.Level, r.Endless, r.Prestige, pets, roles, extra)
	return err
}

// writeState is the narrow upsert used by Write (it never touches the extras).
func writeState(ctx context.Context, q assets.SQL, owner int64, v State) error {
	r := row{Level: v.Level, Endless: v.Endless, Pets: v.Pets, Roles: v.Roles}
	r.normalize()
	pets, err := json.Marshal(r.Pets)
	if err != nil {
		return err
	}
	roles, err := json.Marshal(r.Roles)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO fishing.house_state(owner_id,level,endless,pets,roles)
VALUES($1,$2,$3,$4,$5)
ON CONFLICT(owner_id) DO UPDATE SET level=excluded.level,endless=excluded.endless,pets=excluded.pets,roles=excluded.roles`,
		owner, r.Level, r.Endless, pets, roles)
	return err
}
