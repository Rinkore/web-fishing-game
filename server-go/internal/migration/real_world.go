package migration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Global legacy projections are retained separately from the immutable new
// catch ledger. Importing a leaderboard must never mint a catch or an asset.
const realRecordsKey = "migration:records"
const realStatsKey = "migration:stats"

func rwRead(root, name string) (map[string]any, error) {
	b, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return nil, fmt.Errorf("world source %s unavailable", name)
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var m map[string]any
	if d.Decode(&m) != nil || m == nil {
		return nil, fmt.Errorf("world source %s invalid", name)
	}
	return m, nil
}
func rwMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func rwList(v any) []any         { a, _ := v.([]any); return a }
func rwString(v any) string      { s, _ := v.(string); return s }
func rwInt(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		i, _ := n.Int64()
		return i
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}
func rwTime(v any) any {
	n := rwInt(v)
	if n <= 0 {
		return nil
	}
	return time.UnixMilli(n).UTC()
}
func rwJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func rwObject(v any) any {
	if v == nil {
		return map[string]any{}
	}
	return v
}
func rwArray(v any) any {
	if v == nil {
		return []any{}
	}
	return v
}
func rwID(rc *RealContext, value any) int64 {
	return rc.IDs[strings.ToLower(strings.TrimSpace(rwString(value)))]
}
func rwSetting(ctx context.Context, rc *RealContext, key string, value any, verify bool) error {
	if !verify {
		_, err := rc.Tx.Exec(ctx, `INSERT INTO fishing.operator_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, rwJSON(value))
		return err
	}
	return rwCheck(ctx, rc, `SELECT value FROM fishing.operator_settings WHERE key=$1`, value, key)
}
func rwCheck(ctx context.Context, rc *RealContext, sql string, want any, args ...any) error {
	var raw []byte
	if err := rc.Tx.QueryRow(ctx, sql, args...).Scan(&raw); err != nil {
		return errors.New("world reconciliation row unavailable")
	}
	var got, expected any
	if json.Unmarshal(raw, &got) != nil || json.Unmarshal(rwJSON(want), &expected) != nil || !reflect.DeepEqual(got, expected) {
		return errors.New("world field reconciliation differs")
	}
	return nil
}

func ImportRealWorld(ctx context.Context, rc *RealContext) error    { return rwWorld(ctx, rc, false) }
func ReconcileRealWorld(ctx context.Context, rc *RealContext) error { return rwWorld(ctx, rc, true) }
func rwWorld(ctx context.Context, rc *RealContext, verify bool) error {
	for _, step := range []struct {
		name string
		run  func(context.Context, *RealContext, bool) error
	}{
		{"feedback", rwFeedback}, {"admin", rwAdmin}, {"statistics", rwStats}, {"records", rwRecords}, {"snapshots", rwSnapshots},
	} {
		if err := step.run(ctx, rc, verify); err != nil {
			return fmt.Errorf("world %s import/reconciliation failed: %w", step.name, err)
		}
	}
	return nil
}
func rwFeedback(ctx context.Context, rc *RealContext, verify bool) error {
	m, err := rwRead(rc.Root, "feedback.json")
	if err != nil {
		return err
	}
	for i, v := range rwList(m["feedback"]) {
		r := rwMap(v)
		id := rwID(rc, r["key"])
		if id == 0 {
			return fmt.Errorf("feedback row %d has unresolved owner", i)
		}
		want := map[string]any{"account_id": id, "actor_name": r["name"], "kind": r["kind"], "body": r["text"], "version": r["version"], "status": r["status"], "t": r["t"], "statusAt": r["statusAt"], "status_by": r["statusBy"], "reward": r["reward"]}
		if verify {
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('account_id',account_id,'actor_name',actor_name,'kind',kind,'body',body,'version',version,'status',status,'t',(extract(epoch FROM created_at)*1000)::bigint,'statusAt',(extract(epoch FROM status_at)*1000)::bigint,'status_by',status_by,'reward',reward) FROM fishing.feedback_entries WHERE id=$1`, want, r["id"])
		} else {
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.feedback_entries(id,account_id,actor_name,kind,body,version,status,created_at,status_at,status_by,reward) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, r["id"], id, r["name"], r["kind"], r["text"], r["version"], r["status"], rwTime(r["t"]), rwTime(r["statusAt"]), rwString(r["statusBy"]), rwJSON(r["reward"]))
		}
		if err != nil {
			return fmt.Errorf("feedback row %d failed", i)
		}
	}
	orphanCooldowns := map[string]any{}
	for key, v := range rwMap(m["feedbackMeta"]) {
		id := rwID(rc, key)
		if id == 0 {
			// Deleted users have no active identity to cool down. Preserve their
			// history without manufacturing an account or a dangling FK.
			orphanCooldowns[key] = v
			continue
		}
		r := rwMap(v)
		lastAt, lastErr := realNonnegative(r["lastAt"], 0)
		nextAt, nextErr := realNonnegative(r["nextAt"], 0)
		if lastErr != nil || nextErr != nil {
			return errors.New("feedback cooldown timestamp invalid")
		}
		if verify {
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('lastAt',(extract(epoch FROM last_at)*1000)::bigint,'nextAt',(extract(epoch FROM next_at)*1000)::bigint) FROM fishing.feedback_cooldowns WHERE account_id=$1`, r, id)
		} else {
			// Zero is the legacy "cooldown cleared" sentinel, represented by
			// Unix epoch rather than SQL NULL in these NOT NULL columns.
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.feedback_cooldowns(account_id,last_at,next_at) VALUES($1,$2,$3)`, id, time.UnixMilli(lastAt), time.UnixMilli(nextAt))
		}
		if err != nil {
			return errors.New("feedback cooldown failed")
		}
	}
	return rwSetting(ctx, rc, "migration:orphan-feedback-cooldowns", orphanCooldowns, verify)
}
func rwAdmin(ctx context.Context, rc *RealContext, verify bool) error {
	m, err := rwRead(rc.Root, "admin.json")
	if err != nil {
		return err
	}
	for i, v := range rwList(m["adminLog"]) {
		r := rwMap(v)
		id := rwID(rc, r["key"])
		if id == 0 {
			return fmt.Errorf("admin row %d owner unresolved", i)
		}
		var target any
		if n := rwID(rc, r["target"]); n != 0 {
			target = n
		}
		// A stable source position identifies duplicate audit messages without
		// changing their original actor, text, target, or timestamp.
		setting := fmt.Sprintf("migration:admin-row:%d", i)
		if verify {
			want := map[string]any{"actor_id": id, "actor_name": r["name"], "account_id": target, "action": r["action"], "target": r["target"], "detail": r["detail"], "t": r["t"]}
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('actor_id',a.actor_id,'actor_name',a.actor_name,'account_id',a.account_id,'action',a.action,'target',a.target,'detail',a.detail,'t',(extract(epoch FROM a.created_at)*1000)::bigint) FROM fishing.admin_audit a JOIN fishing.operator_settings s ON a.id=(s.value#>>'{}')::bigint WHERE s.key=$1`, want, setting)
		} else {
			var audit int64
			err = rc.Tx.QueryRow(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, id, r["name"], target, r["action"], r["target"], r["detail"], rwTime(r["t"])).Scan(&audit)
			if err == nil {
				err = rwSetting(ctx, rc, setting, audit, false)
			}
		}
		if err != nil {
			return fmt.Errorf("admin row %d failed", i)
		}
	}
	return nil
}
func rwStats(ctx context.Context, rc *RealContext, verify bool) error {
	m, err := rwRead(rc.Root, "stats.json")
	if err != nil {
		return err
	}
	for i, v := range rwList(m["statMin"]) {
		r := rwMap(v)
		if verify {
			err = rwCheck(ctx, rc, `SELECT jsonb_build_object('t',(extract(epoch FROM sampled_at)*1000)::bigint,'online',online,'fishing',fishing,'listings',listings,'trades',trades,'users',players,'grounds',grounds,'spots',spots) FROM fishing.activity_samples WHERE sampled_at=$1`, r, rwTime(r["t"]))
		} else {
			_, err = rc.Tx.Exec(ctx, `INSERT INTO fishing.activity_samples(sampled_at,online,fishing,listings,trades,players,grounds,spots) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, rwTime(r["t"]), rwInt(r["online"]), rwInt(r["fishing"]), rwInt(r["listings"]), rwInt(r["trades"]), rwInt(r["users"]), rwJSON(rwObject(r["grounds"])), rwJSON(rwObject(r["spots"])))
		}
		if err != nil {
			return fmt.Errorf("statistics row %d failed", i)
		}
	}
	return rwSetting(ctx, rc, realStatsKey, m, verify)
}
func rwRecords(ctx context.Context, rc *RealContext, verify bool) error {
	m, err := rwRead(rc.Root, "records.json")
	if err != nil {
		return err
	}
	if err = rwSetting(ctx, rc, realRecordsKey, m, verify); err != nil {
		return err
	}
	if err = rwSetting(ctx, rc, "legacy:records_runtime", map[string]any{"lastRec": m["lastRec"]}, verify); err != nil {
		return err
	}
	return nil
}

// Snapshot views deliberately exclude credentials and administrator secrets.
// Their immutable original files remain in the controlled source archive.
var rwSnapshotFields = []string{"coins", "inventory", "bigfish", "codex", "catchCount", "bd", "rodSlots", "rodSlotsCount", "rodActiveSlot", "rodName", "autoSell", "subNotify", "ship", "sea", "chestPity", "mall", "lastFishing"}

func rwSnapshots(ctx context.Context, rc *RealContext, verify bool) error {
	base := filepath.Join(rc.Root, "snapshots")
	dirs, err := os.ReadDir(base)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("snapshot directory unavailable")
	}
	for directory, d := range dirs {
		if !d.IsDir() {
			return errors.New("unexpected snapshot root file")
		}
		files, err := os.ReadDir(filepath.Join(base, d.Name()))
		if err != nil {
			return errors.New("snapshot listing failed")
		}
		records := []any{}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
				return errors.New("unexpected snapshot entry")
			}
			stem := strings.TrimSuffix(f.Name(), ".json")
			if p := strings.IndexByte(stem, '-'); p >= 0 {
				stem = stem[:p]
			}
			at, err := strconv.ParseInt(stem, 10, 64)
			if err != nil || at <= 0 {
				return errors.New("invalid snapshot timestamp")
			}
			m, err := rwRead(filepath.Join(base, d.Name()), f.Name())
			if err != nil {
				return errors.New("snapshot payload invalid")
			}
			view := map[string]any{}
			for _, key := range rwSnapshotFields {
				if v, ok := m[key]; ok {
					view[key] = v
				}
			}
			records = append(records, map[string]any{"name": f.Name(), "ts": at, "view": view})
		}
		sort.Slice(records, func(i, j int) bool { return rwInt(rwMap(records[i])["ts"]) < rwInt(rwMap(records[j])["ts"]) })
		id := rwID(rc, d.Name())
		key := fmt.Sprintf("users:snapshots:%d", id)
		if id == 0 {
			key = fmt.Sprintf("migration:orphan-snapshots:%d", directory)
		}
		if err = rwSetting(ctx, rc, key, records, verify); err != nil {
			return fmt.Errorf("snapshot group %d failed", directory)
		}
	}
	return nil
}
