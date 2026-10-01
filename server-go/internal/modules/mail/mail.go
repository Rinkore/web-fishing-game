// Package mail owns durable inboxes and atomic attachment delivery.
package mail

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Attachment struct {
	Coins       int64  `json:"coins,omitempty"`
	RewardBound bool   `json:"rewardBound"`
	BindOutputs *bool  `json:"bindOutputs"`
	ItemID      string `json:"itemId"`
	Quantity    int64  `json:"quantity"`
	Tier        string `json:"tier"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
type Message struct {
	BatchID     string       `json:"batchId"`
	ExpiresAt   *time.Time   `json:"expiresAt"`
	Revoked     bool         `json:"revoked"`
	Expired     bool         `json:"expired"`
	ID          string       `json:"id"`
	Sender      string       `json:"sender"`
	Subject     string       `json:"subject"`
	Body        string       `json:"body"`
	CreatedAt   int64        `json:"createdAt"`
	Read        bool         `json:"read"`
	Claimed     bool         `json:"claimed"`
	Attachments []Attachment `json:"attachments"`
}
type View struct {
	Messages []Message `json:"messages"`
	Unread   int       `json:"unread"`
	Pending  int       `json:"pending"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
}
type Send struct {
	ExpiryDays  *int         `json:"expiryDays"`
	Target      int64        `json:"-"`
	Subject     string       `json:"subject"`
	Body        string       `json:"body"`
	Attachments []Attachment `json:"attachments"`
}
type Service struct {
	pool    *pgxpool.Pool
	catalog *rules.Catalog
}

func New(pool *pgxpool.Pool, c *rules.Catalog) *Service { return &Service{pool, c} }

func (s *Service) List(ctx context.Context, owner int64, page int, summary bool) (View, error) {
	return s.ListFiltered(ctx, owner, page, summary, "")
}
func (s *Service) ListFiltered(ctx context.Context, owner int64, page int, summary bool, filter string) (View, error) {
	v := View{Messages: []Message{}, Page: max(1, page)}
	err := s.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE read_at IS NULL),count(*) FILTER (WHERE claimed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM fishing.mail_attachments a WHERE a.mail_id=m.id)) FROM fishing.mail_messages m WHERE recipient_id=$1`, owner).Scan(&v.Total, &v.Unread, &v.Pending)
	if err != nil || summary {
		return v, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id,sender_name,subject,body,created_at,read_at IS NOT NULL,claimed_at IS NOT NULL,COALESCE(batch_id::text,''),expires_at,revoked_at IS NOT NULL,COALESCE(expires_at<=clock_timestamp(),false) FROM fishing.mail_messages m WHERE recipient_id=$1 AND ($3='' OR ($3='unread' AND read_at IS NULL) OR ($3='pending' AND claimed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM fishing.mail_attachments a WHERE a.mail_id=m.id)) OR ($3='expiring' AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '3 days')) ORDER BY id DESC LIMIT 30 OFFSET $2`, owner, (v.Page-1)*30, filter)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var m Message
		var id int64
		var at time.Time
		if err = rows.Scan(&id, &m.Sender, &m.Subject, &m.Body, &at, &m.Read, &m.Claimed, &m.BatchID, &m.ExpiresAt, &m.Revoked, &m.Expired); err != nil {
			rows.Close()
			return v, err
		}
		m.ID = strconv.FormatInt(id, 10)
		m.CreatedAt = at.UnixMilli()
		m.Attachments = []Attachment{}
		v.Messages = append(v.Messages, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	if filter != "" {
		if err = s.pool.QueryRow(ctx, `SELECT count(*) FROM fishing.mail_messages m WHERE recipient_id=$1 AND (($2='unread' AND read_at IS NULL) OR ($2='pending' AND claimed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND EXISTS(SELECT 1 FROM fishing.mail_attachments a WHERE a.mail_id=m.id)) OR ($2='expiring' AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND expires_at<=clock_timestamp()+interval '3 days'))`, owner, filter).Scan(&v.Total); err != nil {
			return v, err
		}
	}
	for i := range v.Messages {
		rows, err = s.pool.Query(ctx, `SELECT item_id,quantity,tier,custom_name,custom_description,reward_bound,bind_outputs FROM fishing.mail_attachments WHERE mail_id=$1 ORDER BY id`, v.Messages[i].ID)
		if err != nil {
			return v, err
		}
		for rows.Next() {
			var a Attachment
			if err = rows.Scan(&a.ItemID, &a.Quantity, &a.Tier, &a.Name, &a.Description, &a.RewardBound, &a.BindOutputs); err != nil {
				rows.Close()
				return v, err
			}
			if a.ItemID == "__coins__" {
				a.Coins = a.Quantity
				a.ItemID = ""
				a.Quantity = 0
			}
			v.Messages[i].Attachments = append(v.Messages[i].Attachments, a)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return v, err
		}
	}
	return v, nil
}
func (s *Service) validate(in *Send) error {
	in.Subject = strings.TrimSpace(in.Subject)
	if in.Subject == "" || utf8.RuneCountInString(in.Subject) > 120 || utf8.RuneCountInString(in.Body) > 10000 || len(in.Attachments) > 30 {
		return assets.ErrInvalid
	}
	seen := map[string]bool{}
	coinCount := 0
	equipmentCount := int64(0)
	for i := range in.Attachments {
		a := &in.Attachments[i]
		if a.Coins == 0 {
			a.RewardBound = true
			if a.BindOutputs == nil {
				value := true
				a.BindOutputs = &value
			}
		}
		if a.Coins == 0 && len(a.ItemID) > 128 {
			return assets.ErrInvalid
		}
		if a.Coins == 0 && a.Tier == "" {
			a.Tier = "normal"
		}
		if a.Coins > 0 && (a.Tier != "" && a.Tier != "normal" || a.BindOutputs != nil && *a.BindOutputs || a.RewardBound) {
			return assets.ErrInvalid
		}
		if a.Coins < 0 || a.Coins > assets.MaxCoins || (a.Coins > 0 && (a.ItemID != "" || a.Quantity != 0)) {
			return assets.ErrInvalid
		}
		if a.Coins > 0 {
			coinCount++
			if coinCount > 1 {
				return assets.ErrInvalid
			}
			continue
		}
		if a.Quantity < 1 || a.Quantity > 1000000 || a.ItemID == "" || seen[a.ItemID+":"+a.Tier] {
			return assets.ErrInvalid
		}
		seen[a.ItemID+":"+a.Tier] = true
		item, ok := s.catalog.Item(a.ItemID)
		if !ok {
			item, _, _, ok = s.catalog.Instance(a.ItemID)
			if !ok || !strings.Contains(a.ItemID, "#") {
				return assets.ErrInvalid
			}
		}
		if item.Kind == "component" {
			if !strings.Contains(a.ItemID, "#") {
				return assets.ErrInvalid
			}
			equipmentCount += a.Quantity
			_, quality, affixes, valid := s.catalog.Instance(a.ItemID)
			if !valid || len(affixes) < 1 || len(affixes) > 9 {
				return assets.ErrInvalid
			}
			seenAffix := map[string]bool{}
			for _, af := range affixes {
				if af.Type == "" || seenAffix[af.Type] || math.IsNaN(af.Value) || math.IsInf(af.Value, 0) || math.Abs(af.Value) > 100000 {
					return assets.ErrInvalid
				}
				seenAffix[af.Type] = true
			}
			if item.SetID != "" {
				valid = false
				for _, set := range s.catalog.GearSets() {
					if set.ID == item.SetID {
						for _, piece := range set.Pieces {
							if piece.Part == item.Part && quality == "epic" && len(affixes) == 1 && affixes[0].Type == piece.Type && affixes[0].Value == piece.Value {
								valid = true
							}
						}
					}
				}
				if !valid {
					return assets.ErrInvalid
				}
			}
		}
		if equipmentCount > 100 || (a.Tier != "normal" && (item.Kind != "fish" || (a.Tier != "large" && a.Tier != "giant"))) {
			return assets.ErrInvalid
		}
		a.Name = item.Name
		a.Description = item.Description
	}
	if in.ExpiryDays == nil {
		days := 30
		in.ExpiryDays = &days
	}
	if *in.ExpiryDays < 0 || *in.ExpiryDays > 3650 {
		return assets.ErrInvalid
	}
	return nil
}

