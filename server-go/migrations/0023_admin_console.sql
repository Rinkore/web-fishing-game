-- Operator console (/api/admin/*) storage.
--
-- Bans gain a deadline: identities.banned stays the single "currently banned"
-- flag every module already checks, ban_until adds the deadline and a worker
-- clears the flag when it passes. A retired account (console delete) releases
-- its username instead of removing rows: the asset ledger, catch records and
-- the append-only operator audit all reference the account, so a real purge
-- would have to tear the ledger apart.
ALTER TABLE fishing.identities
 ADD COLUMN ban_until timestamptz,
 ADD COLUMN ban_reason text NOT NULL DEFAULT '' CHECK(length(ban_reason)<=60),
 ADD COLUMN ban_by text NOT NULL DEFAULT '',
 ADD COLUMN ban_at timestamptz,
 ADD COLUMN retired boolean NOT NULL DEFAULT false;

-- Login lockouts are keyed by a hash only; the console needs the account name
-- behind a locked key. The original also locked per source IP, which the Go
-- gateway does not track at login time.
ALTER TABLE fishing.auth_attempts
 ADD COLUMN realm text NOT NULL DEFAULT '',
 ADD COLUMN username text NOT NULL DEFAULT '';

-- Moderation fields for the operator review surface. reward keeps the legacy
-- {coins,note,at,by,total} object so a second reward accumulates the total.
ALTER TABLE fishing.feedback_entries
 ADD COLUMN status_at timestamptz,
 ADD COLUMN status_by text NOT NULL DEFAULT '',
 ADD COLUMN reward jsonb;

-- Operator settings the console edits (feedback cooldown and skip cost). The
-- original kept them in config.json next to the world configuration.
CREATE TABLE fishing.operator_settings (
 key text PRIMARY KEY,
 value jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Minute samples behind the console heat map. The original kept 24 hours of
-- minute samples plus hourly aggregates in memory and persisted them; here the
-- samples are the durable record and the report aggregates them in SQL.
CREATE TABLE fishing.activity_samples (
 sampled_at timestamptz PRIMARY KEY,
 online integer NOT NULL CHECK(online>=0),
 fishing integer NOT NULL CHECK(fishing>=0),
 listings integer NOT NULL CHECK(listings>=0),
 trades integer NOT NULL CHECK(trades>=0),
 players integer NOT NULL CHECK(players>=0),
 grounds jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(grounds)='object'),
 spots jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(spots)='object')
);

-- Console audit. This is deliberately a separate table from
-- fishing.operator_audit: the runtime role must not be able to write the
-- enrollment trail (that denial is what stops a compromised application
-- process from provisioning itself an administrator), while the HTTP console
-- has to record its own privileged actions. Both trails are append only.
CREATE TABLE fishing.admin_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
 actor_name text NOT NULL DEFAULT '',
 account_id bigint REFERENCES fishing.accounts(id),
 action text NOT NULL CHECK(action<>'' AND length(action)<=80),
 target text NOT NULL DEFAULT '',
 detail text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_audit_recent ON fishing.admin_audit(created_at DESC,id DESC);
CREATE TRIGGER immutable_admin_audit BEFORE UPDATE OR DELETE ON fishing.admin_audit FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();

ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant'));
