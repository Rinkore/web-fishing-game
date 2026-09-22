-- Administrator market supply uses the durable order model but marks orders
-- whose contents were created by the server. A bulk command may create many
-- orders under one asset operation, so the operation is no longer unique on
-- the order table (the command result remains the idempotency boundary).
ALTER TABLE fishing.market_orders
    DROP CONSTRAINT IF EXISTS market_orders_created_operation_key,
    ADD COLUMN source text NOT NULL DEFAULT 'player' CHECK(source IN ('player','admin')),
    ADD COLUMN supply_id text;

CREATE INDEX market_orders_supply ON fishing.market_orders(supply_id,id)
    WHERE source='admin' AND supply_id IS NOT NULL AND state='open';

CREATE OR REPLACE FUNCTION fishing.guard_market_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.seller_id,NEW.kind,NEW.item_id,NEW.quantity,NEW.unit_price,NEW.rod_name,NEW.hours,NEW.created_operation,NEW.created_at,NEW.expires_at,NEW.source,NEW.supply_id)
 IS DISTINCT FROM (OLD.seller_id,OLD.kind,OLD.item_id,OLD.quantity,OLD.unit_price,OLD.rod_name,OLD.hours,OLD.created_operation,OLD.created_at,OLD.expires_at,OLD.source,OLD.supply_id)
 OR OLD.state<>'open' OR NEW.remaining>OLD.remaining THEN RAISE EXCEPTION 'market order identity or terminal state is immutable'; END IF;
 RETURN NEW;
END $$;
