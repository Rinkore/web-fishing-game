ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire','workshop_smelt','workshop_recast','workshop_forge','chest_craft','chest_open','mall_buy','friend_change','shop_sell','autosell_config','autosell_run','feature_publish','ship_upgrade','chart_craft','sea_voyage','sea_anchor','sea_quests_refresh','sea_quest_claim','party_change','catalog_publish','feedback_skip','admin_grant','expedition_start','expedition_claim','sea_set_redeem','sea_set_target','mail_send','mail_read','mail_claim'));

CREATE TABLE fishing.mail_messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_id bigint NOT NULL REFERENCES fishing.accounts(id),
    sender_name text NOT NULL DEFAULT '系统' CHECK (length(sender_name) <= 40),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
    body text NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    claimed_at timestamptz
);
CREATE INDEX mail_recipient ON fishing.mail_messages(recipient_id, id DESC);
CREATE TABLE fishing.mail_attachments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mail_id bigint NOT NULL REFERENCES fishing.mail_messages(id) ON DELETE CASCADE,
    item_id text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 128),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
    tier text NOT NULL DEFAULT 'normal' CHECK (tier IN ('normal','large','giant')),
    custom_name text NOT NULL DEFAULT '' CHECK (length(custom_name) <= 80),
    custom_description text NOT NULL DEFAULT '' CHECK (length(custom_description) <= 500)
);
CREATE INDEX mail_attachment_message ON fishing.mail_attachments(mail_id);
