CREATE TABLE fishing.wiki_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 official_revision bigint NOT NULL DEFAULT 0 CHECK(official_revision>=0),
 user_revision bigint NOT NULL DEFAULT 0 CHECK(user_revision>=0),
 official_updated_at text NOT NULL DEFAULT ''
);
INSERT INTO fishing.wiki_state(singleton) VALUES(true);
CREATE TABLE fishing.wiki_guides (
 id text PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('official','user')),
 status text NOT NULL CHECK(status IN ('published','pending','approved','rejected')),
 title text NOT NULL, category text NOT NULL, summary text NOT NULL,
 tags jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(tags)='array'),
 aliases jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(aliases)='array'),
 owner_id bigint REFERENCES fishing.accounts(id), author_name text NOT NULL DEFAULT '',
 submitted_at timestamptz, reviewed_at timestamptz, reviewed_by text NOT NULL DEFAULT '', review_note text NOT NULL DEFAULT '',
 deleted_at timestamptz, deleted_by text NOT NULL DEFAULT '', delete_reason text NOT NULL DEFAULT '',
 updated_label text NOT NULL DEFAULT '', revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='official' AND owner_id IS NULL AND status='published') OR (kind='user' AND owner_id IS NOT NULL AND status<>'published'))
);
CREATE INDEX wiki_guides_public ON fishing.wiki_guides(kind,status,sort_order,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX wiki_guides_owner ON fishing.wiki_guides(owner_id,submitted_at) WHERE deleted_at IS NULL;
CREATE TABLE fishing.wiki_sections (
 guide_id text NOT NULL REFERENCES fishing.wiki_guides(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal>=0), heading text NOT NULL,
 type text NOT NULL CHECK(type IN ('p','note','ol','ul')),
 body text NOT NULL DEFAULT '', items jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(items)='array'),
 PRIMARY KEY(guide_id,ordinal)
);
CREATE TABLE fishing.wiki_updates (
 ordinal integer PRIMARY KEY CHECK(ordinal>=0), day text NOT NULL, title text NOT NULL, summary text NOT NULL
);
CREATE TABLE fishing.wiki_revisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 guide_id text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 action text NOT NULL, actor_id bigint REFERENCES fishing.accounts(id), actor_name text NOT NULL,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX wiki_revisions_guide ON fishing.wiki_revisions(guide_id,id DESC);
CREATE TRIGGER immutable_wiki_revision BEFORE UPDATE OR DELETE ON fishing.wiki_revisions
 FOR EACH ROW EXECUTE FUNCTION fishing.immutable_operator_audit();
