-- Owner-bound breeding individuals. Releasing a fish only makes it inactive;
-- the row and its genome remain so descendants never lose their ancestry.
CREATE TABLE fishing.breeding_fish (
 id         bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 owner_id   bigint NOT NULL REFERENCES fishing.player_state(account_id),
 generation integer NOT NULL CHECK (generation BETWEEN 0 AND 3),
 active     boolean NOT NULL DEFAULT true,
 genome     jsonb NOT NULL CHECK (jsonb_typeof(genome)='object'),
 born_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((genome->>'generation')::integer=generation),
 CHECK ((genome->>'id')::bigint=id),
 CHECK ((genome->>'active')::boolean=active)
);
CREATE INDEX breeding_fish_owner_history ON fishing.breeding_fish(owner_id,born_at,id);
CREATE INDEX breeding_fish_owner_active ON fishing.breeding_fish(owner_id,id) WHERE active;

ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CONSTRAINT asset_operations_kind_check CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant','expedition_start','expedition_claim','sea_set_redeem','sea_set_target','mail_send','mail_read','mail_claim','house_collect','house_upgrade','house_pet','house_role','house_steal','house_prestige','house_settle','fish_breeding'));
