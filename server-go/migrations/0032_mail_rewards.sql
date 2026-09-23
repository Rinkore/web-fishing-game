-- Keep the existing total inventory contract; bound quantities are disjoint
-- subsets of that total, never additional copies of an item.
ALTER TABLE fishing.inventory_stacks
 ADD COLUMN bound_quantity bigint NOT NULL DEFAULT 0,
 ADD COLUMN inherit_quantity bigint NOT NULL DEFAULT 0,
 ADD CHECK (0 <= inherit_quantity AND inherit_quantity <= bound_quantity AND bound_quantity <= quantity);
CREATE TABLE fishing.inventory_binding_entries (
 operation_id bigint NOT NULL,
 owner_id bigint NOT NULL,
 item_id text NOT NULL,
 tier text NOT NULL,
 bound_after bigint NOT NULL,
 inherit_after bigint NOT NULL,
 PRIMARY KEY(operation_id,owner_id,item_id,tier),
 FOREIGN KEY(operation_id,owner_id,item_id,tier) REFERENCES fishing.inventory_entries(operation_id,owner_id,item_id,tier)
);
ALTER TABLE fishing.equipment_instances
 ADD COLUMN reward_bound boolean NOT NULL DEFAULT false,
 ADD COLUMN bind_outputs boolean NOT NULL DEFAULT false,
 ADD CHECK (NOT bind_outputs OR reward_bound);

CREATE FUNCTION fishing.guard_reward_equipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.reward_bound AND (NEW.owner_id <> OLD.owner_id OR NEW.lifecycle='escrow') THEN
  RAISE EXCEPTION 'reward_bound';
 END IF;
 IF OLD.reward_bound AND NOT NEW.reward_bound THEN RAISE EXCEPTION 'reward_bound'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_equipment_guard BEFORE UPDATE ON fishing.equipment_instances
 FOR EACH ROW EXECUTE FUNCTION fishing.guard_reward_equipment();

CREATE TABLE fishing.player_activity (
 owner_id bigint NOT NULL REFERENCES fishing.accounts(id),
 kind text NOT NULL CHECK(kind IN ('login','active')),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,kind,at)
);
CREATE INDEX player_activity_range ON fishing.player_activity(kind,at,owner_id);
CREATE TABLE fishing.mail_tracking (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO fishing.mail_tracking DEFAULT VALUES;

CREATE TABLE fishing.mail_batches (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id bigint NOT NULL REFERENCES fishing.accounts(id),
 actor_name text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 payload jsonb NOT NULL,
 audience jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','preview','queued','paused','complete','revoked')),
 revision bigint NOT NULL DEFAULT 1,
 is_template boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 snapshot_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mail_batches_recent ON fishing.mail_batches(id DESC);
CREATE TABLE fishing.mail_recipients (
 batch_id bigint NOT NULL REFERENCES fishing.mail_batches(id),
 recipient_id bigint NOT NULL REFERENCES fishing.accounts(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','skipped','failed')),
 error text NOT NULL DEFAULT '',
 PRIMARY KEY(batch_id,recipient_id)
);
CREATE INDEX mail_recipients_work ON fishing.mail_recipients(batch_id,recipient_id) WHERE state='pending';
ALTER TABLE fishing.mail_messages
 ADD COLUMN batch_id bigint REFERENCES fishing.mail_batches(id),
 ADD COLUMN expires_at timestamptz,
 ADD COLUMN revoked_at timestamptz,
 ADD CONSTRAINT mail_batch_recipient UNIQUE(batch_id,recipient_id);
-- Existing attachments retain their historical policy. New sends set these
-- explicitly; no attempt is made to identify already-claimed legacy rewards.
ALTER TABLE fishing.mail_attachments
 ADD COLUMN reward_bound boolean NOT NULL DEFAULT false,
 ADD COLUMN bind_outputs boolean NOT NULL DEFAULT false;
