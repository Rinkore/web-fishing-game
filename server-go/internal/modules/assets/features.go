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
	case "chart_craft", "ship_upgrade", "sea_voyage", "sea_anchor", "expedition_start", "sea_set_redeem", "sea_set_target":
		return "sea"
	// 渔屋复用「角色」页入口 id，因此门禁也用 character.* 子开关：
	// 带点的键会被 legacy_config_push 原样下发到玩家端（顶层键不会）。
	case "house_collect":
		return "character.collect"
	case "house_upgrade", "house_prestige":
		return "character.upgrade"
	case "house_pet":
		return "character.pet"
	case "house_role":
		return "character.role"
	case "house_steal":
		return "character.steal"
	case "fish_breeding":
		return "character.breeding"
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

// Feature commands take a shared lock on the singleton publication row before
// taking any player locks. Feature publication takes the same row exclusively
// (see command.go), so a close cannot miss a command that has already passed
// its gate or allow a new command to insert state after the close commits.
func lockFeatureBoundary(ctx context.Context, tx pgx.Tx, kind string) error {
	manual := kind == "fishing_start" || kind == "fishing_stop" || kind == "fishing_settle" || kind == "party_change"
	if kind != "feature_publish" && FeatureOf(kind) == "" && !manual {
		return nil
	}
	lock := "FOR SHARE"
	if kind == "feature_publish" {
		lock = "FOR UPDATE"
	}
	_, err := tx.Exec(ctx, "SELECT singleton FROM fishing.feature_head WHERE singleton "+lock)
	return err
}
