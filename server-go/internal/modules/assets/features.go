package assets

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// These gates cover implemented commands only. Expiry and cancellation remain
// available so closing a feature does not strand escrowed player property.
func FeatureOf(kind string) string {
	switch kind {
	case "market_list", "market_buy":
		return "market"
	case "trade_invite", "trade_respond", "trade_offer", "trade_confirm":
		return "trade"
	case "workshop_smelt", "workshop_forge", "workshop_recast":
		return "workshop"
	case "chest_craft", "chest_open":
		return "chest"
	case "mall_buy":
		return "mall"
	case "shop_sell":
		return "sell"
	case "autosell_run":
		return "autosell"
	case "friend_change":
		return "friends"
	case "chart_craft", "ship_upgrade", "sea_voyage", "sea_anchor":
		return "sea"
	}
	return ""
}
func featureAllowed(ctx context.Context, tx pgx.Tx, kind string) error {
	feature := FeatureOf(kind)
	if feature == "" {
		return nil
	}
	err := requireFeature(ctx, tx, feature)
	if err == Rejection("feature_disabled") && kind == "autosell_run" {
		return ErrDeferred
	}
	return err
}

// RequireFeature is used for commands whose action decides whether disabling
// a feature applies. The caller already holds its player guards and savepoint.
func (t *Transaction) RequireFeature(ctx context.Context, feature string) error {
	return requireFeature(ctx, t.u.tx, feature)
}

func requireFeature(ctx context.Context, tx pgx.Tx, feature string) error {
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE((r.flags->>$1)::boolean,true) AND CASE WHEN $1='autosell' THEN COALESCE((r.flags->>'sell')::boolean,true) ELSE true END FROM fishing.feature_head h LEFT JOIN fishing.feature_releases r ON r.id=h.release_id WHERE h.singleton`, feature).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return Rejection("feature_disabled")
	}
	return nil
}
