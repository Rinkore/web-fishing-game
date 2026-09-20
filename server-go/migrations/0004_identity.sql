-- Credentials and sessions are separate from assets. No legacy data import.
CREATE TABLE fishing.identities (
 account_id bigint PRIMARY KEY REFERENCES fishing.accounts(id),
 username text NOT NULL UNIQUE CHECK(username ~ '^[a-z0-9_]{3,20}$'),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 40),
 qq text NOT NULL CHECK(qq ~ '^[0-9]{5,12}$'),
 password_hash text NOT NULL,
 legacy_salt text NOT NULL DEFAULT '',
 banned boolean NOT NULL DEFAULT false,
 admin boolean NOT NULL DEFAULT false,
 mfa_secret bytea,
 mfa_last_step bigint NOT NULL DEFAULT -1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE fishing.auth_sessions (
 token_hash bytea PRIMARY KEY CHECK(octet_length(token_hash)=32),
 account_id bigint NOT NULL REFERENCES fishing.identities(account_id),
 admin boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_sessions_account ON fishing.auth_sessions(account_id);
CREATE INDEX auth_sessions_expiry ON fishing.auth_sessions(expires_at);
CREATE TABLE fishing.auth_attempts (
 key_hash bytea PRIMARY KEY CHECK(octet_length(key_hash)=32),
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
 window_start timestamptz NOT NULL DEFAULT clock_timestamp(),
 locked_until timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change','fishing_connection','fishing_start','fishing_stop','fishing_settle','market_list','market_buy','market_close','registration'));
