package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func TestErrorFormat(t *testing.T) {
	rr := httptest.NewRecorder()
	httpx.WriteError(rr, httptest.NewRequest("GET", "/", nil), httpx.Validation(map[string]string{"amount": "required"}))
	var body struct {
		Error struct {
			Code    string
			Details struct{ Fields map[string]string }
		}
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if rr.Code != 422 || body.Error.Code != "validation_failed" || body.Error.Details.Fields["amount"] != "required" {
		t.Fatalf("got %d %s", rr.Code, rr.Body)
	}
	rr = httptest.NewRecorder()
	httpx.WriteError(rr, httptest.NewRequest("GET", "/", nil), authz.ErrForbidden)
	if rr.Code != 403 {
		t.Fatalf("forbidden mapped to %d", rr.Code)
	}
}

func TestDecodeJSONRejectsUnknownAndOversize(t *testing.T) {
	var v struct{ A int }
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{"A":1,"B":2}`))
	if err := httpx.DecodeJSON(r, &v); err == nil {
		t.Fatal("unknown field accepted")
	}
	h := httpx.MaxBody(8)(httpx.H(func(w http.ResponseWriter, r *http.Request) error { return httpx.DecodeJSON(r, &v) }))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/", strings.NewReader(`{"A":123456789}`)))
	if rr.Code != 413 {
		t.Fatalf("oversize got %d", rr.Code)
	}
}

func TestCursorRoundTrip(t *testing.T) {
	type k struct{ D string }
	var out k
	if err := httpx.DecodeCursor(httpx.EncodeCursor(k{"2026-01-01"}), &out); err != nil || out.D != "2026-01-01" {
		t.Fatal(out, err)
	}
	if httpx.DecodeCursor("!!", &out) == nil {
		t.Fatal("bad cursor accepted")
	}
}

func TestIdempotency(t *testing.T) {
	pool := testdb.New(t)
	userID, _ := testdb.SeedUserProfile(t, pool)
	calls := 0
	h := httpx.Idempotent(pool)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		httpx.WriteJSON(w, 201, map[string]any{"n": calls})
	}))
	do := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/x", strings.NewReader(body))
		r.Header.Set(httpx.IdempotencyHeader, "k1")
		r = r.WithContext(authz.WithPrincipal(context.Background(), authz.Principal{UserID: userID, ActorType: authz.ActorUser}))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		return rr
	}
	a, b, c := do(`{"x":1}`), do(`{"x":1}`), do(`{"x":2}`)
	if calls != 1 || a.Code != 201 || b.Code != 201 || strings.TrimSpace(a.Body.String()) != strings.TrimSpace(b.Body.String()) {
		t.Fatalf("replay failed: calls=%d %d %s / %d %s", calls, a.Code, a.Body, b.Code, b.Body)
	}
	if b.Header().Get("Idempotent-Replayed") != "true" || c.Code != 422 {
		t.Fatalf("expected replay header and 422 for reused key, got %d", c.Code)
	}
	_ = uuid.Nil
}
