package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/migrations"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if len(os.Args) != 2 || os.Args[1] != "up" {
		logger.Error("usage: migrate up")
		os.Exit(2)
	}
	dsn := os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL")
	if dsn == "" {
		logger.Error("FISHING_GO_MIGRATION_DATABASE_URL is required")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := postgres.Open(ctx, dsn, 1)
	if err == nil {
		defer pool.Close()
		err = migrations.Apply(ctx, pool)
	}
	if err != nil {
		logger.Error("schema_update_failed", "reason", err.Error())
		os.Exit(1)
	}
	logger.Info("schema_updated")
}
