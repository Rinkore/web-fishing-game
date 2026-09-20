package sea

import (
	"context"
	"encoding/json"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// SharedZone is a map projection. It does not expose the private catch pool.
type SharedZone struct {
	OwnerID   int64        `json:"ownerId,string"`
	OwnerName string       `json:"ownerName"`
	GroundID  string       `json:"groundId"`
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Mood      string       `json:"mood"`
	Expire    int64        `json:"expire"`
	Spots     []SharedSpot `json:"spots"`
}
type SharedSpot struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Buffs []rules.SeaBuff `json:"buffs"`
}

// MemberZones is shared by the party and sea views, using the caller's snapshot.
// Membership is always checked in SQL; clients cannot nominate another owner.
func MemberZones(ctx context.Context, q assets.SQL, viewer int64) ([]SharedZone, error) {
	rows, err := q.Query(ctx, `SELECT z.owner_id,COALESCE(i.display_name,''),z.data FROM fishing.party_members mine JOIN fishing.parties p ON p.id=mine.party_id AND p.active JOIN fishing.party_members member ON member.party_id=p.id AND member.owner_id<>mine.owner_id JOIN fishing.sea_zones z ON z.owner_id=member.owner_id AND z.expires_at>statement_timestamp() LEFT JOIN fishing.identities i ON i.account_id=z.owner_id WHERE mine.owner_id=$1 ORDER BY member.joined_revision,member.owner_id,z.created_operation`, viewer)
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer rows.Close()
	out := []SharedZone{}
	for rows.Next() {
		var z SharedZone
		var data []byte
		var full rules.SeaZone
		if rows.Scan(&z.OwnerID, &z.OwnerName, &data) != nil || json.Unmarshal(data, &full) != nil {
			return nil, assets.ErrUnavailable
		}
		z.ID, z.Name, z.Mood, z.Expire = full.ID, full.Name, full.Mood, full.Expire
		z.GroundID = "sea:" + strconv.FormatInt(z.OwnerID, 10) + ":" + z.ID
		z.Spots = []SharedSpot{}
		for _, spot := range full.Spots {
			z.Spots = append(z.Spots, SharedSpot{spot.ID, spot.Name, spot.Buffs})
		}
		out = append(out, z)
	}
	if rows.Err() != nil {
		return nil, assets.ErrUnavailable
	}
	return out, nil
}

func (s *Service) Overview(ctx context.Context, owner int64) (map[string]any, error) {
	if owner < 1 {
		return nil, assets.ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, assets.ErrUnavailable
	}
	defer tx.Rollback(ctx)
	v, err := readState(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	zones, err := readZones(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	shared, err := MemberZones(ctx, tx, owner)
	if err != nil {
		return nil, err
	}
	return map[string]any{"state": v, "zones": zones, "memberZones": shared}, nil
}
