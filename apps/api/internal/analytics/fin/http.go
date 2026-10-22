package fin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// DecodePatch implements merge-patch semantics for PATCH endpoints whose body is the create input:
// `into` (a pointer) is first filled from the current API representation (fields sharing a JSON
// name), then overlaid with the request body. The body is validated strictly (unknown fields,
// trailing data) exactly like httpx.DecodeJSON.
func DecodePatch(r *http.Request, current any, into any) error {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "request body too large")
		}
		return httpx.BadRequest("could not read body")
	}
	probe := r.Clone(r.Context())
	probe.Body = io.NopCloser(bytes.NewReader(body))
	if err := httpx.DecodeJSON(probe, reflect.New(reflect.TypeOf(into).Elem()).Interface()); err != nil {
		return err
	}
	cur, err := json.Marshal(current)
	if err != nil {
		return err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(cur, &m); err != nil {
		return err
	}
	delete(m, "version") // the client must send the version it edited
	cur, _ = json.Marshal(m)
	_ = json.Unmarshal(cur, into) // lenient: read-only fields of the representation are ignored
	if err := json.Unmarshal(body, into); err != nil {
		return httpx.BadRequest("invalid JSON body: " + err.Error())
	}
	return nil
}

// CheckVersion enforces optimistic concurrency on updates.
func CheckVersion(sent *int, current int) error {
	if sent == nil {
		return httpx.Validation(map[string]string{"version": "required on update"})
	}
	if *sent != current {
		return httpx.Conflict("entity was modified concurrently; reload and retry")
	}
	return nil
}

// Validator collects field errors.
type Validator map[string]string

func (v Validator) Check(ok bool, field, msg string) {
	if !ok {
		if _, exists := v[field]; !exists {
			v[field] = msg
		}
	}
}

func (v Validator) Err() error {
	if len(v) == 0 {
		return nil
	}
	return httpx.Validation(v)
}

// OneOf reports whether s is one of the allowed values.
func OneOf(s string, allowed ...string) bool {
	for _, a := range allowed {
		if s == a {
			return true
		}
	}
	return false
}

// Lang is the language for server-generated texts: ?lang=, else the requesting user's locale;
// "bs" or "en".
func Lang(r *http.Request, db DB) (string, error) {
	lang := r.URL.Query().Get("lang")
	if lang == "" {
		p, err := authz.Require(r.Context())
		if err != nil {
			return "", err
		}
		if err := db.QueryRow(r.Context(), `SELECT locale FROM users WHERE id = $1`, p.UserID).Scan(&lang); err != nil {
			return "", err
		}
	}
	if strings.HasPrefix(lang, "bs") {
		return "bs", nil
	}
	return "en", nil
}
