CREATE TABLE fishing.catalog_releases (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
 digest text NOT NULL CHECK(length(digest)=64),
 rule_version text NOT NULL,
 catalog jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX catalog_version ON fishing.catalog_releases(rule_version);
CREATE TRIGGER immutable_catalog_release BEFORE UPDATE OR DELETE ON fishing.catalog_releases FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
CREATE TABLE fishing.catalog_head(singleton boolean PRIMARY KEY CHECK(singleton),release_id bigint REFERENCES fishing.catalog_releases(id));
INSERT INTO fishing.catalog_head VALUES(true,NULL);
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish'));
