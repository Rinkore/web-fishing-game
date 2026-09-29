-- Remove the original G3 cap without changing immutable ancestry rows.
-- The JSON and column generations must still agree; bigint is a storage
-- boundary, not a gameplay generation limit.
DO $$
DECLARE old_check record;
BEGIN
 FOR old_check IN
  SELECT conname FROM pg_constraint
  WHERE conrelid = 'fishing.breeding_fish'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%generation%'
 LOOP
  EXECUTE format('ALTER TABLE fishing.breeding_fish DROP CONSTRAINT %I', old_check.conname);
 END LOOP;
END $$;

ALTER TABLE fishing.breeding_fish ALTER COLUMN generation TYPE bigint;
ALTER TABLE fishing.breeding_fish ADD CONSTRAINT breeding_fish_generation_nonnegative CHECK (generation >= 0);
ALTER TABLE fishing.breeding_fish ADD CONSTRAINT breeding_fish_genome_generation_match
 CHECK ((genome->>'generation')::bigint = generation);
