-- Per-player revision order is commit order because writers hold player guards.
-- Global sequence IDs alone cannot safely be used as an SSE resume cursor.
CREATE TABLE fishing.player_events (
 owner_id bigint NOT NULL REFERENCES fishing.player_state(account_id),
 revision bigint NOT NULL CHECK(revision>0),
 outbox_id bigint NOT NULL REFERENCES fishing.outbox_events(id),
 PRIMARY KEY(owner_id,revision),
 UNIQUE(owner_id,outbox_id)
);
