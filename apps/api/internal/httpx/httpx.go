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
	"regexp"
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

// Validation returns 422 with per-field messages: {"fields":{"amount":"must be positive"}}, plus
// {"fieldCodes":{"amount":{"code":"positive"}}} for the messages of the common validators, so clients
// can show them in the UI language (web: error.field.<code>). Bespoke messages have no code.
func Validation(fields map[string]string) *Error {
	details := map[string]any{"fields": fields}
	codes := map[string]FieldCode{}
	for f, msg := range fields {
		if c, ok := fieldCode(msg); ok {
			codes[f] = c
		}
	}
	if len(codes) > 0 {
		details["fieldCodes"] = codes
	}
	return &Error{Status: http.StatusUnprocessableEntity, Code: "validation_failed", Message: "request validation failed", Details: details}
}

// FieldCode is the translatable form of a field message.
type FieldCode struct {
	Code   string            `json:"code"`
	Params map[string]string `json:"params,omitempty"`
}

// fieldRules map the validators' English messages to codes; submatches become params (names in order).
var fieldRules = []struct {
	re     *regexp.Regexp
	code   string
	params []string
}{
	{regexp.MustCompile(`^required(?: on update)?$`), "required", nil},
	{regexp.MustCompile(`^required, at most (\d+) characters$`), "required_max_length", []string{"max"}},
	{regexp.MustCompile(`^at most (\d+) characters$`), "max_length", []string{"max"}},
	{regexp.MustCompile(`^(\d+)-(\d+) characters$`), "length", []string{"min", "max"}},
	{regexp.MustCompile(`^too long$`), "too_long", nil},
	{regexp.MustCompile(`^too large$`), "too_large", nil},
	{regexp.MustCompile(`^(?:invalid uuid|uuid)$`), "invalid_id", nil},
	{regexp.MustCompile(`^(?:required |expected |must be )?YYYY-MM-DD$`), "invalid_date", nil},
	{regexp.MustCompile(`^unknown (?:ISO 4217 )?currency$`), "unknown_currency", nil},
	{regexp.MustCompile(`^(?:must be positive|required and positive)$`), "positive", nil},
	{regexp.MustCompile(`^must not be zero$`), "not_zero", nil},
	{regexp.MustCompile(`^expected a decimal string$`), "invalid_decimal", nil},
	{regexp.MustCompile(`^invalid email address$`), "invalid_email", nil},
	{regexp.MustCompile(`^unknown (?:account|category|transaction|tag|merchant|budget|plan|rule|importer|recurrence|goal|subscription)$`), "unknown_reference", nil},
	{regexp.MustCompile(`^must not be before (\w+)$`), "not_before", []string{"other"}},
	{regexp.MustCompile(`^must be in the future$`), "future", nil},
	{regexp.MustCompile(`^range is limited to (\d+) days$`), "max_days", []string{"max"}},
	{regexp.MustCompile(`^unknown IANA time zone$`), "invalid_timezone", nil},
	{regexp.MustCompile(`^invalid locale$`), "invalid_locale", nil},
	// "a, b or c" / "one of a, b, c": options are API values (not translated).
	{regexp.MustCompile(`^(?:one of )?((?:[a-z0-9_]+, )*[a-z0-9_]+) or ([a-z0-9_]+)$`), "one_of", []string{"options", "last"}},
	{regexp.MustCompile(`^one of ((?:[a-z0-9_]+, )+[a-z0-9_]+)$`), "one_of", []string{"options"}},
}

func fieldCode(msg string) (FieldCode, bool) {
	for _, r := range fieldRules {
		m := r.re.FindStringSubmatch(msg)
		if m == nil || (r.code == "one_of" && strings.HasPrefix(msg, "required")) {
			continue
		}
		c := FieldCode{Code: r.code}
		for i, name := range r.params {
			if c.Params == nil {
				c.Params = map[string]string{}
			}
			c.Params[name] = m[i+1]
		}
		if last, ok := c.Params["last"]; ok { // one_of: a single comma-separated list
			c.Params["options"] += ", " + last
			delete(c.Params, "last")
		}
		return c, true
	}
	return FieldCode{}, false
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
