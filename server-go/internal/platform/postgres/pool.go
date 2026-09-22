package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConfiguration = errors.New("invalid database configuration")
var ErrUnavailable = errors.New("database unavailable")

func poolConfig(dsn string, maxConns int32) (*pgxpool.Config, error) {
	if dsn == "" || maxConns < 1 || maxConns > 64 {
		return nil, ErrConfiguration
	}
	c, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, ErrConfiguration
	} // Driver errors can include credentials.
	c.MaxConns = maxConns
	c.MinConns = 0
	c.MinIdleConns = 0
	c.MaxConnLifetime = 30 * time.Minute
	c.MaxConnLifetimeJitter = 5 * time.Minute
	c.MaxConnIdleTime = 5 * time.Minute
	c.HealthCheckPeriod = 30 * time.Second
	c.ConnConfig.ConnectTimeout = 3 * time.Second
	c.ConnConfig.RuntimeParams["application_name"] = "fishing-go"
	c.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	c.ConnConfig.RuntimeParams["lock_timeout"] = "1000"
	c.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "10000"
	c.ConnConfig.RuntimeParams["synchronous_commit"] = "on"
	return c, nil
}

// Open checks reachability before the app starts listening. The caller bounds
// startup with a context. This does not create schema or run any migrations.
func Open(ctx context.Context, dsn string, maxConns int32) (*pgxpool.Pool, error) {
	c, err := poolConfig(dsn, maxConns)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		return nil, ErrConfiguration
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, ErrUnavailable
	}
	return pool, nil
}
