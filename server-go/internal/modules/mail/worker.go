package mail

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Batch and message locks serialize pause/revoke with delivery and claim.
// Delivery has no player-session dependency and survives an operator closing
// their browser. A failed transaction leaves its recipients pending for retry.
func (s *Service) Sweep(ctx context.Context) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var batch int64
	var payload, audience []byte
	var authorized bool
	err = tx.QueryRow(ctx, `SELECT b.id,b.payload,b.audience,(i.admin AND NOT i.banned AND NOT i.retired) FROM fishing.mail_batches b JOIN fishing.identities i ON i.account_id=b.actor_id WHERE b.status='queued' ORDER BY b.updated_at,b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`).Scan(&batch, &payload, &audience, &authorized)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !authorized {
		_, err = tx.Exec(ctx, `UPDATE fishing.mail_batches SET status='paused',revision=revision+1 WHERE id=$1`, batch)
		if err != nil {
			return 0, err
		}
		return 0, tx.Commit(ctx)
	}
	var in Send
	var filter Audience
	if err = json.Unmarshal(payload, &in); err != nil {
		return 0, err
	}
	if err = json.Unmarshal(audience, &filter); err != nil {
		return 0, err
	}
	rows, err := tx.Query(ctx, `SELECT r.recipient_id,NOT i.retired AND ($2::boolean OR NOT i.banned) AND ($3::boolean OR NOT i.admin) FROM fishing.mail_recipients r JOIN fishing.identities i ON i.account_id=r.recipient_id WHERE r.batch_id=$1 AND r.state='pending' ORDER BY r.recipient_id LIMIT 50 FOR UPDATE OF r`, batch, filter.IncludeBanned, filter.IncludeAdmins)
	if err != nil {
		return 0, err
	}
	type recipient struct {
		id       int64
		eligible bool
	}
	var recipients []recipient
	for rows.Next() {
		var v recipient
		if err = rows.Scan(&v.id, &v.eligible); err != nil {
			rows.Close()
			return 0, err
		}
		recipients = append(recipients, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, r := range recipients {
		if !r.eligible {
			if _, err = tx.Exec(ctx, `UPDATE fishing.mail_recipients SET state='skipped',error='account_ineligible' WHERE batch_id=$1 AND recipient_id=$2`, batch, r.id); err != nil {
				return 0, err
			}
			continue
		}
		if _, err = tx.Exec(ctx, "SAVEPOINT mail_recipient"); err != nil {
			return 0, err
		}
		err = deliver(ctx, tx, batch, r.id, in)
		state, reason := "sent", ""
		if err != nil {
			if _, rollbackErr := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT mail_recipient"); rollbackErr != nil {
				return 0, rollbackErr
			}
			state, reason = "failed", "delivery_failed"
		}
		if _, err = tx.Exec(ctx, "RELEASE SAVEPOINT mail_recipient"); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE fishing.mail_recipients SET state=$3,error=$4 WHERE batch_id=$1 AND recipient_id=$2`, batch, r.id, state, reason); err != nil {
			return 0, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE fishing.mail_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM fishing.mail_recipients WHERE batch_id=$1 AND state='pending') THEN 'queued' ELSE 'complete' END,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1`, batch); err != nil {
		return 0, err
	}
	return len(recipients), tx.Commit(ctx)
}

func (s *Service) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var sampled time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := s.Sweep(work)
		if err != nil && ctx.Err() == nil {
			logger.Error("mail_delivery_failed")
		}
		// Keep persistent game connections visible even when the player has no
		// ordinary HTTP request this minute. Admin sessions are never included.
		if time.Since(sampled) >= time.Minute {
			_, err = s.pool.Exec(work, `INSERT INTO fishing.player_activity(owner_id,kind,at) SELECT DISTINCT g.owner_id,'active',date_trunc('minute',clock_timestamp()) FROM fishing.gateway_streams g JOIN fishing.identities i ON i.account_id=g.owner_id WHERE g.expires_at>clock_timestamp() AND NOT i.retired AND NOT i.banned ON CONFLICT DO NOTHING`)
			if err != nil && ctx.Err() == nil {
				logger.Error("mail_activity_sample_failed")
			} else {
				sampled = time.Now()
			}
		}
		cancel()
	}
}

func deliver(ctx context.Context, tx pgx.Tx, batch, recipient int64, in Send) error {
	var id int64
	days := 30
	if in.ExpiryDays != nil {
		days = *in.ExpiryDays
	}
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.mail_messages(batch_id,recipient_id,sender_name,subject,body,expires_at) VALUES($1,$2,'管理员',$3,$4,CASE WHEN $5::int=0 THEN NULL ELSE clock_timestamp()+make_interval(days=>$5) END) RETURNING id`, batch, recipient, in.Subject, in.Body, days).Scan(&id); err != nil {
		return err
	}
	for _, a := range in.Attachments {
		inherit := a.BindOutputs == nil || *a.BindOutputs
		if _, err := tx.Exec(ctx, `INSERT INTO fishing.mail_attachments(mail_id,item_id,quantity,tier,custom_name,custom_description,reward_bound,bind_outputs) VALUES($1,$2,$3,$4,$5,$6,true,$7)`, id, a.ItemID, a.Quantity, a.Tier, a.Name, a.Description, inherit); err != nil {
			return err
		}
	}
	return nil
}