func (s *Service) Send(ctx context.Context, actor int64, actorName, key string, in Send) (assets.Result, error) {
	if err := assets.RequireAdmin(ctx, actor); err != nil {
		return assets.Result{}, err
	}
	if in.Target <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	if err := s.validate(&in); err != nil {
		return assets.Result{}, err
	}
	players := []int64{actor}
	if actor != in.Target {
		players = append(players, in.Target)
	}
	// Presentation metadata may be edited between a lost reply and a retry.
	// Deduplication depends only on the operator's requested delivery.
	input := in
	input.Attachments = append([]Attachment{}, in.Attachments...)
	for i := range input.Attachments {
		input.Attachments[i].Name = ""
		input.Attachments[i].Description = ""
	}
	return assets.New(s.pool).Run(ctx, assets.Command{ActorID: actor, RequestKey: key, Kind: "mail_send", RuleVersion: "mail-v1", Players: players, Input: struct {
		Target int64
		Mail   Send
	}{in.Target, input}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var retired bool
		if err := t.SQL().QueryRow(ctx, `SELECT retired FROM fishing.identities WHERE account_id=$1`, in.Target).Scan(&retired); err != nil {
			return assets.Result{}, err
		}
		if retired {
			return assets.Result{}, assets.Rejection("account_not_found")
		}
		var id int64
		if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.mail_messages(recipient_id,sender_name,subject,body,expires_at) VALUES($1,'管理员',$2,$3,CASE WHEN $4::int=0 THEN NULL ELSE clock_timestamp()+make_interval(days=>$4) END) RETURNING id`, in.Target, in.Subject, in.Body, *in.ExpiryDays).Scan(&id); err != nil {
			return assets.Result{}, err
		}
		for _, a := range in.Attachments {
			if a.Coins > 0 {
				if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.mail_attachments(mail_id,item_id,quantity,tier,custom_name,custom_description,reward_bound,bind_outputs) VALUES($1,'__coins__',$2,'normal','','',false,false)`, id, a.Coins); err != nil {
					return assets.Result{}, err
				}
				continue
			}
			if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.mail_attachments(mail_id,item_id,quantity,tier,custom_name,custom_description,reward_bound,bind_outputs) VALUES($1,$2,$3,$4,$5,$6,true,$7)`, id, a.ItemID, a.Quantity, a.Tier, a.Name, a.Description, *a.BindOutputs); err != nil {
				return assets.Result{}, err
			}
		}
		if _, err := t.SQL().Exec(ctx, `INSERT INTO fishing.admin_audit(actor_id,actor_name,account_id,action,target,detail) VALUES($1,$2,$3,'mail/send',$4,$5)`, actor, actorName, in.Target, strconv.FormatInt(id, 10), in.Subject); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "sent", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
func (s *Service) Change(ctx context.Context, owner int64, key string, id int64, claim bool) (assets.Result, error) {
	if id <= 0 {
		return assets.Result{}, assets.ErrInvalid
	}
	kind := "mail_read"
	if claim {
		kind = "mail_claim"
	}
	return assets.New(s.pool).Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: kind, RuleVersion: "mail-v1", Players: []int64{owner}, Input: struct {
		ID    int64
		Claim bool
	}{id, claim}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		var claimed, unavailable bool
		err := t.SQL().QueryRow(ctx, `SELECT claimed_at IS NOT NULL,(revoked_at IS NOT NULL OR COALESCE(expires_at<=clock_timestamp(),false)) FROM fishing.mail_messages WHERE id=$1 AND recipient_id=$2 FOR UPDATE`, id, owner).Scan(&claimed, &unavailable)
		if errors.Is(err, pgx.ErrNoRows) {
			return assets.Result{}, assets.Rejection("mail_missing")
		}
		if err != nil {
			return assets.Result{}, err
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.mail_messages SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1`, id); err != nil {
			return assets.Result{}, err
		}
		if !claim {
			return assets.Result{Status: "read"}, nil
		}
		if claimed {
			return assets.Result{Status: "claimed", ResourceID: strconv.FormatInt(id, 10)}, nil
		}
		if unavailable {
			return assets.Result{}, assets.Rejection("mail_unavailable")
		}
		rows, err := t.SQL().Query(ctx, `SELECT item_id,quantity,tier,reward_bound,bind_outputs FROM fishing.mail_attachments WHERE mail_id=$1 ORDER BY id`, id)
		if err != nil {
			return assets.Result{}, err
		}
		items := []Attachment{}
		for rows.Next() {
			var a Attachment
			if err = rows.Scan(&a.ItemID, &a.Quantity, &a.Tier, &a.RewardBound, &a.BindOutputs); err != nil {
				rows.Close()
				return assets.Result{}, err
			}
			items = append(items, a)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return assets.Result{}, err
		}
		deltas := []assets.StackDelta{}
		for _, a := range items {
			if a.ItemID == "__coins__" {
				if err = t.Coins(ctx, owner, a.Quantity); err != nil {
					return assets.Result{}, err
				}
				continue
			}
			if strings.Contains(a.ItemID, "#") {
				base, _, _, ok := s.catalog.Instance(a.ItemID)
				if !ok {
					return assets.Result{}, assets.Rejection("attachment_unavailable")
				}
				attrs, _ := json.Marshal(map[string]any{"signature": a.ItemID})
				for n := int64(0); n < a.Quantity; n++ {
					equipmentID, createErr := t.CreateEquipment(ctx, owner, assets.EquipmentSpec{DefinitionID: base.ID, Part: base.Part, Attributes: attrs})
					err = createErr
					if err == nil && a.RewardBound {
						err = t.BindEquipment(ctx, owner, equipmentID, *a.BindOutputs)
					}
					if err != nil {
						return assets.Result{}, err
					}
				}
			} else {
				deltas = append(deltas, assets.StackDelta{ItemID: a.ItemID, Tier: a.Tier, Quantity: a.Quantity})
			}
		}
		if err = t.Stacks(ctx, owner, deltas); err != nil {
			return assets.Result{}, err
		}
		for _, a := range items {
			if a.RewardBound && a.ItemID != "__coins__" && !strings.Contains(a.ItemID, "#") {
				if err = t.BindStacks(ctx, owner, []assets.StackDelta{{ItemID: a.ItemID, Tier: a.Tier, Quantity: a.Quantity}}, *a.BindOutputs); err != nil {
					return assets.Result{}, err
				}
			}
		}
		if _, err = t.SQL().Exec(ctx, `UPDATE fishing.mail_messages SET claimed_at=clock_timestamp() WHERE id=$1`, id); err != nil {
			return assets.Result{}, err
		}
		return assets.Result{Status: "claimed", ResourceID: strconv.FormatInt(id, 10)}, nil
	})
}
