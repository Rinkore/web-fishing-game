CREATE SCHEMA fishing;

-- Identity owns account IDs. Login/credentials are a separate future slice.
CREATE TABLE fishing.accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE fishing.player_state (
    account_id bigint PRIMARY KEY REFERENCES fishing.accounts(id),
    assets_rev bigint NOT NULL DEFAULT 0 CHECK (assets_rev >= 0)
);

CREATE TABLE fishing.wallets (
    account_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
    coins bigint NOT NULL DEFAULT 0 CHECK (coins BETWEEN 0 AND 9007199254740991)
);

-- Stable request identity and its original result live as long as business
-- deduplication is needed. No TTL/cleanup policy is implemented in this slice.
CREATE TABLE fishing.command_results (
    actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
    request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, request_key)
);

CREATE TABLE fishing.asset_operations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id bigint NOT NULL,
    request_key text NOT NULL,
    kind text NOT NULL CHECK (kind = 'coin_transfer'),
    rule_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor_id, request_key),
    FOREIGN KEY (actor_id, request_key) REFERENCES fishing.command_results(actor_id, request_key)
);

CREATE TABLE fishing.asset_entries (
    operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
    account_id bigint NOT NULL REFERENCES fishing.wallets(account_id),
    delta bigint NOT NULL CHECK (delta <> 0 AND delta BETWEEN -9007199254740991 AND 9007199254740991),
    balance_after bigint NOT NULL CHECK (balance_after BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (operation_id, account_id)
);
CREATE INDEX asset_entries_account ON fishing.asset_entries(account_id, operation_id);

-- One committed event per operation; delivery is implemented in a later slice.
CREATE TABLE fishing.outbox_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
    event_type text NOT NULL CHECK (event_type = 'coins_transferred'),
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz
);
CREATE INDEX outbox_pending ON fishing.outbox_events(id) WHERE delivered_at IS NULL;
