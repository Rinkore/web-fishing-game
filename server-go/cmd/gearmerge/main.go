// Command gearmerge drives the phase-1 merge of the retired gear_*_2..5 base
// ids into their canonical gear_*_1 base. See internal/gearmerge.
//
// Usage:
//
//	gearmerge publish [-actor <admin account id>]
//	gearmerge migrate [-dry-run]
//	gearmerge verify
//
// Env: FISHING_GO_MIGRATION_DATABASE_URL
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"fishing.local/server/internal/gearmerge"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	var err error
	switch os.Args[1] {
	case "publish":
		err = runPublish(ctx, os.Args[2:])
	case "migrate":
		err = runMigrate(ctx, os.Args[2:])
	case "verify":
		err = runVerify(ctx)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "gearmerge failed:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: gearmerge publish [-actor <admin account id>] | migrate [-dry-run] | verify")
	fmt.Fprintln(os.Stderr, "env: FISHING_GO_MIGRATION_DATABASE_URL")
	os.Exit(2)
}

func connect(ctx context.Context) (*pgxpool.Pool, error) {
	dsn := os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL")
	if dsn == "" {
		return nil, fmt.Errorf("FISHING_GO_MIGRATION_DATABASE_URL not set")
	}
	pool, err := postgres.Open(ctx, dsn, 2)
	if err != nil {
		return nil, err
	}
	if err := gearmerge.Check(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func runPublish(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("publish", flag.ExitOnError)
	actor := fs.Int64("actor", 0, "admin account id recorded as the publisher")
	_ = fs.Parse(args)
	if *actor <= 0 {
		return fmt.Errorf("-actor is required")
	}
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	c, err := rules.Default()
	if err != nil {
		return err
	}
	version, err := gearmerge.Publish(ctx, pool, *actor)
	if err != nil {
		return err
	}
	fmt.Println("catalog release published:", version, "aliases:", len(gearmerge.Aliases(c)))
	return nil
}

func runMigrate(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	dry := fs.Bool("dry-run", false, "report planned changes without writing")
	_ = fs.Parse(args)
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	c, err := rules.Default()
	if err != nil {
		return err
	}
	s, err := gearmerge.Migrate(ctx, pool, c, *dry)
	if err != nil {
		return err
	}
	verb := "migrated"
	if *dry {
		verb = "dry-run:"
	}
	fmt.Printf("%s %d instances, %d mail attachments, %d codex rows\n", verb, s.Instances, s.Mail, s.Codex)
	return nil
}

func runVerify(ctx context.Context) error {
	pool, err := connect(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	c, err := rules.Default()
	if err != nil {
		return err
	}
	s, err := gearmerge.Remaining(ctx, pool, c)
	if err != nil {
		return err
	}
	if s.Instances+s.Mail+s.Codex > 0 {
		return fmt.Errorf("%d instances, %d mail attachments, %d codex rows still reference retired bases", s.Instances, s.Mail, s.Codex)
	}
	fmt.Println("clean: no alias references remain; phase 2 (drop aliases + definitions) is safe")
	return nil
}
