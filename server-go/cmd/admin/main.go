// admin accepts sensitive enrollment inputs only via stdin, never flags/logs.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/platform/postgres"
	"fishing.local/server/migrations"
	"fmt"
	"io"
	"os"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "administrator operation failed; inspect operator audit before retrying")
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 || (os.Args[1] != "provision" && os.Args[1] != "revoke") {
		return errors.New("invalid operation")
	}
	var in struct {
		Username string `json:"username"`
		Secret   string `json:"secret"`
		OTP      string `json:"otp"`
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 4097))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("invalid trailing input")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, os.Getenv("FISHING_GO_MIGRATION_DATABASE_URL"), 1)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := migrations.Check(ctx, pool); err != nil {
		return err
	}
	if os.Args[1] == "provision" {
		key, err := base64.StdEncoding.DecodeString(os.Getenv("FISHING_GO_MFA_KEY"))
		if err != nil || len(key) != 32 {
			return errors.New("invalid encryption key")
		}
		if err := identity.ProvisionAdmin(ctx, pool, key, in.Username, in.Secret, in.OTP); err != nil {
			return err
		}
	} else {
		if in.Secret != "" || in.OTP != "" {
			return errors.New("unexpected enrollment input")
		}
		if err := identity.RevokeAdmin(ctx, pool, in.Username); err != nil {
			return err
		}
	}
	fmt.Println("administrator operation committed; audit recorded")
	return nil
}
