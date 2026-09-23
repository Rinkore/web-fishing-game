// Package app composes infrastructure and, later, explicit gameplay modules.
package app

import (
	"context"
	"errors"
	"fishing.local/server/internal/gateway"
	"log/slog"
	"net"
	"sync"

	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/mail"
	"fishing.local/server/internal/modules/market"
	"fishing.local/server/internal/modules/operations"
	"fishing.local/server/internal/modules/trade"
	"fishing.local/server/internal/platform/config"
	"fishing.local/server/internal/platform/httpserver"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/internal/rules"
	"fishing.local/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dependencies struct{ pool *pgxpool.Pool }

func (d dependencies) Ping(ctx context.Context) error {
	if err := d.pool.Ping(ctx); err != nil {
		return err
	}
	if err := migrations.Check(ctx, d.pool); err != nil {
		return err
	}
	return checkCatalogDefinitions(ctx, d.pool)
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
	err = (dependencies{pool}).Ping(startup)
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
	proxy := httpserver.ProxyPolicy{TrustedIPs: c.TrustedProxyIPs, RequireHTTPS: c.RequireHTTPS, CookieNamespace: c.CookieNamespace}
	health, handler := httpserver.New(dependencies{pool}, c.ProbeTimeout, proxy.Wrap(gateway.NewWithFrontend(pool, c.MFAEncryptionKey, c.Location, c.FrontendDir)))
	catalog, err := rules.Default()
	if err != nil {
		return errors.New("default catalog unavailable")
	}
	work, stopWork := context.WithCancel(ctx)
	var workers sync.WaitGroup
	workers.Add(9)
	go func() { defer workers.Done(); mail.New(pool, nil).Run(work, logger) }()
	go func() { defer workers.Done(); fishing.New(pool).Run(work, logger) }()
	go func() { defer workers.Done(); fishing.NewLiveNative(pool, c.Location).Run(work, logger) }()
	go func() { defer workers.Done(); market.New(pool).RunExpiry(work, logger) }()
	go func() { defer workers.Done(); market.New(pool).RunSupply(work, catalog, logger) }()
	go func() { defer workers.Done(); trade.New(pool).Run(work, logger) }()
	go func() { defer workers.Done(); economy.New(pool, catalog).Run(work, logger) }()
	// Operator console upkeep: timed bans expire and the overview heat map keeps
	// sampling the server.
	go func() { defer workers.Done(); identity.New(pool, c.MFAEncryptionKey).RunBanExpiry(work, logger) }()
	go func() { defer workers.Done(); operations.New(pool).RunStatsSampler(work, logger) }()
	defer func() { stopWork(); workers.Wait() }()
	logger.Info("server_started", "address", listener.Addr().String(), "role", c.Role, "node_id", c.NodeID, "stage", "infrastructure")
	return httpserver.Serve(ctx, listener, health, handler, c.ShutdownTimeout, logger)
}
