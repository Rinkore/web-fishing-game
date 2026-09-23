CREATE TABLE fishing.gear_progress (
 owner_id bigint PRIMARY KEY REFERENCES fishing.player_state(account_id),
 state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(state)='object')
);

-- A bound upgrade must not leave its owner through a direct trade, auction,
-- complete-rod sale, or any future asset transfer path.
CREATE FUNCTION fishing.guard_bound_gear() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND COALESCE((OLD.attributes->>'bound')::boolean,false) THEN
  RAISE EXCEPTION 'bound_equipment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER equipment_bound_transfer BEFORE UPDATE OF owner_id ON fishing.equipment_instances
 FOR EACH ROW EXECUTE FUNCTION fishing.guard_bound_gear();
