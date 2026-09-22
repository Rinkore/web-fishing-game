ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open'));
CREATE TABLE fishing.random_intents (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 input_hash bytea NOT NULL CHECK(octet_length(input_hash)=32),
 private_seed bytea NOT NULL CHECK(octet_length(private_seed)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_key)
);
CREATE TABLE fishing.chest_pity (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 chest_id text NOT NULL REFERENCES fishing.item_definitions(id),
 misses bigint NOT NULL DEFAULT 0 CHECK(misses>=0),
 PRIMARY KEY(owner_id,chest_id)
);
CREATE TABLE fishing.player_codex (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 item_id text NOT NULL REFERENCES fishing.item_definitions(id),
 count bigint NOT NULL CHECK(count>0),
 first_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,item_id)
);
