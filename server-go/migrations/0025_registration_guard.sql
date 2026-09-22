-- Public registration abuse controls survive process restarts and competing
-- gateways. Source and username rate keys store SHA-256 digests only.
CREATE TABLE fishing.registration_limits (
 key_hash bytea PRIMARY KEY CHECK(octet_length(key_hash)=32),
 window_start timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 attempts bigint NOT NULL CHECK(attempts>0)
);
CREATE INDEX registration_limits_expiry ON fishing.registration_limits(expires_at);
CREATE TABLE fishing.registration_challenges (
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{40}$'),
 prefix text NOT NULL CHECK(prefix ~ '^[0-9a-f]{32}$'),
 source_hash bytea NOT NULL CHECK(octet_length(source_hash)=32),
 expires_at timestamptz NOT NULL
);
CREATE INDEX registration_challenges_expiry ON fishing.registration_challenges(expires_at);
