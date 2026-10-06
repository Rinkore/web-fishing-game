-- Aquaculture keeps individual genomes and ancestry in the breeding module.
CREATE TABLE fishing.fish_habitats (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 kind text NOT NULL CHECK (kind IN ('aquarium','freshwater','marine')),
 slot integer NOT NULL CHECK (slot BETWEEN 1 AND 2),
 capacity integer NOT NULL CHECK ((kind='aquarium' AND capacity=8) OR (kind='freshwater' AND capacity=12) OR (kind='marine' AND capacity=10)),
 cycle bigint NOT NULL DEFAULT 0 CHECK (cycle>=0),
 next_spawn_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,kind,slot), UNIQUE(id,owner_id)
);
ALTER TABLE fishing.breeding_fish ADD COLUMN habitat_id bigint;
ALTER TABLE fishing.breeding_fish ADD CONSTRAINT breeding_fish_habitat_owner
 FOREIGN KEY (habitat_id,owner_id) REFERENCES fishing.fish_habitats(id,owner_id);
CREATE INDEX breeding_fish_habitat ON fishing.breeding_fish(habitat_id,id) WHERE active;
CREATE INDEX fish_habitats_due ON fishing.fish_habitats(next_spawn_at,id);
