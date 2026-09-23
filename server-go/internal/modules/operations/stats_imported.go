package operations

// Imported hourly aggregates contain counts and sums, not invented minute
// observations. For hourly charts/heat maps they replace overlapping imported
// minute samples. New post-migration samples remain independently additive.
func statsPointSource(preferHours bool) string {
	if !preferHours {
		return `WITH points AS (SELECT sampled_at,1::bigint AS n,online::numeric AS osum,online AS omax,fishing::numeric AS fsum,listings::numeric AS lsum,trades::numeric AS trsum,players,grounds,spots FROM fishing.activity_samples) `
	}
	return `WITH imported AS (SELECT value FROM fishing.operator_settings WHERE key='migration:stats'),
 legacy_hours AS (SELECT h FROM imported CROSS JOIN LATERAL jsonb_array_elements(COALESCE(value->'statHour','[]'::jsonb)) h),
 import_end AS (SELECT max((m->>'t')::bigint) AS t FROM imported CROSS JOIN LATERAL jsonb_array_elements(COALESCE(value->'statMin','[]'::jsonb)) m),
 points AS (
 SELECT sampled_at,1::bigint AS n,online::numeric AS osum,online AS omax,fishing::numeric AS fsum,listings::numeric AS lsum,trades::numeric AS trsum,players,grounds,spots
 FROM fishing.activity_samples a WHERE NOT EXISTS (SELECT 1 FROM legacy_hours l,import_end e WHERE (l.h->>'t')::bigint= floor(extract(epoch FROM a.sampled_at)/3600)::bigint*3600000 AND extract(epoch FROM a.sampled_at)*1000<=e.t)
 UNION ALL SELECT to_timestamp((h->>'t')::double precision/1000), (h->>'n')::bigint,(h->>'oSum')::numeric,(h->>'oMax')::integer,(h->>'fSum')::numeric,(h->>'lSum')::numeric,(h->>'trSum')::numeric,(h->>'uLast')::integer,COALESCE(h->'gSum','{}'::jsonb),COALESCE(h->'sSum','{}'::jsonb) FROM legacy_hours WHERE (h->>'n')::bigint>0) `
}
