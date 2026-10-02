// reset hands a running installation a fresh save: it clears player data, keeps
// the schema, privileges, migration ledger and the published operator
// configuration (rules, prices, drops, mall, feature flags, settings), and
// restores the built-in item definitions and official wiki content. Dropping
// the database would lose the runtime role grants, so this command is the
// supported reset path.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"fishing.local/server/internal/app"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/migrations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fresh save reset failed:", err.Error())
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	if len(args) == 0 || args[0] != "fresh" {
		return errors.New("usage: reset fresh [--confirm]")
	}
	confirm := false
	for _, arg := range args[1:] {
		if arg != "--confirm" {
			return errors.New("usage: reset fresh [--confirm]")
		}
		confirm = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pool, err := postgres.Open(ctx, os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL"), 1)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := migrations.Check(ctx, pool); err != nil {
		return err
	}
	if !confirm {
		plan, err := app.PlanFreshSave(ctx, pool)
		if err != nil {
			return err
		}
		if err := writeSummary(plan); err != nil {
			return err
		}
		fmt.Println("dry run: no rows were deleted; stop the game, back up the database, then rerun with --confirm")
		return nil
	}
	summary, err := app.FreshSave(ctx, pool)
	if err != nil {
		return err
	}
	if err := writeSummary(summary); err != nil {
		return err
	}
	fmt.Println("fresh save applied; provision an administrator with cmd/admin before starting the game")
	return nil
}

func writeSummary(summary app.FreshSaveSummary) error {
	raw, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(append(raw, '\n'))
	return err
}
