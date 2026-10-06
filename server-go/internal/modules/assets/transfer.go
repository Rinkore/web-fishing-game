// Package assets owns wallets, inventory, equipment and their accounting records.
// There is deliberately no public transfer HTTP endpoint: authentication,
// permissions, fees and gameplay transfer rules are not implemented here.
package assets

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const MaxCoins int64 = 9007199254740991
const ruleVersion = "coin-transfer-v1"

var ErrInvalid = errors.New("invalid asset command")
var ErrKeyConflict = errors.New("request key reused with different input")
var ErrUnavailable = errors.New("asset storage unavailable; retry with the same request key")
var ErrCommitUnknown = errors.New("commit outcome unknown; query or retry with the same request key")
var ErrNotFound = errors.New("request result not found")

// ErrDeferred rolls back without caching a terminal result (e.g. not due yet).
var ErrDeferred = errors.New("command is not ready; retry the same candidate")

type Transfer struct {
	ActorID     int64
	RecipientID int64
	Amount      int64
	RequestKey  string
}

type Result struct {
	Status           string          `json:"status"`
	OperationID      string          `json:"operationId,omitempty"`
	SenderBalance    int64           `json:"senderBalance"`
	RecipientBalance int64           `json:"recipientBalance"`
	EquipmentIDs     []string        `json:"equipmentIds,omitempty"`
	ResourceID       string          `json:"resourceId,omitempty"`
	Generation       int64           `json:"generation,omitempty,string"`
	Sequence         int64           `json:"sequence,omitempty,string"`
	Details          json.RawMessage `json:"details,omitempty"`
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

// Automatic commands have deterministic keys. Ordinary commands must not be
// able to occupy those keys and permanently block a cycle or escrow return.
func systemKind(key string) string {
	if strings.HasPrefix(key, "fishing:zone-evict:") {
		return "fishing_stop"
	}
	if strings.HasPrefix(key, "fishing:native-settle:") {
		return "fishing_settle"
	}
	if strings.HasPrefix(key, "autosell:run:") {
		return "autosell_run"
	}
	if strings.HasPrefix(key, "fishing:settle:") {
		return "fishing_settle"
	}
	if strings.HasPrefix(key, "market:expire:") {
		return "market_close"
	}
	if strings.HasPrefix(key, "market:order-expire:") {
		return "market_close"
	}
	if strings.HasPrefix(key, "trade:expire:") {
		return "trade_expire"
	}
	if strings.HasPrefix(key, "house:settle:") {
		return "house_settle"
	}
	if strings.HasPrefix(key, "habitat:auto:") {
		return "fish_breeding"
	}
	return ""
}
func validRequestKey(key string) bool { return validKey(key) && systemKind(key) == "" }

// TransferCoins trusts the caller's authenticated ActorID. Every attempt uses
// the same input/key. Only DB-confirmed deadlocks/serialization aborts retry;
// an uncertain COMMIT is never blindly re-executed under a new business key.
func (s *Service) TransferCoins(ctx context.Context, request Transfer) (Result, error) {
	if request.ActorID <= 0 || request.RecipientID <= 0 || request.ActorID == request.RecipientID || request.Amount < 1 || request.Amount > MaxCoins || !validRequestKey(request.RequestKey) {
		return Result{}, ErrInvalid
	}
	// Preserve v1 fingerprints so previously committed keys replay after upgrade.
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d:%d", ruleVersion, request.ActorID, request.RecipientID, request.Amount)))
	return s.execute(ctx, command{request.ActorID, request.RequestKey, "coin_transfer", ruleVersion, hash[:], []int64{request.ActorID, request.RecipientID}}, func(ctx context.Context, u *assetTx) (Result, error) {
		r := Result{Status: "transferred"}
		if err := u.tx.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", request.ActorID).Scan(&r.SenderBalance); err != nil {
			return Result{}, err
		}
		if err := u.tx.QueryRow(ctx, "SELECT coins FROM fishing.wallets WHERE account_id=$1", request.RecipientID).Scan(&r.RecipientBalance); err != nil {
			return Result{}, err
		}
		if r.SenderBalance < request.Amount {
			return r, rejection("insufficient_funds")
		}
		if r.RecipientBalance > MaxCoins-request.Amount {
			return r, rejection("balance_limit")
		}
		if err := u.coins(ctx, request.ActorID, -request.Amount); err != nil {
			return Result{}, err
		}
		if err := u.coins(ctx, request.RecipientID, request.Amount); err != nil {
			return Result{}, err
		}
		r.SenderBalance -= request.Amount
		r.RecipientBalance += request.Amount
		u.eventPayload, _ = json.Marshal(struct {
			Sender    string `json:"sender"`
			Recipient string `json:"recipient"`
			Amount    int64  `json:"amount"`
		}{strconv.FormatInt(request.ActorID, 10), strconv.FormatInt(request.RecipientID, 10), request.Amount})
		return r, nil
	})
}

func retryable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
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
