ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft'));
CREATE TABLE fishing.sea_players (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 level integer NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 5),
 experience bigint NOT NULL DEFAULT 0 CHECK(experience BETWEEN 0 AND 9007199254740991),
 charts bigint NOT NULL DEFAULT 0 CHECK(charts BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE fishing.sea_progress_entries (
 operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 field text NOT NULL CHECK(field IN ('level','experience','charts')),
 delta bigint NOT NULL CHECK(delta<>0),
 after_value bigint NOT NULL CHECK(after_value>=0),
 PRIMARY KEY(operation_id,owner_id,field)
);
CREATE TRIGGER immutable_sea_progress BEFORE UPDATE OR DELETE ON fishing.sea_progress_entries FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
