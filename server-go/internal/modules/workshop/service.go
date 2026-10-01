package workshop

import (
	"context"
	"encoding/json"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/randomintent"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool    *pgxpool.Pool
	assets  *assets.Service
	catalog *rules.Catalog
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service { return &Service{pool, assets.New(pool), c} }

func (s *Service) ruleVersion() string { return s.catalog.Version + ":" + s.catalog.SourceSHA256 }
func (s *Service) intent(ctx context.Context, actor int64, key string, input any) ([]byte, error) {
	return randomintent.Load(ctx, s.pool, actor, key, input)
}
func (s *Service) create(ctx context.Context, t *assets.Transaction, owner int64, signature string) (int64, error) {
	base, _, _, ok := s.catalog.Instance(signature)
	if !ok {
		return 0, assets.ErrInvalid
	}
	attrs, _ := json.Marshal(map[string]any{"signature": signature})
	return t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: base.ID, Part: base.Part, Attributes: attrs})
}
