ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor'));
CREATE TABLE fishing.sea_zones (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 id text NOT NULL,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 expires_at timestamptz NOT NULL,
 created_operation bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 anchors integer NOT NULL DEFAULT 0 CHECK(anchors>=0),
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX sea_zones_expiry ON fishing.sea_zones(expires_at);
