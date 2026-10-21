// Package httpx: JSON responses, the single error format, decoding, pagination and middleware.
//
// Error body (every non-2xx response):
//
//	{"error":{"code":"validation_failed","message":"...","details":{...},"requestId":"..."}}
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
)

// Error is an API error with a stable machine-readable code.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func NewError(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

func BadRequest(msg string) *Error { return NewError(http.StatusBadRequest, "bad_request", msg) }
func NotFound(what string) *Error {
	return NewError(http.StatusNotFound, "not_found", what+" not found")
}
func Conflict(msg string) *Error { return NewError(http.StatusConflict, "conflict", msg) }
func Forbidden() *Error          { return NewError(http.StatusForbidden, "forbidden", "not allowed") }
func Unauthorized() *Error {
	return NewError(http.StatusUnauthorized, "unauthenticated", "authentication required")
}
func Unprocessable(msg string) *Error {
	return NewError(http.StatusUnprocessableEntity, "invariant_violation", msg)
}

// Validation returns 422 with per-field messages: {"fields":{"amount":"must be positive"}}.
func Validation(fields map[string]string) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: "request validation failed", Details: map[string]any{"fields": fields}}
}

// WriteJSON writes v with status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

// WriteError maps err to the error format. Unknown errors become 500 and are logged.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var e *Error
	switch {
	case errors.As(err, &e):
	case errors.Is(err, authz.ErrUnauthenticated):
		e = Unauthorized()
	case errors.Is(err, authz.ErrForbidden):
		e = Forbidden()
	case errors.Is(err, authz.ErrProfileHeader):
		e = BadRequest(err.Error())
	default:
		slog.ErrorContext(r.Context(), "unhandled error", "err", err, "path", r.URL.Path, "request_id", middleware.GetReqID(r.Context()))
		e = NewError(http.StatusInternalServerError, "internal", "internal server error")
	}
	body := map[string]any{"code": e.Code, "message": e.Message, "requestId": middleware.GetReqID(r.Context())}
	if e.Details != nil {
		body["details"] = e.Details
	}
	WriteJSON(w, e.Status, map[string]any{"error": body})
}

// H adapts an error-returning handler: return nil after writing, or an error to render.
func H(fn func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			WriteError(w, r, err)
		}
	}
}

// DecodeJSON decodes a single JSON object, rejecting unknown fields and trailing data.
// Body size is bounded by the MaxBody middleware.
func DecodeJSON(r *http.Request, v any) error {
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/json") {
		return NewError(http.StatusUnsupportedMediaType, "unsupported_media_type", "expected application/json")
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "request body too large")
		}
		return BadRequest(fmt.Sprintf("invalid JSON body: %v", err))
	}
	if dec.Decode(&struct{}{}) != io.EOF {
		return BadRequest("invalid JSON body: trailing data")
	}
	return nil
}

// NotFoundHandler / MethodNotAllowedHandler keep the error format for unknown routes.
func NotFoundHandler(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError(http.StatusNotFound, "route_not_found", "no such endpoint"))
}

func MethodNotAllowedHandler(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
}
