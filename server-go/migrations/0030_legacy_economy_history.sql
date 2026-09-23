-- Immutable pre-Go economic history. These records are display/audit history,
-- never an instruction to apply a balance or inventory change again.
CREATE TABLE fishing.legacy_economy_history (
    kind text NOT NULL CHECK(kind IN ('price','shop','market','audit')),
    item_id text NOT NULL,
    ordinal bigint NOT NULL CHECK(ordinal >= 0),
    payload jsonb NOT NULL,
    occurred_at timestamptz,
    PRIMARY KEY(kind,item_id,ordinal)
);
CREATE INDEX legacy_economy_history_recent ON fishing.legacy_economy_history(kind,occurred_at DESC,ordinal DESC);
CREATE TRIGGER immutable_legacy_economy_history BEFORE UPDATE OR DELETE ON fishing.legacy_economy_history FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
