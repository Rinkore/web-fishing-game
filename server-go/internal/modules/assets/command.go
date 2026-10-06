package assets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type Rejection string

type rejection = Rejection

func (r Rejection) Error() string { return string(r) }

// All asset use cases share one command boundary. Callback mutations execute
// inside a savepoint: a business rejection rolls them back but persists the
// rejection itself. Technical failure rolls back the entire transaction.
type command struct {
	actor           int64
	key, kind, rule string
	hash            []byte
	players         []int64
}

type assetTx struct {
	tx            pgx.Tx
	op            int64
	kind          string
	inherit       map[int64]bool
	unboundInputs bool
	eventPayload  json.RawMessage // optional payload for an existing event contract
}

func (s *Service) execute(ctx context.Context, c command, apply func(context.Context, *assetTx) (Result, error)) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		result, err := s.executeOnce(ctx, c, apply)
		if err == nil {
			return result, nil
		}
		if retryable(err) && attempt < 2 && ctx.Err() == nil {
			continue
		}
		if errors.Is(err, ErrKeyConflict) {
			return Result{}, ErrKeyConflict
		}
		if errors.Is(err, ErrCommitUnknown) {
			return Result{}, ErrCommitUnknown
		}
		if errors.Is(err, ErrDeferred) {
			return Result{}, ErrDeferred
		}
		if errors.Is(err, ErrUnauthenticated) {
			return Result{}, ErrUnauthenticated
		}
		return Result{}, ErrUnavailable
	}
	return Result{}, ErrUnavailable
}

func (s *Service) executeOnce(ctx context.Context, c command, apply func(context.Context, *assetTx) (Result, error)) (Result, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err = tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id,request_key,request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, c.actor, c.key, c.hash); err != nil {
		return Result{}, err
	}
	var storedHash, storedResult []byte
	if err = tx.QueryRow(ctx, `SELECT request_hash,result FROM fishing.command_results WHERE actor_id=$1 AND request_key=$2 FOR UPDATE`, c.actor, c.key).Scan(&storedHash, &storedResult); err != nil {
		return Result{}, err
	}
	if !bytes.Equal(c.hash, storedHash) {
		return Result{}, ErrKeyConflict
	}
	// Establish the feature publication boundary before player guards. Publish
	// and feature-gated commands therefore share one lock order and cannot
	// deadlock while a publication closes existing player state.
	if err = lockFeatureBoundary(ctx, tx, c.kind); err != nil {
		return Result{}, err
	}
	ids := append([]int64(nil), c.players...)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	result := Result{}
	for i, id := range ids {
		if i > 0 && ids[i-1] == id {
			continue
		}
		var locked int64
		if err = tx.QueryRow(ctx, "SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE", id).Scan(&locked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				result.Status = "account_not_found"
				break
			}
			return Result{}, err
		}
	}
	if err = checkSession(ctx, tx, c.actor); err != nil {
		return Result{}, err
	}
	if len(storedResult) > 0 {
		var r Result
		if err = json.Unmarshal(storedResult, &r); err != nil {
			return Result{}, err
		}
		return r, nil
	}
	if result.Status == "" {
		if _, err = tx.Exec(ctx, "SAVEPOINT asset_effects"); err != nil {
			return Result{}, err
		}
		unit := &assetTx{tx: tx, kind: c.kind, inherit: map[int64]bool{}}
		if err = tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES ($1,$2,$3,$4) RETURNING id`, c.actor, c.key, c.kind, c.rule).Scan(&unit.op); err != nil {
			return Result{}, err
		}
		err = featureAllowed(ctx, tx, c.kind, c.key)
		if err == nil {
			result, err = apply(ctx, unit)
			if err == nil {
				err = unit.bindCraftOutputs(ctx)
			}
			if err == nil {
				err = unit.recordBindings(ctx)
			}
		}
		var rejected rejection
		if errors.As(err, &rejected) {
			if _, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT asset_effects"); err != nil {
				return Result{}, err
			}
			result = Result{Status: string(rejected), SenderBalance: result.SenderBalance, RecipientBalance: result.RecipientBalance}
		} else if err != nil {
			return Result{}, err
		} else {
			result.OperationID = strconv.FormatInt(unit.op, 10)
			if _, err = tx.Exec(ctx, "UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=ANY($1::bigint[])", ids); err != nil {
				return Result{}, err
			}
			payload, _ := json.Marshal(struct {
				Actor   string   `json:"actor"`
				Players []string `json:"players"`
				Result  Result   `json:"result"`
			}{strconv.FormatInt(c.actor, 10), stringIDs(ids), result})
			event := "assets_changed"
			if c.kind == "coin_transfer" {
				event = "coins_transferred"
			}
			if unit.eventPayload != nil {
				payload = unit.eventPayload
			}
			var outboxID int64
			if err = tx.QueryRow(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES ($1,$2,$3) RETURNING id`, unit.op, event, payload).Scan(&outboxID); err != nil {
				return Result{}, err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO fishing.player_events(owner_id,revision,outbox_id) SELECT account_id,assets_rev,$2 FROM fishing.player_state WHERE account_id=ANY($1::bigint[])`, ids, outboxID); err != nil {
				return Result{}, err
			}
		}
	}
	encoded, _ := json.Marshal(result)
	if _, err = tx.Exec(ctx, `UPDATE fishing.command_results SET result=$3 WHERE actor_id=$1 AND request_key=$2`, c.actor, c.key, encoded); err != nil {
		return Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		if retryable(err) {
			return Result{}, err
		}
		return Result{}, ErrCommitUnknown
	}
	return result, nil
}

func stringIDs(ids []int64) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = strconv.FormatInt(id, 10)
	}
	return out
}
