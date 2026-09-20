ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim'));
CREATE TABLE fishing.sea_quest_boards (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 day date NOT NULL,
 selected jsonb NOT NULL CHECK(jsonb_typeof(selected)='array' AND jsonb_array_length(selected)<=3)
);
CREATE TABLE fishing.sea_quest_roots (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 private_seed bytea NOT NULL CHECK(octet_length(private_seed)=32)
);
