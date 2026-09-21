-- Legacy notification and feedback storage. The original server kept both in
-- its runtime store; the Go side persists them so the contract survives a
-- restart. Feedback cooldown length and skip cost stay operator settings in the
-- original system and are not bridged yet, so the defaults live in the gateway.
CREATE TABLE fishing.subscription_settings (
 account_id bigint PRIMARY KEY REFERENCES fishing.identities(account_id),
 config jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fishing.feedback_entries (
 id text PRIMARY KEY,
 account_id bigint NOT NULL REFERENCES fishing.identities(account_id),
 actor_name text NOT NULL,
 kind text NOT NULL,
 body text NOT NULL,
 version text NOT NULL,
 status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX feedback_entry_owner ON fishing.feedback_entries(account_id,created_at DESC);
CREATE TABLE fishing.feedback_cooldowns (
 account_id bigint PRIMARY KEY REFERENCES fishing.identities(account_id),
 next_at timestamptz NOT NULL,
 last_at timestamptz NOT NULL
);
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip'));
