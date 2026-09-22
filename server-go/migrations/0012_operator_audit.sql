CREATE TABLE fishing.operator_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 action text NOT NULL CHECK(action IN ('admin_mfa_provision','admin_revoke')),
 account_id bigint NOT NULL REFERENCES fishing.accounts(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION fishing.immutable_operator_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'operator audit is append only'; END $$;
CREATE TRIGGER immutable_operator_audit BEFORE UPDATE OR DELETE ON fishing.operator_audit FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
