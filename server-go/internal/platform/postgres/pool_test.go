package postgres

import (
	"context"
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

func TestPoolBudgetsOverrideUnboundedDSNSettings(t *testing.T) {
	c, err := poolConfig("postgres://test:test@127.0.0.1:5432/test?sslmode=disable&pool_max_conns=500&pool_min_idle_conns=200&statement_timeout=0&synchronous_commit=off", 3)
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxConns != 3 || c.MinConns != 0 || c.MinIdleConns != 0 || c.ConnConfig.ConnectTimeout != 3*time.Second {
		t.Fatal("connection budget not applied")
	}
	for key, want := range map[string]string{"statement_timeout": "5000", "lock_timeout": "1000", "idle_in_transaction_session_timeout": "10000", "synchronous_commit": "on"} {
		if c.ConnConfig.RuntimeParams[key] != want {
			t.Error("incorrect", key)
		}
	}
}

func TestInvalidDSNDoesNotExposeCredentials(t *testing.T) {
	_, err := poolConfig("postgres://SECRET:SECRET@host:invalid/db", 1)
	if !errors.Is(err, ErrConfiguration) {
		t.Fatal("expected sanitized configuration failure")
	}
}

func TestUnavailableDatabaseFailsWithinContext(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close() // TCP accepts a connection but deliberately never speaks PostgreSQL.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err = Open(ctx, "postgres://test:test@"+l.Addr().String()+"/test?sslmode=disable", 1)
	if !errors.Is(err, ErrUnavailable) || time.Since(started) > 2*time.Second {
		t.Fatal("startup not bounded or error not sanitized")
	}
}

func TestIntegrationDatabaseSettingsAndCancellation(t *testing.T) {
	dsn := os.Getenv("FISHING_GO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated PostgreSQL via FISHING_GO_TEST_DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := Open(ctx, dsn, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for setting, want := range map[string]string{"statement_timeout": "5s", "lock_timeout": "1s", "idle_in_transaction_session_timeout": "10s", "synchronous_commit": "on"} {
		var got string
		if err := pool.QueryRow(ctx, "SELECT current_setting($1)", setting).Scan(&got); err != nil {
			t.Fatal("cannot read DB setting")
		}
		if got != want {
			t.Error("wrong database setting", setting)
		}
	}
	queryCtx, stop := context.WithTimeout(ctx, 50*time.Millisecond)
	defer stop()
	if _, err := pool.Exec(queryCtx, "SELECT pg_sleep(10)"); err == nil {
		t.Fatal("query ignored deadline")
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatal("pool did not recover after cancelled query")
	}
}
