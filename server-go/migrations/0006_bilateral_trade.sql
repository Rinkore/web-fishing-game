ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration','trade_invite','trade_respond','trade_offer','trade_confirm','trade_cancel','trade_expire'));
CREATE TABLE fishing.trades (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 a_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 b_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','accepted','done','cancelled','expired')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 a_offer jsonb NOT NULL DEFAULT '{"stacks":[],"equipment":[]}' CHECK(jsonb_typeof(a_offer)='object'),
 b_offer jsonb NOT NULL DEFAULT '{"stacks":[],"equipment":[]}' CHECK(jsonb_typeof(b_offer)='object'),
 a_confirm boolean NOT NULL DEFAULT false,
 b_confirm boolean NOT NULL DEFAULT false,
 cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 created_operation bigint NOT NULL REFERENCES fishing.asset_operations(id),
 settled_operation bigint UNIQUE REFERENCES fishing.asset_operations(id),
 CHECK(a_id<>b_id),
 CHECK((state='done')=(settled_operation IS NOT NULL))
);
CREATE UNIQUE INDEX trade_pair_active ON fishing.trades(LEAST(a_id,b_id),GREATEST(a_id,b_id)) WHERE state IN ('invited','accepted');
CREATE INDEX trades_due ON fishing.trades(expires_at,id) WHERE state IN ('invited','accepted');
CREATE FUNCTION fishing.trade_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.a_id,NEW.b_id,NEW.created_operation,NEW.expires_at) IS DISTINCT FROM (OLD.a_id,OLD.b_id,OLD.created_operation,OLD.expires_at)
 OR OLD.state IN ('done','cancelled','expired') THEN RAISE EXCEPTION 'trade identity or closed state is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trade_identity_immutable BEFORE UPDATE ON fishing.trades FOR EACH ROW EXECUTE FUNCTION fishing.trade_identity_immutable();
