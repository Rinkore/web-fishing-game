-- Migration bookkeeping is deliberately separate from runtime business writes.
-- The importer records the exact source manifest and preserves every source
-- entity payload so an unexplained field can never disappear silently.
CREATE TABLE fishing.migration_runs (
    id uuid PRIMARY KEY,
    source_version text NOT NULL,
    snapshot_sha256 text NOT NULL CHECK(length(snapshot_sha256)=64),
    tool_version text NOT NULL,
    state text NOT NULL CHECK(state IN ('planned','running','failed','imported','reconciled','aborted')),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    error text NOT NULL DEFAULT '',
    UNIQUE(source_version,snapshot_sha256)
);

CREATE TABLE fishing.legacy_id_map (
    run_id uuid NOT NULL REFERENCES fishing.migration_runs(id) ON DELETE CASCADE,
    domain text NOT NULL,
    legacy_id text NOT NULL,
    new_id text NOT NULL,
    PRIMARY KEY(run_id,domain,legacy_id),
    UNIQUE(run_id,domain,new_id)
);

CREATE TABLE fishing.migration_entities (
    run_id uuid NOT NULL REFERENCES fishing.migration_runs(id) ON DELETE CASCADE,
    domain text NOT NULL,
    entity_key text NOT NULL,
    source_sha256 text NOT NULL CHECK(length(source_sha256)=64),
    payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
    status text NOT NULL CHECK(status IN ('staged','imported','reconciled','gap')),
    issue text NOT NULL DEFAULT '',
    PRIMARY KEY(run_id,domain,entity_key)
);

CREATE TABLE fishing.migration_gaps (
    run_id uuid NOT NULL REFERENCES fishing.migration_runs(id) ON DELETE CASCADE,
    domain text NOT NULL,
    entity_key text NOT NULL,
    code text NOT NULL,
    detail text NOT NULL,
    blocking boolean NOT NULL DEFAULT true,
    PRIMARY KEY(run_id,domain,entity_key,code)
);

CREATE INDEX migration_entities_status ON fishing.migration_entities(run_id,status,domain);
CREATE INDEX migration_gaps_blocking ON fishing.migration_gaps(run_id,blocking);
