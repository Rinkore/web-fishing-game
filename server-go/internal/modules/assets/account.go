package assets

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// InitializePlayer is called only inside identity's new-account transaction.
// Registration grants 500 coins with the same ledger/outbox boundary as rewards.
func InitializePlayer(ctx context.Context, tx pgx.Tx, id int64) error {
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.player_state(account_id,assets_rev) VALUES($1,1);`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.wallets(account_id,coins) VALUES($1,0)`, id); err != nil {
		return err
	}
	h := sha256.Sum256([]byte("registration-v0.21.4"))
	if _, err := tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES($1,'registration',$2)`, id, h[:]); err != nil {
		return err
	}
	u := &assetTx{tx: tx}
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES($1,'registration','registration','v0.21.4') RETURNING id`, id).Scan(&u.op); err != nil {
		return err
	}
	if err := u.coins(ctx, id, 500); err != nil {
		return err
	}
	result := Result{Status: "registered", OperationID: strconv.FormatInt(u.op, 10), SenderBalance: 500}
	body, _ := json.Marshal(result)
	if _, err := tx.Exec(ctx, `UPDATE fishing.command_results SET result=$2 WHERE actor_id=$1 AND request_key='registration'`, id, body); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"actor": strconv.FormatInt(id, 10), "players": []string{strconv.FormatInt(id, 10)}, "result": result})
	var outboxID int64
	if err := tx.QueryRow(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES($1,'assets_changed',$2) RETURNING id`, u.op, payload).Scan(&outboxID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO fishing.player_events(owner_id,revision,outbox_id) VALUES($1,1,$2)`, id, outboxID)
	return err
}
