-- Each bounded segment commits its effects and private continuation together.
-- A candidate may span transactions without rerolling or truncating its tree.
CREATE TABLE fishing.catch_continuations (
 session_id bigint NOT NULL REFERENCES fishing.native_fishing_sessions(id),
 generation bigint NOT NULL, seq bigint NOT NULL,
 part bigint NOT NULL CHECK(part>=0), done boolean NOT NULL,
 draws bigint NOT NULL CHECK(draws>=0), caught bigint NOT NULL CHECK(caught>=0),
 walk jsonb NOT NULL,
 PRIMARY KEY(session_id,generation,seq)
);
CREATE TABLE fishing.catch_segments (
 session_id bigint NOT NULL, generation bigint NOT NULL, seq bigint NOT NULL,
 part bigint NOT NULL CHECK(part>=0),
 operation_id bigint NOT NULL UNIQUE REFERENCES fishing.asset_operations(id),
 caught bigint NOT NULL CHECK(caught>=0),
 PRIMARY KEY(session_id,generation,seq,part),
 FOREIGN KEY(session_id,generation,seq) REFERENCES fishing.catch_continuations(session_id,generation,seq)
);
CREATE TRIGGER immutable_catch_segment BEFORE UPDATE OR DELETE ON fishing.catch_segments FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
ALTER TABLE fishing.sea_players ADD COLUMN xp_notified boolean NOT NULL DEFAULT false;
