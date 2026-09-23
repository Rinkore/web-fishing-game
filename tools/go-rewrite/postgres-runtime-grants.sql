\set ON_ERROR_STOP on

-- Explicit runtime surface. Do not replace these grants with ALL ON SCHEMA or
-- ALL ON TABLES: operator audit, MFA enrollment, and migration metadata are
-- intentionally outside the process trust boundary.
REVOKE CREATE ON SCHEMA public FROM fishing_runtime;
REVOKE CREATE ON SCHEMA fishing FROM fishing_runtime;
REVOKE CREATE ON DATABASE fishing_test FROM fishing_runtime;
GRANT USAGE ON SCHEMA fishing TO fishing_runtime;
GRANT SELECT ON public.fishing_schema_migrations TO fishing_runtime;
GRANT SELECT ON public.fishing_schema_migrations TO fishing_backup;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fishing TO fishing_backup;

GRANT SELECT, INSERT ON fishing.accounts TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.player_state, fishing.wallets TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.command_results TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.asset_operations, fishing.asset_entries, fishing.outbox_events TO fishing_runtime;
GRANT SELECT ON fishing.item_definitions, fishing.fishing_rules TO fishing_runtime;
GRANT SELECT ON fishing.legacy_economy_history TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.inventory_stacks, fishing.equipment_instances, fishing.rod_loadouts TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.rod_components TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.inventory_entries, fishing.equipment_entries, fishing.rod_entries TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.fishing_connections, fishing.fishing_sessions, fishing.market_listings TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.fishing_settlements TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.identities TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.auth_sessions, fishing.auth_attempts TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.player_events TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.trades TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.gateway_streams TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.catalog_releases TO fishing_runtime;
GRANT SELECT, UPDATE ON fishing.catalog_head TO fishing_runtime;
GRANT INSERT ON fishing.item_definitions TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.catch_continuations TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.catch_segments TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.native_fishing_sessions TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.native_fishing_settlements, fishing.catch_records TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.catch_record_hides TO fishing_runtime;
GRANT SELECT, UPDATE ON fishing.catch_record_moderation_guard TO fishing_runtime;
GRANT SELECT, UPDATE ON fishing.party_guard TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.parties TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.party_members, fishing.party_invites TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.party_events TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.sea_quest_boards, fishing.sea_zones TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.sea_quest_roots, fishing.sea_progress_entries TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.sea_players TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.feature_releases TO fishing_runtime;
GRANT SELECT, UPDATE ON fishing.feature_head TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.economy_prices, fishing.autosell_settings TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.shop_sales TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.friend_relations, fishing.mall_purchases TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.random_intents TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.chest_pity, fishing.player_codex TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.market_orders TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.market_order_equipment, fishing.market_fills, fishing.market_charges TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE ON fishing.subscription_settings, fishing.feedback_cooldowns, fishing.operator_settings TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.feedback_entries TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.admin_audit TO fishing_runtime;
GRANT SELECT, INSERT, DELETE ON fishing.activity_samples TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.registration_limits, fishing.registration_challenges TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.wiki_state, fishing.wiki_guides, fishing.wiki_sections, fishing.wiki_updates, fishing.wiki_revisions TO fishing_runtime;
GRANT SELECT, UPDATE ON fishing.banner_state TO fishing_runtime;
GRANT SELECT, INSERT ON fishing.banner_events TO fishing_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fishing.banner_watchers TO fishing_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA fishing TO fishing_runtime;

-- MFA enrollment and its append-only audit trail are never reachable from the
-- runtime process, even if a future migration adds broad table permissions.
REVOKE ALL ON fishing.operator_audit FROM fishing_runtime;
REVOKE ALL ON fishing.operator_audit FROM PUBLIC;
REVOKE ALL ON public.fishing_schema_migrations FROM PUBLIC;

-- pg_read_all_data is a predefined role, but role membership does not grant
-- USAGE on schemas created after the membership was established. The backup
-- principal is read-only and receives an explicit snapshot surface here.
GRANT USAGE ON SCHEMA fishing TO fishing_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA fishing TO fishing_backup;
GRANT SELECT ON public.fishing_schema_migrations TO fishing_backup;
