package migration

import (
	"time"

	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// RealAccount is a private offline source record. Never serialize it to a
// public report or include its key or payload in returned errors.
type RealAccount struct {
	Key     string
	Payload map[string]any
}

// RealContext shares one atomic import transaction across domain mappers.
// Root contains only the operator-prepared offline snapshot and SQLite export.
type RealContext struct {
	Tx      pgx.Tx
	Catalog *rules.Catalog
	IDs     map[string]int64
	RunID   string
	Now     time.Time
	MFAKey  []byte
	Root    string
}
