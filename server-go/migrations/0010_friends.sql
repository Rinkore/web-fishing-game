ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change'));
CREATE TABLE fishing.friend_relations (
 a_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 b_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 requester_id bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('none','pending','accepted')),
 updated_operation bigint NOT NULL REFERENCES fishing.asset_operations(id),
 PRIMARY KEY(a_id,b_id),
 CHECK(a_id < b_id AND requester_id IN (a_id,b_id))
);
CREATE INDEX friend_relations_b ON fishing.friend_relations(b_id,a_id) WHERE state <> 'none';
CREATE INDEX friend_requests_out ON fishing.friend_relations(requester_id) WHERE state='pending';
