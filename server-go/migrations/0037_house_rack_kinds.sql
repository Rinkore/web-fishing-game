-- v0.25.0 replaced the passive yard payout with explicit rack commands, but the
-- asset_operations kind allowlist was never extended to match. Every INSERT from
-- the rack therefore tripped asset_operations_kind_check (23514). Because a check
-- violation is not a retryable serialization failure, assets.execute() swallowed
-- it into ErrUnavailable and the gateway answered
-- 503 {"error":"retry_same_request"} for both rack writes.
--
-- This is why only the rack was broken: house_upgrade / house_pet / house_role /
-- house_steal / house_prestige / house_settle were already in the list, so the
-- rest of the house kept working while 投入晒架 and 收取全部完成批次 always failed.
--
-- Additive only: the previous allowlist is preserved verbatim, two kinds appended.
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CONSTRAINT asset_operations_kind_check CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant','expedition_start','expedition_claim','sea_set_redeem','sea_set_target','mail_send','mail_read','mail_claim','house_collect','house_upgrade','house_pet','house_role','house_steal','house_prestige','house_settle','fish_breeding','house_place','house_collect_rack'));
