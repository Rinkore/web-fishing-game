CREATE TABLE fishing.gateway_streams (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 stream_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,stream_id)
);
CREATE INDEX gateway_stream_expiry ON fishing.gateway_streams(expires_at);
ALTER TABLE fishing.native_fishing_sessions ADD COLUMN resume_enabled boolean NOT NULL DEFAULT false;
