// Package randomintent persists private command entropy before asset execution.
package randomintent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"github.com/jackc/pgx/v5/pgxpool"
	"strings"
)

func Load(ctx context.Context, pool *pgxpool.Pool, actor int64, key string, input any) ([]byte, error) {
	if actor < 1 || len(key) < 1 || len(key) > 128 {
		return nil, assets.ErrInvalid
	}
	for _, prefix := range []string{"fishing:", "market:", "trade:", "autosell:"} {
		if strings.HasPrefix(key, prefix) {
			return nil, assets.ErrInvalid
		}
	}
	for _, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == ':') {
			return nil, assets.ErrInvalid
		}
	}
	body, err := json.Marshal(input)
	if err != nil || len(body) > 16384 {
		return nil, assets.ErrInvalid
	}
	hash := sha256.Sum256(body)
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, assets.ErrUnavailable
	}
	if _, err := pool.Exec(ctx, `INSERT INTO fishing.random_intents(owner_id,request_key,input_hash,private_seed) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, actor, key, hash[:], seed); err != nil {
		return nil, assets.ErrUnavailable
	}
	var storedHash, storedSeed []byte
	if err := pool.QueryRow(ctx, `SELECT input_hash,private_seed FROM fishing.random_intents WHERE owner_id=$1 AND request_key=$2`, actor, key).Scan(&storedHash, &storedSeed); err != nil {
		return nil, assets.ErrUnavailable
	}
	if !bytes.Equal(hash[:], storedHash) {
		return nil, assets.ErrKeyConflict
	}
	return storedSeed, nil
}
