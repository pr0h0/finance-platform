package httpx

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

type rawBodyKey struct{}

// MaxBody bounds request bodies. Upload endpoints use UploadBody for their own larger limit.
func MaxBody(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(context.WithValue(r.Context(), rawBodyKey{}, r.Body))
			r.Body = http.MaxBytesReader(w, r.Body, n)
			next.ServeHTTP(w, r)
		})
	}
}

// UploadBody replaces the MaxBody limit with n for this request (file uploads).
func UploadBody(w http.ResponseWriter, r *http.Request, n int64) {
	if raw, ok := r.Context().Value(rawBodyKey{}).(io.ReadCloser); ok {
		r.Body = raw
	}
	r.Body = http.MaxBytesReader(w, r.Body, n)
}

// AccessLog logs one line per request. Never logs bodies, query strings or headers.
func AccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			log.InfoContext(r.Context(), "http", "method", r.Method, "path", r.URL.Path, "status", ww.Status(),
				"bytes", ww.BytesWritten(), "dur_ms", time.Since(start).Milliseconds(), "request_id", middleware.GetReqID(r.Context()))
		})
	}
}

// Recoverer turns panics into 500 JSON errors.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if v := recover(); v != nil && v != http.ErrAbortHandler {
					log.ErrorContext(r.Context(), "panic", "panic", v, "stack", string(debug.Stack()), "request_id", middleware.GetReqID(r.Context()))
					WriteError(w, r, NewError(http.StatusInternalServerError, "internal", "internal server error"))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
