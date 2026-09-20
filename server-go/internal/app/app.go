// Package app composes infrastructure and, later, explicit gameplay modules.
package app

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"sync"

	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/platform/config"
	"fishing.local/server/internal/platform/httpserver"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dependencies struct{ pool *pgxpool.Pool }

func (d dependencies) Ping(ctx context.Context) error {
	if err := d.pool.Ping(ctx); err != nil {
		return err
	}
	return migrations.Check(ctx, d.pool)
}

func Run(ctx context.Context, c config.Config, logger *slog.Logger) error {
	startup, cancel := context.WithTimeout(ctx, c.StartupTimeout)
	pool, err := postgres.Open(startup, c.DatabaseURL, c.DatabaseMaxConns)
	if err != nil {
		cancel()
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer pool.Close()
	err = migrations.Check(startup, pool)
	cancel()
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	listener, err := net.Listen("tcp", c.ListenAddress)
	if err != nil {
		return errors.New("HTTP listen address unavailable")
	}
	defer listener.Close()
	health, handler := httpserver.New(dependencies{pool}, c.ProbeTimeout)
	work, stopWork := context.WithCancel(ctx)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); fishing.New(pool).Run(work, logger) }()
	go func() { defer workers.Done(); market.New(pool).RunExpiry(work, logger) }()
	defer func() { stopWork(); workers.Wait() }()
	logger.Info("server_started", "address", listener.Addr().String(), "role", c.Role, "node_id", c.NodeID, "stage", "infrastructure")
	return httpserver.Serve(ctx, listener, health, handler, c.ShutdownTimeout, logger)
}
