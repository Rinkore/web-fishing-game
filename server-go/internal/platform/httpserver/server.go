package httpserver

import (
	"context"
	"errors"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
)

type Pinger interface{ Ping(context.Context) error }

var errDraining = errors.New("server draining")

// IsDraining distinguishes an orderly shutdown from a disconnected client.
// Streams may flush a final frame while the transport remains open.
func IsDraining(ctx context.Context) bool { return errors.Is(context.Cause(ctx), errDraining) }

type safeErrorWriter struct{ logger *slog.Logger }

func (w safeErrorWriter) Write(p []byte) (int, error) {
	// net/http may log request bytes or panic values. Emit an observable category
	// while keeping secrets and attacker-controlled strings out of application logs.
	w.logger.Error("http_transport_error")
	return len(p), nil
}

type Health struct {
	db        Pinger
	timeout   time.Duration
	draining  atomic.Bool
	probeSlot chan struct{}
}

func New(db Pinger, timeout time.Duration, application ...http.Handler) (*Health, http.Handler) {
	h := &Health{db: db, timeout: timeout, probeSlot: make(chan struct{}, 1)}
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, `{"status":"alive"}`) })
	r.Get("/readyz", h.ready)
	if len(application) > 0 && application[0] != nil {
		r.Mount("/", application[0])
	}
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { respond(w, 404, `{"error":"not_found"}`) })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) { respond(w, 405, `{"error":"method_not_allowed"}`) })
	return h, r
}

func (h *Health) Drain() { h.draining.Store(true) }

func (h *Health) ready(w http.ResponseWriter, r *http.Request) {
	if h.draining.Load() {
		respond(w, 503, `{"status":"draining"}`)
		return
	}
	// Bound health-probe concurrency, even if many callers poll during an outage.
	select {
	case h.probeSlot <- struct{}{}:
		defer func() { <-h.probeSlot }()
	default:
		respond(w, 503, `{"status":"unavailable"}`)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	if h.db.Ping(ctx) != nil {
		respond(w, 503, `{"status":"unavailable"}`)
		return
	}
	if h.draining.Load() {
		respond(w, 503, `{"status":"draining"}`)
		return
	}
	respond(w, 200, `{"status":"ready","scope":"infrastructure"}`)
}

func respond(w http.ResponseWriter, code int, body string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, body+"\n")
}

// Serve owns the listener and drains active requests before returning. There
// Streaming handlers reset their own write deadlines. BaseContext cancels
// streams during draining so they cannot indefinitely block shutdown.
func Serve(ctx context.Context, listener net.Listener, health *Health, handler http.Handler, shutdownTimeout time.Duration, logger *slog.Logger) error {
	requests, cancelRequests := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancelRequests(context.Canceled)
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
		ErrorLog: log.New(safeErrorWriter{logger}, "", 0)}
	server.BaseContext = func(net.Listener) context.Context { return requests }
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		health.Drain()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return errors.New("HTTP listener failed")
	case <-ctx.Done():
		health.Drain()
		cancelRequests(errDraining)
		logger.Info("shutdown_started")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			<-done
			return errors.New("HTTP shutdown deadline exceeded")
		}
		<-done
		logger.Info("shutdown_complete")
		return nil
	}
}
