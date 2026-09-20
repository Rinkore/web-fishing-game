-- Formal defaults use their own sessions; prototype rows cannot enter this path.
CREATE TABLE fishing.native_fishing_sessions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_id bigint NOT NULL UNIQUE REFERENCES fishing.player_state(account_id),
 generation bigint NOT NULL CHECK(generation>0),
 next_seq bigint NOT NULL DEFAULT 1 CHECK(next_seq>0),
 connection_generation bigint NOT NULL CHECK(connection_generation>0),
 state text NOT NULL CHECK(state IN ('active','paused','stopped')),
 ground_id text NOT NULL,spot_id text NOT NULL,
 rule_version text NOT NULL,
 private_seed bytea NOT NULL CHECK(octet_length(private_seed)=32),
 loadout_rev bigint NOT NULL,
 due_at timestamptz NOT NULL
);
CREATE INDEX native_fishing_due ON fishing.native_fishing_sessions(due_at,id) WHERE state='active';
CREATE TABLE fishing.native_fishing_settlements (
 session_id bigint NOT NULL REFERENCES fishing.native_fishing_sessions(id),
 generation bigint NOT NULL,seq bigint NOT NULL,
 operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 rule_version text NOT NULL,draws bigint NOT NULL CHECK(draws>=0),
 caught bigint NOT NULL CHECK(caught>=0),due_at timestamptz NOT NULL,settled_at timestamptz NOT NULL,
 PRIMARY KEY(session_id,generation,seq)
);
CREATE TABLE fishing.catch_records (
 operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
 ordinal bigint NOT NULL CHECK(ordinal>0),
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 item_id text NOT NULL REFERENCES fishing.item_definitions(id),
 size double precision NOT NULL CHECK(size>0 AND size<'Infinity'::float8),
 ground_id text NOT NULL,spot_id text NOT NULL,caught_at timestamptz NOT NULL,
 PRIMARY KEY(operation_id,ordinal)
);
CREATE INDEX catch_records_big ON fishing.catch_records(item_id,size DESC,caught_at,owner_id);
CREATE INDEX catch_records_small ON fishing.catch_records(item_id,size,caught_at,owner_id);
CREATE INDEX catch_records_owner ON fishing.catch_records(owner_id,item_id,size);
CREATE TRIGGER immutable_catch_record BEFORE UPDATE OR DELETE ON fishing.catch_records FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
ALTER TABLE fishing.player_codex ADD COLUMN min_size double precision;
ALTER TABLE fishing.player_codex ADD COLUMN max_size double precision;
ALTER TABLE fishing.player_codex ADD COLUMN best_tier text NOT NULL DEFAULT 'normal' CHECK(best_tier IN ('normal','large','giant'));
ALTER TABLE fishing.player_state ADD COLUMN catch_count bigint NOT NULL DEFAULT 0 CHECK(catch_count BETWEEN 0 AND 9007199254740991);
ALTER TABLE fishing.player_codex ADD CHECK(min_size IS NULL OR (min_size>0 AND min_size<'Infinity'::float8));
ALTER TABLE fishing.player_codex ADD CHECK(max_size IS NULL OR (max_size>=min_size AND max_size<'Infinity'::float8));
