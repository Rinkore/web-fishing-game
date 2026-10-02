ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant','expedition_start','expedition_claim','sea_set_redeem','sea_set_target','mail_send','mail_read','mail_claim','house_collect','house_upgrade','house_pet','house_role','house_steal','house_prestige','house_settle'));

-- The fish house keeps its own row per owner: the level of the main track, the
-- endless renovation counter and the two growth lines (companions and roles).
-- settled_at is the only clock the payout math trusts; enabled_at marks when the
-- yard started accruing so a brand-new owner cannot claim a full pond.
CREATE TABLE fishing.house_state (
 owner_id    bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 level       integer NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
 endless     integer NOT NULL DEFAULT 0 CHECK (endless >= 0),
 prestige    integer NOT NULL DEFAULT 0 CHECK (prestige >= 0),
 pets        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pets)='object'),
 roles       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(roles)='object'),
 settled_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
 enabled_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
 state       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state)='object')
);

-- Every successful steal lands here, keyed by the asset operation that produced
-- it. The unique index turns "one pick per friend per day" into a database
-- invariant, and the immutable trigger keeps the history append-only.
CREATE TABLE fishing.house_steals (
 id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 actor_id   bigint NOT NULL REFERENCES fishing.player_state(account_id),
 target_id  bigint NOT NULL REFERENCES fishing.player_state(account_id),
 day_bucket bigint NOT NULL,
 coins      bigint NOT NULL CHECK (coins > 0),
 items      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(items)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (actor_id <> target_id)
);
CREATE UNIQUE INDEX house_steals_pair_day ON fishing.house_steals(actor_id,target_id,day_bucket);
CREATE TRIGGER immutable_house_steals BEFORE UPDATE OR DELETE ON fishing.house_steals
 FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
