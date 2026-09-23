ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant','expedition_start','expedition_claim','sea_set_redeem','sea_set_target'));

CREATE TABLE fishing.sea_captains (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 marks bigint NOT NULL DEFAULT 0 CHECK (marks BETWEEN 0 AND 9007199254740991),
 voyages integer NOT NULL DEFAULT 0 CHECK (voyages >= 0),
 successes integer NOT NULL DEFAULT 0 CHECK (successes >= 0),
 starter integer NOT NULL DEFAULT 0 CHECK (starter BETWEEN 0 AND 2),
 first_clears jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(first_clears)='object'),
 heat integer NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 30),
 clues integer NOT NULL DEFAULT 0 CHECK (clues BETWEEN 0 AND 60),
 samples integer NOT NULL DEFAULT 0 CHECK (samples BETWEEN 0 AND 30),
 target text NOT NULL DEFAULT '',
 tracking integer NOT NULL DEFAULT 0 CHECK (tracking BETWEEN 0 AND 3)
);
CREATE TABLE fishing.sea_expeditions (
 id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 route text NOT NULL,
 hours integer NOT NULL CHECK (hours IN (2,8,12)),
 started_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL CHECK (ends_at>started_at),
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
 reward jsonb NOT NULL CHECK (jsonb_typeof(reward)='object'),
 claimed_at timestamptz,
 claim_operation bigint UNIQUE REFERENCES fishing.asset_operations(id),
 CHECK ((claimed_at IS NULL)=(claim_operation IS NULL))
);
CREATE UNIQUE INDEX sea_expeditions_one_active ON fishing.sea_expeditions(owner_id) WHERE claimed_at IS NULL;
CREATE INDEX sea_expeditions_history ON fishing.sea_expeditions(owner_id,id DESC);
