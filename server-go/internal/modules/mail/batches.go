package mail

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5"
)

type Audience struct {
	Mode             string     `json:"mode"`
	Query            string     `json:"query"`
	ActivityKind     string     `json:"activityKind"`
	After            *time.Time `json:"after"`
	Before           *time.Time `json:"before"`
	RegisteredAfter  *time.Time `json:"registeredAfter"`
	RegisteredBefore *time.Time `json:"registeredBefore"`
	IncludeBanned    bool       `json:"includeBanned"`
	IncludeAdmins    bool       `json:"includeAdmins"`
	IDs              []string   `json:"ids"`
	Accounts         []string   `json:"accounts"`
	Exclude          []string   `json:"exclude"`
}

func (a *Audience) normalize() error {
	if a.Mode == "" {
		a.Mode = "filter"
	}
	if a.ActivityKind == "" {
		a.ActivityKind = "active"
	}
	if (a.Mode != "all" && a.Mode != "filter" && a.Mode != "selected") || (a.ActivityKind != "active" && a.ActivityKind != "login") || len(a.Query) > 120 || len(a.IDs)+len(a.Accounts)+len(a.Exclude) > 2000 {
		return assets.ErrInvalid
	}
	if a.After != nil && a.Before != nil && !a.Before.After(*a.After) {
		return assets.ErrInvalid
	}
	if a.RegisteredAfter != nil && a.RegisteredBefore != nil && !a.RegisteredBefore.After(*a.RegisteredAfter) {
		return assets.ErrInvalid
	}
	if a.Mode == "all" {
		a.Query = ""
		a.After = nil
		a.Before = nil
		a.RegisteredAfter = nil
		a.RegisteredBefore = nil
	}
	if a.IDs == nil {
		a.IDs = []string{}
	}
	if a.Accounts == nil {
		a.Accounts = []string{}
	}
	if a.Exclude == nil {
		a.Exclude = []string{}
	}
	for i := range a.Accounts {
		a.Accounts[i] = strings.ToLower(strings.TrimSpace(a.Accounts[i]))
	}
	return nil
}

// Bound parameters only. The same predicate powers search and the frozen
// recipient INSERT, including exclusions and the half-open time interval.
const audienceWhere = ` FROM fishing.identities i JOIN fishing.accounts ac ON ac.id=i.account_id
 WHERE NOT i.retired AND ($1::boolean OR NOT i.banned) AND ($2::boolean OR NOT i.admin)
 AND NOT(i.account_id::text=ANY($3::text[]))
 AND ($4::text<>'selected' OR i.account_id::text=ANY($5::text[]) OR i.username=ANY($6::text[]))
 AND ($4::text='all' OR $7::text='' OR i.account_id::text=$7 OR i.username=lower($7) OR strpos(lower(i.display_name),lower($7))>0)
 AND ($8::timestamptz IS NULL OR ac.created_at >= $8) AND ($9::timestamptz IS NULL OR ac.created_at < $9)
 AND (($10::timestamptz IS NULL AND $11::timestamptz IS NULL) OR EXISTS(
 SELECT 1 FROM fishing.player_activity a WHERE a.owner_id=i.account_id AND ($12::text='active' OR a.kind='login')
 AND ($10::timestamptz IS NULL OR a.at >= $10) AND ($11::timestamptz IS NULL OR a.at < $11)))`

func (a Audience) args() []any {
	return []any{a.IncludeBanned, a.IncludeAdmins, a.Exclude, a.Mode, a.IDs, a.Accounts, strings.TrimSpace(a.Query), a.RegisteredAfter, a.RegisteredBefore, a.After, a.Before, a.ActivityKind}
}

