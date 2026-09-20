package prototype_test

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"testing"
	"time"

	"fishing.local/server/internal/app"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/platform/config"
	"fishing.local/server/internal/rules"
)

func TestIntegrationAllRuntimeRunsAndDrainsPrototypeWorkers(t *testing.T) {
	f := setup(t)
	owner := f.player()
	c := f.start(owner, "caught-v1", false)
	f.due(c)
	catalog, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	if err = workshop.SeedDefinitions(f.ctx, f.db.Admin, catalog); err != nil {
		t.Fatal(err)
	}
	nativeOwner := f.player()
	nativeCast, err := fishing.NewNative(f.db.App, catalog).Start(f.ctx, fishing.NativeStart{ActorID: nativeOwner, RequestKey: f.key(), ConnectionGeneration: f.connect(nativeOwner), GroundID: "map", SpotID: "dock"})
	f.want(nativeCast, err, "started")
	f.exec(`UPDATE fishing.native_fishing_sessions SET due_at=clock_timestamp()-interval '1 second' WHERE owner_id=$1`, nativeOwner)
	seller := f.player()
	f.reward(seller, 0, 1)
	lot := f.lot(seller, 1, 0, 10, 100*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var logs bytes.Buffer
	// pgx retains its original ConnString after Config fields are changed. Build
	// the URL from the actual isolated database/restricted login, not bootstrap.
	cc := f.db.App.Config().ConnConfig
	dsn := url.URL{Scheme: "postgres", User: url.UserPassword(cc.User, cc.Password), Host: net.JoinHostPort(cc.Host, strconv.Itoa(int(cc.Port))), Path: "/" + cc.Database, RawQuery: "sslmode=disable"}
	cfg := config.Config{DatabaseURL: dsn.String(), DatabaseMaxConns: 8, ListenAddress: "127.0.0.1:0", Role: "all", NodeID: "prototype-test", StartupTimeout: 5 * time.Second, ProbeTimeout: time.Second, ShutdownTimeout: time.Second}
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx, cfg, slog.New(slog.NewJSONHandler(&logs, nil))) }()
	deadline := time.Now().Add(7 * time.Second)
	for {
		select {
		case err := <-done:
			t.Fatalf("runtime exited early: %v", err)
		default:
		}
		if f.num(`SELECT count(*) FROM fishing.fishing_settlements WHERE session_id=$1`, c.SessionID) > 0 && f.num(`SELECT count(*) FROM fishing.market_listings WHERE id=$1 AND state='expired'`, lot) == 1 && f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime workers did not execute pending work")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runtime did not drain workers")
	}
	before := f.num(`SELECT count(*) FROM fishing.fishing_settlements`)
	nativeBefore := f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`)
	time.Sleep(150 * time.Millisecond)
	if f.num(`SELECT count(*) FROM fishing.fishing_settlements`) != before || f.num(`SELECT count(*) FROM fishing.native_fishing_settlements`) != nativeBefore {
		t.Fatal("worker remained active after shutdown")
	}
	if f.qty(seller) != 1 {
		t.Fatal("expiry worker did not restore stock")
	}
	if bytes.Contains(logs.Bytes(), []byte("postgres://")) || bytes.Contains(logs.Bytes(), []byte("private_seed")) {
		t.Fatal("runtime logged private configuration")
	}
	f.reconcile()
}
