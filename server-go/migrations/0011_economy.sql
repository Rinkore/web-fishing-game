ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run'));
CREATE TABLE fishing.economy_prices (
 item_id text PRIMARY KEY REFERENCES fishing.item_definitions(id),
 state jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(state)='object')
);
CREATE TABLE fishing.shop_sales (
 operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 item_id text NOT NULL REFERENCES fishing.item_definitions(id),
 tier text NOT NULL CHECK(tier IN ('normal','large','giant','equipment')),
 quantity bigint NOT NULL CHECK(quantity>0),
 unit bigint NOT NULL CHECK(unit>0),
 bonus bigint NOT NULL CHECK(bonus>=0),
 gain bigint NOT NULL CHECK(gain BETWEEN 1 AND 9007199254740991),
 automatic boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(operation_id,item_id,tier)
);
CREATE INDEX shop_sales_owner ON fishing.shop_sales(owner_id,operation_id);
CREATE INDEX shop_sales_item ON fishing.shop_sales(item_id,operation_id);
CREATE TABLE fishing.autosell_settings (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 include_tiers boolean NOT NULL DEFAULT false,
 rules jsonb NOT NULL CHECK(jsonb_typeof(rules)='object')
);
