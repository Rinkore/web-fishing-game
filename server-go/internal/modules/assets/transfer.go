// Package assets is the sole writer of wallets and their accounting records.
// There is deliberately no public transfer HTTP endpoint: authentication,
// permissions, fees and gameplay transfer rules are not implemented here.
package assets

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const MaxCoins int64 = 9007199254740991
const ruleVersion = "coin-transfer-v1"

var ErrInvalid = errors.New("invalid transfer")
var ErrKeyConflict = errors.New("request key reused with different input")
var ErrUnavailable = errors.New("asset storage unavailable; retry with the same request key")
var ErrCommitUnknown = errors.New("commit outcome unknown; query or retry with the same request key")
var ErrNotFound = errors.New("request result not found")

type Transfer struct {
	ActorID     int64
	RecipientID int64
	Amount      int64
	RequestKey  string
}

type Result struct {
	Status           string `json:"status"`
	OperationID      string `json:"operationId,omitempty"`
	SenderBalance    int64  `json:"senderBalance"`
	RecipientBalance int64  `json:"recipientBalance"`
}

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func validKey(key string) bool {
	if len(key) < 1 || len(key) > 128 {
		return false
	}
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}

// TransferCoins trusts the caller's authenticated ActorID. Every attempt uses
// the same input/key. Only DB-confirmed deadlocks/serialization aborts retry;
// an uncertain COMMIT is never blindly re-executed under a new business key.
func (s *Service) TransferCoins(ctx context.Context, request Transfer) (Result, error) {
	if request.ActorID <= 0 || request.RecipientID <= 0 || request.ActorID == request.RecipientID || request.Amount < 1 || request.Amount > MaxCoins || !validKey(request.RequestKey) {
		return Result{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for attempt := 0; attempt < 3; attempt++ {
		result, err := s.transferOnce(ctx, request)
		if err == nil {
			return result, nil
		}
		if retryable(err) && attempt < 2 && ctx.Err() == nil {
			continue
		}
		for _, known := range []error{ErrKeyConflict, ErrCommitUnknown} {
			if errors.Is(err, known) {
				return Result{}, known
			}
		}
		return Result{}, ErrUnavailable
	}
	return Result{}, ErrUnavailable
}

func retryable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

func (s *Service) transferOnce(ctx context.Context, request Transfer) (Result, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Result{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%d", ruleVersion, request.ActorID, request.RecipientID, request.Amount)))
	// The unique command row serializes duplicate keys before any player locks.
	_, err = tx.Exec(ctx, `INSERT INTO fishing.command_results(actor_id, request_key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, request.ActorID, request.RequestKey, hash[:])
	if err != nil {
		return Result{}, err
	}
	var storedHash, storedResult []byte
	if err = tx.QueryRow(ctx, `SELECT request_hash, result FROM fishing.command_results WHERE actor_id=$1 AND request_key=$2 FOR UPDATE`, request.ActorID, request.RequestKey).Scan(&storedHash, &storedResult); err != nil {
		return Result{}, err
	}
	if !bytes.Equal(hash[:], storedHash) {
		return Result{}, ErrKeyConflict
	}
	if len(storedResult) != 0 {
		var result Result
		if json.Unmarshal(storedResult, &result) != nil {
			return Result{}, ErrUnavailable
		}
		return result, nil // Read original result; deferred rollback releases locks.
	}
	ids := []int64{request.ActorID, request.RecipientID}
	if ids[0] > ids[1] {
		ids[0], ids[1] = ids[1], ids[0]
	}
	result := Result{Status: "transferred"}
	for _, id := range ids {
		var locked int64
		if err = tx.QueryRow(ctx, "SELECT account_id FROM fishing.player_state WHERE account_id=$1 FOR UPDATE", id).Scan(&locked); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				result.Status = "account_not_found"
				break
			}
			return Result{}, err
		}
	}
	if result.Status == "transferred" {
		if err = tx.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", request.ActorID).Scan(&result.SenderBalance); err != nil {
			return Result{}, err
		}
		if err = tx.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", request.RecipientID).Scan(&result.RecipientBalance); err != nil {
			return Result{}, err
		}
		if result.SenderBalance < request.Amount {
			result.Status = "insufficient_funds"
		} else if result.RecipientBalance > MaxCoins-request.Amount {
			result.Status = "balance_limit"
		}
	}
	if result.Status == "transferred" {
		result.SenderBalance -= request.Amount
		result.RecipientBalance += request.Amount
		if _, err = tx.Exec(ctx, "UPDATE fishing.wallets SET coins=$2 WHERE account_id=$1", request.ActorID, result.SenderBalance); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, "UPDATE fishing.wallets SET coins=$2 WHERE account_id=$1", request.RecipientID, result.RecipientBalance); err != nil {
			return Result{}, err
		}
		if _, err = tx.Exec(ctx, "UPDATE fishing.player_state SET assets_rev=assets_rev+1 WHERE account_id=ANY($1::bigint[])", ids); err != nil {
			return Result{}, err
		}
		var operationID int64
		if err = tx.QueryRow(ctx, `INSERT INTO fishing.asset_operations(actor_id,request_key,kind,rule_version) VALUES ($1,$2,'coin_transfer',$3) RETURNING id`, request.ActorID, request.RequestKey, ruleVersion).Scan(&operationID); err != nil {
			return Result{}, err
		}
		result.OperationID = strconv.FormatInt(operationID, 10)
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.asset_entries(operation_id,account_id,delta,balance_after) VALUES ($1,$2,$3,$4),($1,$5,$6,$7)`, operationID, request.ActorID, -request.Amount, result.SenderBalance, request.RecipientID, request.Amount, result.RecipientBalance); err != nil {
			return Result{}, err
		}
		payload, _ := json.Marshal(struct {
			Sender    string `json:"sender"`
			Recipient string `json:"recipient"`
			Amount    int64  `json:"amount"`
		}{strconv.FormatInt(request.ActorID, 10), strconv.FormatInt(request.RecipientID, 10), request.Amount})
		if _, err = tx.Exec(ctx, `INSERT INTO fishing.outbox_events(operation_id,event_type,payload) VALUES ($1,'coins_transferred',$2)`, operationID, payload); err != nil {
			return Result{}, err
		}
	}
	encoded, _ := json.Marshal(result)
	if _, err = tx.Exec(ctx, "UPDATE fishing.command_results SET result=$3 WHERE actor_id=$1 AND request_key=$2", request.ActorID, request.RequestKey, encoded); err != nil {
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

// Lookup is scoped to the authenticated actor and returns the original outcome,
// including business rejections. ErrNotFound alone is not proof that an earlier
// request failed: it may still be committing; resend the same key and input.
func (s *Service) Lookup(ctx context.Context, actor int64, key string) (Result, error) {
	if actor <= 0 || !validKey(key) {
		return Result{}, ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var data []byte
	err := s.pool.QueryRow(ctx, "SELECT result FROM fishing.command_results WHERE actor_id=$1 AND request_key=$2", actor, key).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrNotFound
	}
	var result Result
	if err != nil || len(data) == 0 || json.Unmarshal(data, &result) != nil {
		return Result{}, ErrUnavailable
	}
	return result, nil
}
