-- Read-only deployment diagnostics. No account identifiers or credentials.
BEGIN TRANSACTION READ ONLY;

-- Zero definitions after schema migration explains first-catch award failures.
SELECT count(*) AS item_definition_count FROM fishing.item_definitions;
SELECT kind, count(*) AS definitions FROM fishing.item_definitions GROUP BY kind ORDER BY kind;

-- NULL release_id is valid: the application uses built-in default rules.
SELECT release_id FROM fishing.catalog_head WHERE singleton;

SELECT state, count(*) AS sessions,
       count(*) FILTER (WHERE due_at < clock_timestamp()) AS overdue,
       count(*) FILTER (WHERE next_seq = 1) AS still_first_cycle
FROM fishing.native_fishing_sessions GROUP BY state ORDER BY state;

SELECT count(*) AS settled_cycles, COALESCE(sum(caught),0) AS caught,
       max(settled_at) AS last_settlement
FROM fishing.native_fishing_settlements;

SELECT count(*) AS connections,
       count(*) FILTER (WHERE expires_at > clock_timestamp()) AS live_connections
FROM fishing.fishing_connections;

COMMIT;
