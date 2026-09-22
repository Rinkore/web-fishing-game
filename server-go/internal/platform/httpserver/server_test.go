package httpserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTransportLogsDoNotEchoRawErrors(t *testing.T) {
	var buffer bytes.Buffer
	w := safeErrorWriter{slog.New(slog.NewJSONHandler(&buffer, nil))}
	_, _ = w.Write([]byte("panic SECRET_PASSWORD request COOKIE_SECRET"))
	if strings.Contains(buffer.String(), "SECRET") || !strings.Contains(buffer.String(), "http_transport_error") {
		t.Fatal("error not safely observable")
	}
}

func TestShutdownCancelsStreamingRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h, _ := New(pingFunc(func(context.Context) error { return nil }), time.Second)
	started, handlerDone := make(chan struct{}), make(chan struct{})
	draining := make(chan bool, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		draining <- IsDraining(r.Context())
		close(handlerDone)
	})
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- Serve(ctx, listener, h, handler, 50*time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		client := &http.Client{Timeout: 2 * time.Second}
		res, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			res.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal("cooperative stream did not drain")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown hung")
	}
	select {
	case <-handlerDone:
	case <-time.After(time.Second):
		t.Fatal("active request context not cancelled")
	}
	<-clientDone
	if !<-draining {
		t.Fatal("shutdown was not distinguished from client cancellation")
	}
}

func TestShutdownDeadlineForNonCooperativeHandler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h, _ := New(pingFunc(func(context.Context) error { return nil }), time.Second)
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { close(started); <-release })
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, listener, h, handler, 50*time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	client := &http.Client{Timeout: time.Second}
	go func() {
		res, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			_ = res.Body.Close()
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("missing shutdown deadline")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown hung")
	}
}

type pingFunc func(context.Context) error

func (f pingFunc) Ping(ctx context.Context) error { return f(ctx) }

func TestLivenessReadinessAndDrain(t *testing.T) {
	for _, broken := range []bool{false, true} {
		h, router := New(pingFunc(func(context.Context) error {
			if broken {
				return errors.New("SECRET_DSN")
			}
			return nil
		}), time.Second)
		for _, tc := range []struct {
			method, path string
			code         int
		}{
			{"GET", "/healthz", 200}, {"GET", "/missing", 404}, {"POST", "/readyz", 405},
		} {
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			if w.Code != tc.code || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("unexpected HTTP contract", tc.path, w.Code)
			}
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
		want := 200
		if broken {
			want = 503
		}
		if w.Code != want || strings.Contains(w.Body.String(), "SECRET_DSN") {
			t.Fatal("readiness incorrectly reported or leaked credentials")
		}
		h.Drain()
		w = httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
		if w.Code != 503 {
			t.Fatal("draining server remained ready")
		}
	}
}

func TestProbeTimeoutAndConcurrencyBound(t *testing.T) {
	entered := make(chan struct{})
	_, router := New(pingFunc(func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }), 100*time.Millisecond)
	done := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
		done <- w.Code
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("probe did not start")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
	if w.Code != 503 {
		t.Fatal("concurrent probe not rejected")
	}
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 {
		t.Fatal("database outage changed liveness")
	}
	select {
	case code := <-done:
		if code != 503 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("probe ignored timeout")
	}
}

func TestShutdownDrainsInflightRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h, _ := New(pingFunc(func(context.Context) error { return nil }), time.Second)
	started, release := make(chan struct{}), make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "finished")
	})
	serverDone := make(chan error, 1)
	go func() {
		serverDone <- Serve(ctx, listener, h, handler, 2*time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	clientDone := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 3 * time.Second}
		res, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			defer res.Body.Close()
			body, readErr := io.ReadAll(res.Body)
			err = readErr
			if string(body) != "finished" {
				err = errors.New("response lost")
			}
		}
		clientDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for !h.draining.Load() {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("shutdown did not mark unready")
		}
	}
	select {
	case <-serverDone:
		t.Fatal("server exited before active request finished")
	default:
	}
	close(release)
	if err := <-clientDone; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown hung")
	}
}
