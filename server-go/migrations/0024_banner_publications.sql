-- One serialized head gives commits and SSE cursors the same order.
CREATE TABLE fishing.banner_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 next_seq bigint NOT NULL DEFAULT 1 CHECK(next_seq>0),
 banners jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(banners)='array'),
 cfg jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(cfg)='object')
);
INSERT INTO fishing.banner_state(singleton) VALUES(true);
CREATE TABLE fishing.banner_events (
 revision bigint PRIMARY KEY CHECK(revision>0),
 frames jsonb NOT NULL CHECK(jsonb_typeof(frames)='array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_banner_event BEFORE UPDATE OR DELETE ON fishing.banner_events
 FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
CREATE TABLE fishing.banner_watchers (
 banner_id text NOT NULL,
 owner_id bigint NOT NULL REFERENCES fishing.accounts(id),
 last_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(banner_id,owner_id)
);
CREATE INDEX banner_watchers_recent ON fishing.banner_watchers(last_at);
