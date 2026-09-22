ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change'));
-- Low-frequency topology writes serialize independently of asset/economy work.
CREATE TABLE fishing.party_guard(singleton boolean PRIMARY KEY CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
INSERT INTO fishing.party_guard(singleton) VALUES(true);
CREATE TABLE fishing.parties (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 -- Leader handoff must not acquire another player's guard through an FK.
 -- Membership already proves player_state exists; account identities are immutable.
 leader_id bigint NOT NULL REFERENCES fishing.accounts(id),
 active boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1,
 created_operation bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id)
);
CREATE TABLE fishing.party_members (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 party_id bigint NOT NULL REFERENCES fishing.parties(id),
 joined_operation bigint NOT NULL REFERENCES fishing.asset_operations(id),
 joined_revision bigint NOT NULL CHECK(joined_revision>0)
);
CREATE INDEX party_members_party ON fishing.party_members(party_id,joined_revision,owner_id);
CREATE TABLE fishing.party_invites (
 target_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 party_id bigint NOT NULL REFERENCES fishing.parties(id),
 operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
 issued_revision bigint NOT NULL CHECK(issued_revision>0)
);
CREATE INDEX party_invites_party ON fishing.party_invites(party_id,issued_revision);
CREATE TABLE fishing.party_events (
 revision bigint NOT NULL UNIQUE CHECK(revision>0),
 operation_id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 recipients bigint[] NOT NULL,
 action text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_party_event BEFORE UPDATE OR DELETE ON fishing.party_events FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
