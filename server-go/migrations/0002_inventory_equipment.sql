-- Append-only: preserve the published 0001 checksum and existing coin history.
ALTER TABLE fishing.asset_operations DROP CONSTRAINT asset_operations_kind_check;
ALTER TABLE fishing.asset_operations ADD CHECK (kind IN ('coin_transfer','asset_change','asset_exchange','rod_change'));
ALTER TABLE fishing.outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE fishing.outbox_events ADD CHECK (event_type IN ('coins_transferred','assets_changed'));
ALTER TABLE fishing.player_state ADD COLUMN rod_capacity smallint NOT NULL DEFAULT 1 CHECK (rod_capacity BETWEEN 1 AND 8);

-- Catalog owns definitions. This slice reads them; only fixtures seed them.
CREATE TABLE fishing.item_definitions (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    kind text NOT NULL CHECK (kind IN ('fish','material','chest','equipment')),
    part text,
    CHECK ((kind='equipment' AND part IS NOT NULL AND part IN ('rod','line','hook','bait','reel','accessory','charm')) OR (kind<>'equipment' AND part IS NULL)),
    UNIQUE (id,kind), UNIQUE (id,kind,part)
);

-- Each fish is counted once. Legacy total = normal + large + giant;
-- legacy bigfish.L/G are the latter two rows, never extra copies of fish.
CREATE TABLE fishing.inventory_stacks (
    owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
    item_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fish','material','chest')),
    tier text NOT NULL CHECK (tier IN ('normal','large','giant')),
    quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
    CHECK (kind='fish' OR tier='normal'),
    PRIMARY KEY (owner_id,item_id,tier),
    FOREIGN KEY (item_id,kind) REFERENCES fishing.item_definitions(id,kind)
);

CREATE TABLE fishing.equipment_instances (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
    definition_id text NOT NULL,
    kind text NOT NULL DEFAULT 'equipment' CHECK (kind='equipment'),
    part text NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes)='object'),
    lifecycle text NOT NULL DEFAULT 'available' CHECK (lifecycle IN ('available','consumed')),
    created_operation bigint NOT NULL REFERENCES fishing.asset_operations(id),
    FOREIGN KEY (definition_id,kind,part) REFERENCES fishing.item_definitions(id,kind,part),
    UNIQUE (owner_id,id,part,lifecycle)
);
CREATE INDEX equipment_owner ON fishing.equipment_instances(owner_id,id) WHERE lifecycle='available';

-- -1 is the unsaved assembly. An active saved slot is a pointer to the same
-- binding rows, not a second copy of its equipment. Empty slots are reusable.
CREATE TABLE fishing.rod_loadouts (
    owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
    slot smallint NOT NULL CHECK (slot BETWEEN -1 AND 7),
    name text NOT NULL DEFAULT '' CHECK (length(name)<=20),
    active boolean NOT NULL DEFAULT false,
    PRIMARY KEY (owner_id,slot)
);
CREATE UNIQUE INDEX rod_active_owner ON fishing.rod_loadouts(owner_id) WHERE active;
CREATE TABLE fishing.rod_components (
    owner_id bigint NOT NULL,
    slot smallint NOT NULL,
    part text NOT NULL,
    equipment_id bigint NOT NULL UNIQUE,
    lifecycle text NOT NULL DEFAULT 'available' CHECK (lifecycle='available'),
    PRIMARY KEY (owner_id,slot,part),
    FOREIGN KEY (owner_id,slot) REFERENCES fishing.rod_loadouts(owner_id,slot),
    FOREIGN KEY (owner_id,equipment_id,part,lifecycle) REFERENCES fishing.equipment_instances(owner_id,id,part,lifecycle)
);

CREATE TABLE fishing.inventory_entries (
    operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
    owner_id bigint NOT NULL,
    item_id text NOT NULL,
    tier text NOT NULL,
    delta bigint NOT NULL CHECK (delta<>0 AND delta BETWEEN -9007199254740991 AND 9007199254740991),
    quantity_after bigint NOT NULL CHECK (quantity_after BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (operation_id,owner_id,item_id,tier),
    FOREIGN KEY (owner_id,item_id,tier) REFERENCES fishing.inventory_stacks(owner_id,item_id,tier)
);
CREATE INDEX inventory_entries_owner ON fishing.inventory_entries(owner_id,operation_id);

CREATE TABLE fishing.equipment_entries (
    operation_id bigint NOT NULL REFERENCES fishing.asset_operations(id),
    equipment_id bigint NOT NULL REFERENCES fishing.equipment_instances(id),
    previous_owner bigint REFERENCES fishing.accounts(id),
    next_owner bigint REFERENCES fishing.accounts(id),
    action text NOT NULL CHECK (action IN ('create','consume','transfer')),
    PRIMARY KEY (operation_id,equipment_id)
);
CREATE TABLE fishing.rod_entries (
    operation_id bigint PRIMARY KEY REFERENCES fishing.asset_operations(id),
    owner_id bigint NOT NULL REFERENCES fishing.accounts(id),
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL
);
