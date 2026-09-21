-- Operator record deletion is a durable projection change. The immutable
-- catch ledger stays intact so assets, settlements, and historical audit data
-- retain their original foreign-key relationships.
CREATE TABLE fishing.catch_record_moderation_guard (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO fishing.catch_record_moderation_guard(singleton) VALUES(true);

CREATE TABLE fishing.catch_record_hides (
 operation_id bigint NOT NULL,
 ordinal bigint NOT NULL,
 item_id text NOT NULL REFERENCES fishing.item_definitions(id),
 board_range text NOT NULL CHECK(board_range IN ('day','week','all','record')),
 board_kind text NOT NULL CHECK(board_kind IN ('big','small')),
 actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(operation_id,ordinal,board_range,board_kind),
 FOREIGN KEY(operation_id,ordinal) REFERENCES fishing.catch_records(operation_id,ordinal)
);
CREATE INDEX catch_record_hides_item ON fishing.catch_record_hides(item_id,board_range,board_kind);
CREATE TRIGGER immutable_catch_record_hide BEFORE UPDATE OR DELETE ON fishing.catch_record_hides FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
