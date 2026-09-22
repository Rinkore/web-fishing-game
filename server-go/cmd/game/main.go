package main

import (
	"context"
	"flag"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"fishing.local/server/internal/app"
	"fishing.local/server/internal/platform/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	flags := flag.NewFlagSet("game", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	role := flags.String("role", "", "startup role (currently all only)")
	if err := flags.Parse(os.Args[1:]); err != nil || flags.NArg() != 0 {
		logger.Error("invalid_arguments")
		os.Exit(2)
	}
	c, err := config.Load(func(key string) string {
		if key == "FISHING_GO_ROLE" && *role != "" {
			return *role
		}
		return os.Getenv(key)
	})
	if err != nil {
		logger.Error("configuration_rejected", "reason", err.Error())
		os.Exit(1)
	}
	if c.FrontendDir == "" {
		if _, statErr := os.Stat("frontend"); statErr == nil {
			c.FrontendDir = "frontend"
		} else {
			c.FrontendDir = "../frontend"
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err = app.Run(ctx, c, logger)
	stop()
	if err != nil {
		logger.Error("server_stopped", "reason", err.Error())
		os.Exit(1)
	}
}
