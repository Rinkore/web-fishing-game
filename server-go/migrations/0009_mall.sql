ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy'));
CREATE TABLE fishing.mall_purchases (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 item_id text NOT NULL REFERENCES fishing.item_definitions(id),
 cycle_key date NOT NULL,
 quantity bigint NOT NULL CHECK(quantity > 0 AND quantity <= 9007199254740991),
 PRIMARY KEY(owner_id,item_id)
);
