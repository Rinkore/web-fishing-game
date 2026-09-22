package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"fishing.local/server/internal/modules/catalog"
	"fishing.local/server/internal/platform/httpserver"
	"fishing.local/server/internal/rules"
)

func TestIntegrationMaintenanceDrainsBothProtocols(t *testing.T) {
	f := newAdminFixture(t)
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	var expectedVersion, expectedBuild string
	if err := c.Constant("VERSION", &expectedVersion); err != nil {
		t.Fatal(err)
	}
	if err := c.Constant("BUILD", &expectedBuild); err != nil {
		t.Fatal(err)
	}
	// A normal application upgrade preserves the operator's published rules,
	// including their older metadata. HTTP and SSE must still identify the
	// installed application so clients reload and deployment probes can pass.
	c.Version = "v0.0.1"
	c.Constants["VERSION"] = json.RawMessage(`"v0.0.1"`)
	c.Constants["BUILD"] = json.RawMessage(`"1970-01-01"`)
	if c.Runtime == nil {
		c.Runtime = map[string]any{}
	}
	c.Runtime["autoSellBatch"] = float64(7)
	revision := publishLegacyCatalog(t, f, c, 0, "old-gameplay-release")
	code, body := f.call("GET", "/api/version", "", "")
	if code != 200 || body["version"] != expectedVersion || body["build"] != expectedBuild {
		t.Fatalf("application version follows old gameplay catalog: %d %v", code, body)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	health, router := httpserver.New(f.db.App, time.Second, New(f.db.App, nil))
	done := make(chan error, 1)
	go func() {
		done <- httpserver.Serve(ctx, listener, health, router, 5*time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	t.Cleanup(func() { stop(); _ = listener.Close() })
	type observed struct {
		path   string
		frames []map[string]any
		err    error
	}
	results := make(chan observed, 2)
	for _, path := range []string{"/events", "/api/v1/events"} {
		r, _ := http.NewRequest("GET", "http://"+listener.Addr().String()+path, nil)
		r.Header.Set("Authorization", "Bearer "+f.playerToken)
		res, err := (&http.Client{Timeout: 10 * time.Second}).Do(r)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		if res.StatusCode != 200 {
			t.Fatalf("stream %s: %d", path, res.StatusCode)
		}
		ready := make(chan struct{})
		go func() {
			out := observed{path: path}
			scanner := bufio.NewScanner(res.Body)
			scanner.Buffer(make([]byte, 4096), 2<<20)
			for scanner.Scan() {
				if !strings.HasPrefix(scanner.Text(), "data: ") {
					continue
				}
				var frame map[string]any
				if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &frame); err != nil {
					out.err = err
					break
				}
				out.frames = append(out.frames, frame)
				if frame["type"] == "assets" || frame["type"] == "snapshot_required" {
					select {
					case <-ready:
					default:
						close(ready)
					}
				}
			}
			if out.err == nil {
				out.err = scanner.Err()
			}
			results <- out
		}()
		select {
		case <-ready:
		case <-time.After(5 * time.Second):
			t.Fatalf("stream %s not initialized", path)
		}
	}
	stop()
	for range 2 {
		select {
		case out := <-results:
			if out.err != nil {
				t.Fatalf("stream drain %s: %v", out.path, out.err)
			}
			n := 0
			for _, frame := range out.frames {
				if out.path == "/events" && frame["type"] == "init" && frame["version"] != expectedVersion {
					t.Fatalf("init version follows old gameplay catalog: %v", frame)
				}
				if frame["type"] == "kicked" {
					t.Fatal("shutdown reported credential revocation")
				}
				if frame["type"] == "maintenance" {
					n++
					if out.path == "/events" && frame["version"] != expectedVersion {
						t.Fatalf("maintenance version: %v", frame)
					}
				}
			}
			if n != 1 || out.frames[len(out.frames)-1]["type"] != "maintenance" {
				t.Fatalf("missing final maintenance %s: %v", out.path, out.frames)
			}
		case <-time.After(7 * time.Second):
			t.Fatal("stream did not drain")
		}
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("server did not stop")
	}
	var live int
	if err := f.db.Admin.QueryRow(context.Background(), `SELECT count(*) FROM fishing.gateway_streams WHERE owner_id=$1 AND expires_at>clock_timestamp()`, f.playerID).Scan(&live); err != nil || live != 0 {
		t.Fatalf("shutdown leaked stream lease: %d %v", live, err)
	}
	stored, actualRevision, err := catalog.Current(context.Background(), f.db.App)
	if err != nil {
		t.Fatal(err)
	}
	if actualRevision != revision || stored.Version != "v0.0.1" || string(stored.Constants["VERSION"]) != `"v0.0.1"` || stored.Runtime["autoSellBatch"] != float64(7) {
		t.Fatalf("version reporting changed the operator catalog: revision=%d version=%s runtime=%v", actualRevision, stored.Version, stored.Runtime)
	}
}
