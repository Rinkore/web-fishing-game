package assets

import "context"

func (t *Transaction) ConsumeEquipment(ctx context.Context, owner, id int64) error {
	if !t.players[owner] || id < 1 {
		return ErrInvalid
	}
	return t.u.moveEquipment(ctx, owner, 0, id)
}
func (t *Transaction) CreateEquipment(ctx context.Context, owner int64, spec EquipmentSpec) (int64, error) {
	if !t.players[owner] || !validKey(spec.DefinitionID) || !partValid(spec.Part) || len(spec.Attributes) > 32768 {
		return 0, ErrInvalid
	}
	attrs, err := canonicalAttributes(spec.Attributes)
	if err != nil {
		return 0, ErrInvalid
	}
	spec.Attributes = attrs
	return t.u.createEquipment(ctx, owner, spec)
}
