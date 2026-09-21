package gateway

import "context"

type legacyPartyPush struct {
	api             *API
	owner, revision int64
	seeded          bool
}

func (p *legacyPartyPush) init(ctx context.Context) map[string]any {
	var revision int64
	if p.api.pool.QueryRow(ctx, `SELECT revision FROM fishing.party_guard WHERE singleton`).Scan(&revision) == nil {
		p.revision, p.seeded = revision, true
	}
	return nil
}
func (p *legacyPartyPush) poll(ctx context.Context) []string {
	if !p.seeded {
		p.init(ctx)
		return nil
	}
	rows, err := p.api.pool.Query(ctx, `SELECT revision,action FROM fishing.party_events WHERE revision>$1 AND $2::bigint=ANY(recipients) ORDER BY revision LIMIT 16`, p.revision, p.owner)
	if err != nil {
		return nil
	}
	defer rows.Close()
	frames := []string{}
	next := p.revision
	for rows.Next() {
		var action string
		if err := rows.Scan(&next, &action); err != nil {
			return nil
		}
		if action == "admin_disband" {
			frames = append(frames, legacyFrame(map[string]any{"type": "notice", "msg": "🛡 管理员解散了编队。"}))
		}
	}
	if rows.Err() != nil {
		return nil
	}
	p.revision = next
	return frames
}
