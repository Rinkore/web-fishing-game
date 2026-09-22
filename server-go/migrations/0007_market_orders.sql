-- Formal unit-price orders coexist with immutable synthetic prototype lots.
ALTER TABLE fishing.player_state ADD COLUMN listing_capacity integer NOT NULL DEFAULT 40 CHECK(listing_capacity BETWEEN 0 AND 10000);
CREATE TABLE fishing.market_orders (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 seller_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 kind text NOT NULL CHECK(kind IN ('stack','equipment','rod')),
 item_id text REFERENCES fishing.item_definitions(id),
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 9007199254740991),
 remaining bigint NOT NULL CHECK(remaining>=0 AND remaining<=quantity),
 unit_price bigint NOT NULL CHECK(unit_price BETWEEN 1 AND 9007199254740991),
 rod_name text NOT NULL DEFAULT '' CHECK(length(rod_name)<=20),
 hours integer NOT NULL CHECK(hours IN (6,12,24)),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','sold','cancelled','expired')),
 created_operation bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 closed_operation bigint UNIQUE REFERENCES fishing.asset_operations(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK((kind='stack' AND item_id IS NOT NULL) OR (kind<>'stack' AND item_id IS NULL AND quantity=1)),
 CHECK((state='open')=(remaining>0)),
 CHECK((state='open')=(closed_operation IS NULL))
);
CREATE INDEX market_orders_open ON fishing.market_orders(id) WHERE state='open';
CREATE INDEX market_orders_seller ON fishing.market_orders(seller_id,id);
CREATE INDEX market_orders_expiry ON fishing.market_orders(expires_at,id) WHERE state='open';
CREATE TABLE fishing.market_order_equipment (
 order_id bigint NOT NULL REFERENCES fishing.market_orders(id),
 equipment_id bigint NOT NULL REFERENCES fishing.equipment_instances(id),
 part text NOT NULL,
 PRIMARY KEY(order_id,equipment_id),UNIQUE(order_id,part)
);
ALTER TABLE fishing.equipment_instances ADD COLUMN escrow_order_id bigint REFERENCES fishing.market_orders(id);
ALTER TABLE fishing.equipment_instances DROP CONSTRAINT equipment_instances_check;
ALTER TABLE fishing.equipment_instances ADD CONSTRAINT equipment_escrow_owner CHECK(
 (lifecycle='escrow' AND num_nonnulls(escrow_listing_id,escrow_order_id)=1)
 OR (lifecycle<>'escrow' AND escrow_listing_id IS NULL AND escrow_order_id IS NULL));
CREATE TABLE fishing.market_fills (
 operation_id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 order_id bigint NOT NULL REFERENCES fishing.market_orders(id),
 buyer_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 quantity bigint NOT NULL CHECK(quantity>0),
 total bigint NOT NULL CHECK(total BETWEEN 1 AND 9007199254740991),
 tax bigint NOT NULL CHECK(tax>=0 AND tax<=total),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX market_fills_buyer ON fishing.market_fills(buyer_id,operation_id);
CREATE TABLE fishing.market_charges (
 operation_id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
 order_id bigint NOT NULL REFERENCES fishing.market_orders(id),
 account_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 kind text NOT NULL CHECK(kind IN ('listing','tax')),
 amount bigint NOT NULL CHECK(amount BETWEEN 0 AND 9007199254740991)
);
CREATE FUNCTION fishing.guard_market_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.seller_id,NEW.kind,NEW.item_id,NEW.quantity,NEW.unit_price,NEW.rod_name,NEW.hours,NEW.created_operation,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.seller_id,OLD.kind,OLD.item_id,OLD.quantity,OLD.unit_price,OLD.rod_name,OLD.hours,OLD.created_operation,OLD.created_at,OLD.expires_at)
 OR OLD.state<>'open' OR NEW.remaining>OLD.remaining THEN RAISE EXCEPTION 'market order identity or terminal state is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_market_order BEFORE UPDATE ON fishing.market_orders FOR EACH ROW EXECUTE FUNCTION fishing.guard_market_order();
