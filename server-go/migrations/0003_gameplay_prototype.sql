-- Internal prototype only: no legacy save import or public gameplay API.
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close'));
ALTER TABLE fishing.player_state ADD COLUMN loadout_rev bigint NOT NULL DEFAULT 0 CHECK (loadout_rev>=0);

CREATE TABLE fishing.fishing_rules (
    version text PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 128),
    interval_ms integer NOT NULL CHECK (interval_ms BETWEEN 100 AND 60000),
    bite_ppm integer NOT NULL CHECK (bite_ppm BETWEEN 0 AND 1000000),
    item_id text NOT NULL,
    kind text NOT NULL DEFAULT 'fish' CHECK (kind='fish'),
    tier text NOT NULL CHECK (tier IN ('normal','large','giant')),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    sale_price bigint NOT NULL CHECK (sale_price BETWEEN 0 AND 90071992547409),
    FOREIGN KEY(item_id,kind) REFERENCES fishing.item_definitions(id,kind)
);
CREATE FUNCTION fishing.immutable_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published fishing rules are immutable'; END $$;
CREATE TRIGGER immutable_rule BEFORE UPDATE OR DELETE ON fishing.fishing_rules FOR EACH ROW EXECUTE FUNCTION fishing.immutable_rule();

CREATE TABLE fishing.fishing_connections (
    owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
    generation bigint NOT NULL CHECK (generation>0),
    expires_at timestamptz NOT NULL
);
CREATE TABLE fishing.fishing_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id bigint NOT NULL UNIQUE REFERENCES fishing.player_state(account_id),
    generation bigint NOT NULL CHECK (generation>0),
    next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq>0),
    connection_generation bigint NOT NULL CHECK (connection_generation>0),
    state text NOT NULL CHECK (state IN ('active','paused','stopped')),
    rule_version text NOT NULL REFERENCES fishing.fishing_rules(version),
    private_seed bytea NOT NULL CHECK (octet_length(private_seed)=32),
    random_version text NOT NULL DEFAULT 'hmac-sha256-v1' CHECK (random_version='hmac-sha256-v1'),
    loadout_rev bigint NOT NULL CHECK (loadout_rev>=0),
    auto_sell boolean NOT NULL,
    due_at timestamptz NOT NULL
);
CREATE INDEX fishing_due ON fishing.fishing_sessions(due_at,id) WHERE state='active';
CREATE TABLE fishing.fishing_settlements (
    session_id bigint NOT NULL REFERENCES fishing.fishing_sessions(id),
    generation bigint NOT NULL,
    seq bigint NOT NULL,
    operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
    rule_version text NOT NULL REFERENCES fishing.fishing_rules(version),
    random_version text NOT NULL CHECK (random_version='hmac-sha256-v1'),
    caught integer NOT NULL CHECK (caught BETWEEN 0 AND 100),
    sold integer NOT NULL CHECK (sold BETWEEN 0 AND caught),
    coins bigint NOT NULL CHECK (coins BETWEEN 0 AND 9007199254740991),
    due_at timestamptz NOT NULL,
    settled_at timestamptz NOT NULL,
    PRIMARY KEY(session_id,generation,seq)
);

-- A prototype listing sells one indivisible lot, at an immutable total price.
CREATE TABLE fishing.market_listings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
    item_id text REFERENCES fishing.item_definitions(id),
    tier text CHECK (tier IN ('normal','large','giant')),
    quantity bigint,
    equipment_id bigint REFERENCES fishing.equipment_instances(id),
    price bigint NOT NULL CHECK (price BETWEEN 1 AND 9007199254740991),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','sold','cancelled','expired')),
    buyer_id bigint REFERENCES fishing.player_state(account_id),
    created_operation bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
    closed_operation bigint UNIQUE REFERENCES fishing.asset_operations(id),
    expires_at timestamptz NOT NULL,
    CHECK ((item_id IS NOT NULL AND tier IS NOT NULL AND quantity IS NOT NULL AND quantity BETWEEN 1 AND 9007199254740991 AND equipment_id IS NULL) OR (item_id IS NULL AND tier IS NULL AND quantity IS NULL AND equipment_id IS NOT NULL)),
    CHECK ((state='sold' AND buyer_id IS NOT NULL AND buyer_id<>seller_id) OR (state<>'sold' AND buyer_id IS NULL)),
    CHECK ((state='open')=(closed_operation IS NULL))
);
CREATE INDEX market_open ON fishing.market_listings(id) WHERE state='open';
CREATE INDEX market_expiry ON fishing.market_listings(expires_at,id) WHERE state='open';
CREATE UNIQUE INDEX market_equipment ON fishing.market_listings(equipment_id) WHERE state='open' AND equipment_id IS NOT NULL;
CREATE FUNCTION fishing.guard_listing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.seller_id,NEW.item_id,NEW.tier,NEW.quantity,NEW.equipment_id,NEW.price,NEW.created_operation,NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.seller_id,OLD.item_id,OLD.tier,OLD.quantity,OLD.equipment_id,OLD.price,OLD.created_operation,OLD.expires_at)
       OR OLD.state<>'open' OR NEW.state='open' THEN
       RAISE EXCEPTION 'listing identity and terminal state are immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_listing BEFORE UPDATE ON fishing.market_listings FOR EACH ROW EXECUTE FUNCTION fishing.guard_listing();

ALTER TABLE fishing.equipment_instances DROP CONSTRAINT equipment_instances_lifecycle_check;
ALTER TABLE fishing.equipment_instances ADD CHECK(lifecycle IN ('available','consumed','escrow'));
ALTER TABLE fishing.equipment_instances ADD COLUMN escrow_listing_id bigint REFERENCES fishing.market_listings(id);
ALTER TABLE fishing.equipment_instances ADD CHECK ((lifecycle='escrow')=(escrow_listing_id IS NOT NULL));
ALTER TABLE fishing.equipment_entries DROP CONSTRAINT equipment_entries_action_check;
ALTER TABLE fishing.equipment_entries ADD CHECK(action IN ('create','consume','transfer','hold','release'));