type Recipient struct {
	ID         string     `json:"id"`
	Account    string     `json:"account"`
	Name       string     `json:"name"`
	Banned     bool       `json:"banned"`
	Admin      bool       `json:"admin"`
	LastActive *time.Time `json:"lastActive"`
	LastLogin  *time.Time `json:"lastLogin"`
}
type Recipients struct {
	Items         []Recipient `json:"items"`
	Total         int         `json:"total"`
	Page          int         `json:"page"`
	TrackingSince time.Time   `json:"trackingSince"`
	Unknown       int         `json:"unknown"`
}

func (s *Service) Search(ctx context.Context, a Audience, page int) (Recipients, error) {
	out := Recipients{Items: []Recipient{}, Page: max(1, min(page, 100000))}
	if err := a.normalize(); err != nil {
		return out, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = tx.QueryRow(ctx, `SELECT started_at FROM fishing.mail_tracking`).Scan(&out.TrackingSince); err != nil {
		return out, err
	}
	if err = tx.QueryRow(ctx, `SELECT count(*)`+audienceWhere, a.args()...).Scan(&out.Total); err != nil {
		return out, err
	}
	unknownAudience := a
	unknownAudience.After = nil
	unknownAudience.Before = nil
	if err = tx.QueryRow(ctx, `SELECT count(*)`+audienceWhere+` AND NOT EXISTS(SELECT 1 FROM fishing.player_activity pa WHERE pa.owner_id=i.account_id AND ($12::text='active' OR pa.kind='login'))`, unknownAudience.args()...).Scan(&out.Unknown); err != nil {
		return out, err
	}
	args := append(a.args(), (out.Page-1)*30)
	rows, err := tx.Query(ctx, `SELECT i.account_id::text,i.username,i.display_name,i.banned,i.admin,
 (SELECT max(at) FROM fishing.player_activity a WHERE a.owner_id=i.account_id),
 (SELECT max(at) FROM fishing.player_activity a WHERE a.owner_id=i.account_id AND a.kind='login')`+audienceWhere+` ORDER BY i.account_id LIMIT 30 OFFSET $13`, args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v Recipient
		if err = rows.Scan(&v.ID, &v.Account, &v.Name, &v.Banned, &v.Admin, &v.LastActive, &v.LastLogin); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

type Draft struct {
	Name     string   `json:"name"`
	Reason   string   `json:"reason"`
	Mail     Send     `json:"mail"`
	Audience Audience `json:"audience"`
	Template bool     `json:"template"`
}
type BatchCommand struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
	Action   string `json:"action"`
	Draft    Draft  `json:"draft"`
}
type Batch struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Reason     string     `json:"reason"`
	Actor      string     `json:"actor"`
	Status     string     `json:"status"`
	Revision   int64      `json:"revision"`
	Template   bool       `json:"template"`
	CreatedAt  time.Time  `json:"createdAt"`
	SnapshotAt *time.Time `json:"snapshotAt"`
	Mail       Send       `json:"mail"`
	Audience   Audience   `json:"audience"`
	Total      int        `json:"total"`
	Sent       int        `json:"sent"`
	Failed     int        `json:"failed"`
	Skipped    int        `json:"skipped"`
	Read       int        `json:"read"`
	Claimed    int        `json:"claimed"`
	Expired    int        `json:"expired"`
}

func (s *Service) Batches(ctx context.Context, q, status string, page int) ([]Batch, error) {
	out := []Batch{}
	rows, err := s.pool.Query(ctx, `SELECT b.id::text,b.name,b.reason,b.actor_name,b.status,b.revision,b.is_template,b.created_at,b.snapshot_at,b.payload,b.audience,
 (SELECT count(*) FROM fishing.mail_recipients r WHERE r.batch_id=b.id),
 (SELECT count(*) FROM fishing.mail_recipients r WHERE r.batch_id=b.id AND r.state='sent'),
 (SELECT count(*) FROM fishing.mail_recipients r WHERE r.batch_id=b.id AND r.state='failed'),
 (SELECT count(*) FROM fishing.mail_recipients r WHERE r.batch_id=b.id AND r.state='skipped'),
 (SELECT count(*) FROM fishing.mail_messages m WHERE m.batch_id=b.id AND m.read_at IS NOT NULL),
 (SELECT count(*) FROM fishing.mail_messages m WHERE m.batch_id=b.id AND m.claimed_at IS NOT NULL),
 (SELECT count(*) FROM fishing.mail_messages m WHERE m.batch_id=b.id AND m.claimed_at IS NULL AND m.expires_at<=clock_timestamp())
 FROM fishing.mail_batches b WHERE ($1='' OR b.id::text=$1 OR strpos(lower(b.name),lower($1))>0) AND ($2='' OR b.status=$2 OR ($2='template' AND b.is_template)) ORDER BY b.id DESC LIMIT 30 OFFSET $3`, q, status, (max(1, min(page, 100000))-1)*30)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var b Batch
		var payload, audience []byte
		if err = rows.Scan(&b.ID, &b.Name, &b.Reason, &b.Actor, &b.Status, &b.Revision, &b.Template, &b.CreatedAt, &b.SnapshotAt, &payload, &audience, &b.Total, &b.Sent, &b.Failed, &b.Skipped, &b.Read, &b.Claimed, &b.Expired); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(payload, &b.Mail); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(audience, &b.Audience); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Service) BatchChange(ctx context.Context, actor int64, actorName, key string, in BatchCommand) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, actor); err != nil {
		return assets.Result{}, err
	}
	switch in.Action {
	case "draft", "preview":
		if err := s.validate(&in.Draft.Mail); err != nil {
			return assets.Result{}, err
		}
		if err := in.Draft.Audience.normalize(); err != nil {
			return assets.Result{}, err
		}
		in.Draft.Name = strings.TrimSpace(in.Draft.Name)
		in.Draft.Reason = strings.TrimSpace(in.Draft.Reason)
		if len([]rune(in.Draft.Name)) < 1 || len([]rune(in.Draft.Name)) > 120 || len([]rune(in.Draft.Reason)) < 1 || len([]rune(in.Draft.Reason)) > 500 {
			return assets.Result{}, assets.ErrInvalid
		}
	case "send", "pause", "resume", "retry", "revoke":
		if id, err := strconv.ParseInt(in.ID, 10, 64); err != nil || id <= 0 {
			return assets.Result{}, assets.ErrInvalid
		}
	default:
		return assets.Result{}, assets.ErrInvalid
	}
	input := in
	input.Draft.Mail.Attachments = append([]Attachment{}, in.Draft.Mail.Attachments...)
	for i := range input.Draft.Mail.Attachments {
		input.Draft.Mail.Attachments[i].Name = ""
		input.Draft.Mail.Attachments[i].Description = ""
	}
	return assets.New(s.pool).Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "mail_send", RuleVersion: "mail-batch-v1", Players: []int64{actor}, Input: input}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var id int64
		if in.Action == "draft" || in.Action == "preview" {
			payload, _ := json.Marshal(in.Draft.Mail)
			audience, _ := json.Marshal(in.Draft.Audience)
			if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.mail_batches(actor_id,actor_name,name,reason,payload,audience,is_template,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, actor, actorName, in.Draft.Name, in.Draft.Reason, payload, audience, in.Draft.Template, in.Action).Scan(&id); err != nil {
				return assets.Result{}, err
			}
			if in.Action == "preview" {
				if in.Draft.Audience.Mode == "selected" {
					var unknown bool
					if err := t.SQL().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM unnest($1::text[]) x WHERE NOT EXISTS(SELECT 1 FROM fishing.identities WHERE account_id::text=x AND NOT retired)) OR EXISTS(SELECT 1 FROM unnest($2::text[]) x WHERE NOT EXISTS(SELECT 1 FROM fishing.identities WHERE username=x AND NOT retired))`, in.Draft.Audience.IDs, in.Draft.Audience.Accounts).Scan(&unknown); err != nil {
						return assets.Result{}, err
					}
					if unknown {
						return assets.Result{}, assets.Rejection("recipient_unknown")
					}
				}

				args := append(in.Draft.Audience.args(), id)
				tag, err := t.SQL().Exec(ctx, `INSERT INTO fishing.mail_recipients(batch_id,recipient_id) SELECT $13::bigint,i.account_id`+audienceWhere+` ORDER BY i.account_id LIMIT 50001`, args...)
				if err != nil {
					return assets.Result{}, err
				}
				if tag.RowsAffected() == 0 {
					return assets.Result{}, assets.Rejection("empty_audience")
				}
				if tag.RowsAffected() > 50000 {
					return assets.Result{}, assets.Rejection("audience_limit")
				}
				if _, err = t.SQL().Exec(ctx, `UPDATE fishing.mail_batches SET snapshot_at=clock_timestamp() WHERE id=$1`, id); err != nil {
					return assets.Result{}, err
				}
			}
		} else {
			id, _ = strconv.ParseInt(in.ID, 10, 64)
			var status string
			var revision int64
			if err := t.SQL().QueryRow(ctx, `SELECT status,revision FROM fishing.mail_batches WHERE id=$1 FOR UPDATE`, id).Scan(&status, &revision); err != nil {
				if err == pgx.ErrNoRows {
					return assets.Result{}, assets.Rejection("batch_missing")
				}
				return assets.Result{}, err
			}
			if revision != in.Revision {
				return assets.Result{}, assets.Rejection("batch_changed")
			}
			next := ""
			switch in.Action {
			case "send":
				if status == "preview" {
					next = "queued"
				}
			case "pause":
				if status == "queued" {
					next = "paused"
				}
			case "resume":
				if status == "paused" {
					next = "queued"
				}
			case "retry":
				if status == "complete" || status == "paused" {
					next = "queued"
					if _, err := t.SQL().Exec(ctx, `UPDATE fishing.mail_recipients SET state='pending',error='' WHERE batch_id=$1 AND state='failed'`, id); err != nil {
						return assets.Result{}, err
					}
				}
			case "revoke":
				if status != "draft" && status != "revoked" {
					next = "revoked"
					if _, err := t.SQL().Exec(ctx, `UPDATE fishing.mail_messages SET revoked_at=clock_timestamp() WHERE batch_id=$1 AND claimed_at IS NULL AND revoked_at IS NULL`, id); err != nil {
						return assets.Result{}, err
					}
				}
			}
			if next == "" {
				return assets.Result{}, assets.Rejection("batch_state")
			}
			if _, err := t.SQL().Exec(ctx, `UPDATE fishing.mail_batches SET status=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, id, next); err != nil {
				return assets.Result{}, err
			}
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$1,$3,$4,$5)`, actor, actorName, "mail/"+in.Action, strconv.FormatInt(id, 10), in.Draft.Reason); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: in.Action, ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}

func (s *Service) BatchRecipients(ctx context.Context, id int64, page int, state string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `SELECT r.recipient_id::text,i.username,i.display_name,r.state,r.error,m.read_at IS NOT NULL,m.claimed_at IS NOT NULL FROM fishing.mail_recipients r JOIN fishing.identities i ON i.account_id=r.recipient_id LEFT JOIN fishing.mail_messages m ON m.batch_id=r.batch_id AND m.recipient_id=r.recipient_id WHERE r.batch_id=$1 AND ($2='' OR r.state=$2) ORDER BY r.recipient_id LIMIT 30 OFFSET $3`, id, state, (max(1, min(page, 100000))-1)*30)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, account, name, status, reason string
		var read, claimed bool
		if err = rows.Scan(&id, &account, &name, &status, &reason, &read, &claimed); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "account": account, "name": name, "state": status, "error": reason, "read": read, "claimed": claimed})
	}
	return out, rows.Err()
}
