package migration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// SQLite is exported by the offline preflight using a read-only SQLite
// connection, integrity_check, and foreign_key_check. No source code is run.
func ImportRealWiki(ctx context.Context, rc *RealContext) error    { return rwWiki(ctx, rc, false) }
func ReconcileRealWiki(ctx context.Context, rc *RealContext) error { return rwWiki(ctx, rc, true) }

func rwWikiJSON(v any, array bool) ([]byte, error) {
	if array && v == nil {
		return []byte("[]"), nil
	}
	var x any
	if err := json.Unmarshal([]byte(rwString(v)), &x); err != nil {
		return nil, errors.New("wiki embedded JSON invalid")
	}
	if array {
		if x == nil {
			return []byte("[]"), nil
		}
		if _, ok := x.([]any); !ok {
			return nil, errors.New("wiki embedded array invalid")
		}
	} else {
		if _, ok := x.(map[string]any); !ok {
			return nil, errors.New("wiki embedded object invalid")
		}
	}
	return rwJSON(x), nil
}
func rwWikiTime(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	if s, ok := v.(string); ok && s == "" {
		return nil, nil
	}
	if _, ok := v.(json.Number); ok {
		if rwInt(v) <= 0 {
			return nil, errors.New("wiki timestamp invalid")
		}
		return rwTime(v), nil
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		if t, e := time.Parse(layout, rwString(v)); e == nil {
			return t, nil
		}
	}
	return nil, errors.New("wiki timestamp invalid")
}
func rwWiki(ctx context.Context, rc *RealContext, verify bool) error {
	m, err := rwRead(rc.Root, "wiki-export.json")
	if err != nil {
		return err
	}
	if rwInt(m["format"]) != 1 || rwString(m["integrity"]) != "ok" || rwInt(m["foreignKeyViolations"]) != 0 {
		return errors.New("wiki integrity gate not passed")
	}
	tables := rwMap(m["tables"])
	if tables == nil {
		return errors.New("wiki export tables missing")
	}
	meta := map[string]string{}
	for _, v := range rwList(tables["wiki_meta"]) {
		r := rwMap(v)
		meta[rwString(r["key"])] = rwString(r["value"])
	}
	official, e1 := strconv.ParseInt(meta["official_revision"], 10, 64)
	user, e2 := strconv.ParseInt(meta["user_revision"], 10, 64)
	if e1 != nil || e2 != nil || official < 0 || user < 0 {
		return errors.New("wiki revision invalid")
	}
	updated := ""
	for i, v := range rwList(tables["guides"]) {
		r := rwMap(v)
		tags, e := rwWikiJSON(r["tags_json"], true)
		if e != nil {
			return e
		}
		aliases, e := rwWikiJSON(r["aliases_json"], true)
		if e != nil {
			return e
		}
		var owner any
		if rwString(r["kind"]) == "user" {
			n := rwID(rc, r["author_key"])
			if n == 0 {
				return fmt.Errorf("wiki guide %d owner unresolved", i)
			}
			owner = n
		}
		submitted, e := rwWikiTime(r["submitted_at"])
		if e != nil {
			return e
		}
		reviewed, e := rwWikiTime(r["reviewed_at"])
		if e != nil {
			return e
		}
		deleted, e := rwWikiTime(r["deleted_at"])
		if e != nil {
			return e
		}
		created, e := rwWikiTime(r["created_at"])
		if e != nil || created == nil {
			return errors.New("wiki creation timestamp missing")
		}
		label := rwString(r["updated_at"])
		if rwString(r["kind"]) == "official" && label > updated {
			updated = label
		}
		if !verify {
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.wiki_guides(id,kind,status,title,category,summary,tags,aliases,owner_id,author_name,submitted_at,reviewed_at,reviewed_by,review_note,deleted_at,deleted_by,delete_reason,updated_label,revision,sort_order,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, r["id"], r["kind"], r["status"], r["title"], r["category"], r["summary"], tags, aliases, owner, rwString(r["author_name"]), submitted, reviewed, rwString(r["reviewed_by"]), rwString(r["review_note"]), deleted, rwString(r["deleted_by"]), rwString(r["delete_reason"]), label, rwInt(r["revision"]), rwInt(r["sort_order"]), created)
		} else {
			var tagsValue, aliasesValue any
			_ = json.Unmarshal(tags, &tagsValue)
			_ = json.Unmarshal(aliases, &aliasesValue)
			millis := func(t any) any {
				if t == nil {
					return nil
				}
				return t.(time.Time).UnixMilli()
			}
			want := map[string]any{"id": r["id"], "kind": r["kind"], "status": r["status"], "title": r["title"], "category": r["category"], "summary": r["summary"], "tags": tagsValue, "aliases": aliasesValue, "owner_id": owner, "author_name": rwString(r["author_name"]), "submitted_at": millis(submitted), "reviewed_at": millis(reviewed), "reviewed_by": rwString(r["reviewed_by"]), "review_note": rwString(r["review_note"]), "deleted_at": millis(deleted), "deleted_by": rwString(r["deleted_by"]), "delete_reason": rwString(r["delete_reason"]), "updated_label": label, "revision": r["revision"], "sort_order": r["sort_order"], "created_at": millis(created)}
			err = rwCheck(ctx, rc, `SELECT to_jsonb(g)-'submitted_at'-'reviewed_at'-'deleted_at'-'created_at'||jsonb_build_object('submitted_at',(extract(epoch FROM submitted_at)*1000)::bigint,'reviewed_at',(extract(epoch FROM reviewed_at)*1000)::bigint,'deleted_at',(extract(epoch FROM deleted_at)*1000)::bigint,'created_at',(extract(epoch FROM created_at)*1000)::bigint) FROM fishing.wiki_guides g WHERE id=$1`, want, r["id"])
		}
		if err != nil {
			return fmt.Errorf("wiki guide %d import/reconciliation failed", i)
		}
	}
	for i, v := range rwList(tables["guide_sections"]) {
		r := rwMap(v)
		items, e := rwWikiJSON(r["items_json"], true)
		if e != nil {
			return e
		}
		if !verify {
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.wiki_sections(guide_id,ordinal,heading,type,body,items) VALUES($1,$2,$3,$4,$5,$6)`, r["guide_id"], rwInt(r["ord"]), r["heading"], r["type"], rwString(r["text"]), items)
		} else {
			var parsed any
			_ = json.Unmarshal(items, &parsed)
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('guide_id',guide_id,'ordinal',ordinal,'heading',heading,'type',type,'body',body,'items',items) FROM fishing.wiki_sections WHERE guide_id=$1 AND ordinal=$2`, map[string]any{"guide_id": r["guide_id"], "ordinal": r["ord"], "heading": r["heading"], "type": r["type"], "body": rwString(r["text"]), "items": parsed}, r["guide_id"], rwInt(r["ord"]))
		}
		if err != nil {
			return fmt.Errorf("wiki section %d import/reconciliation failed", i)
		}
	}
	for i, v := range rwList(tables["updates"]) {
		r := rwMap(v)
		if !verify {
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.wiki_updates(ordinal,day,title,summary) VALUES($1,$2,$3,$4)`, rwInt(r["sort_order"]), r["date"], r["title"], r["summary"])
		} else {
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('day',day,'title',title,'summary',summary) FROM fishing.wiki_updates WHERE ordinal=$1`, map[string]any{"day": r["date"], "title": r["title"], "summary": r["summary"]}, rwInt(r["sort_order"]))
		}
		if err != nil {
			return fmt.Errorf("wiki update %d import/reconciliation failed", i)
		}
	}
	for i, v := range rwList(tables["guide_revisions"]) {
		r := rwMap(v)
		snapshot, e := rwWikiJSON(r["snapshot_json"], false)
		if e != nil {
			return e
		}
		created, e := rwWikiTime(r["created_at"])
		if e != nil || created == nil {
			return errors.New("wiki revision timestamp missing")
		}
		var actor any
		if n := rwID(rc, r["actor_key"]); n != 0 {
			actor = n
		} else if rwString(r["actor_key"]) != "" && rwString(r["action"]) != "import_official" {
			return fmt.Errorf("wiki revision %d actor unresolved", i)
		}
		key := fmt.Sprintf("migration:wiki-revision:%d", i)
		if !verify {
			var id int64
			err = rc.Tx.QueryRow(ctx, `INSERT INTO fishing.wiki_revisions(guide_id,revision,action,actor_id,actor_name,snapshot,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, r["guide_id"], rwInt(r["revision"]), r["action"], actor, rwString(r["actor_name"]), snapshot, created).Scan(&id)
			if err == nil {
				err = rwSetting(ctx, rc, key, id, false)
			}
		} else {
			var parsed any
			_ = json.Unmarshal(snapshot, &parsed)
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('guide_id',r.guide_id,'revision',r.revision,'action',r.action,'actor_id',r.actor_id,'actor_name',r.actor_name,'snapshot',r.snapshot,'created_at',(extract(epoch FROM r.created_at)*1000)::bigint) FROM fishing.wiki_revisions r JOIN fishing.operator_settings s ON r.id=(s.value#>>'{}')::bigint WHERE s.key=$1`, map[string]any{"guide_id": r["guide_id"], "revision": r["revision"], "action": r["action"], "actor_id": actor, "actor_name": rwString(r["actor_name"]), "snapshot": parsed, "created_at": created.(time.Time).UnixMilli()}, key)
		}
		if err != nil {
			return fmt.Errorf("wiki revision %d import/reconciliation failed", i)
		}
	}
	if !verify {
		_, err = rc.Tx.Exec(ctx, `UPDATE fishing.wiki_state SET official_revision=$1,user_revision=$2,official_updated_at=$3 WHERE singleton`, official, user, updated)
	} else {
		err = rwCheck(ctx, rc, `SELECT jsonb_build_object('official',official_revision,'user',user_revision,'updated',official_updated_at) FROM fishing.wiki_state WHERE singleton`, map[string]any{"official": official, "user": user, "updated": updated})
	}
	if err != nil {
		return errors.New("wiki state import/reconciliation failed")
	}
	// Preserve source-only SQLite metadata (update IDs, author keys and original
	// revision IDs) without exposing it through the public content endpoint.
	return rwSetting(ctx, rc, "migration:wiki-source", m, verify)
}
