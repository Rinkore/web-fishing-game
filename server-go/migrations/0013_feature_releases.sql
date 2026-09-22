ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish'));
CREATE TABLE fishing.feature_releases (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
 schema_version integer NOT NULL CHECK(schema_version=1),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 flags jsonb NOT NULL CHECK(jsonb_typeof(flags)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fishing.feature_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 release_id bigint REFERENCES fishing.feature_releases(id)
);
INSERT INTO fishing.feature_head(singleton) VALUES(true);
CREATE TRIGGER immutable_feature_release BEFORE UPDATE OR DELETE ON fishing.feature_releases FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
