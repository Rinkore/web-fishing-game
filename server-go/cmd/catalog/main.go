package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/internal/rules"
	"fishing.local/server/migrations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "catalog publication failed")
		os.Exit(1)
	}
}
func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if len(os.Args) != 2 || os.Args[1] != "defaults" {
		return fmt.Errorf("usage: catalog defaults")
	}
	p, err := postgres.Open(ctx, os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL"), 1)
	if err != nil {
		return err
	}
	defer p.Close()
	if err := migrations.Check(ctx, p); err != nil {
		return err
	}
	c, err := rules.Default()
	if err != nil {
		return err
	}
	if err := workshop.SeedDefinitions(ctx, p, c); err != nil {
		return err
	}
	fmt.Println("default catalog definitions published:", c.Version, c.SourceSHA256)
	return nil
}
