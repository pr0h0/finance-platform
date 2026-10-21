// Package fintest seeds ledger data and builds authenticated test routers for the planning /
// analytics family of modules. Test-only; never imported by production code.
package fintest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

// Ctx returns a context carrying a user principal.
func Ctx(userID uuid.UUID) context.Context {
	return authz.WithPrincipal(context.Background(), authz.Principal{UserID: userID, ActorType: authz.ActorUser})
}

func exec(t testing.TB, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("fintest: %v\n%s", err, sql)
	}
}

// Account inserts an account (type e.g. checking, savings, credit_card).
func Account(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, name, typ, cur string) uuid.UUID {
	id := uuid.New()
	exec(t, pool, `INSERT INTO accounts (id, profile_id, name, account_type, currency) VALUES ($1,$2,$3,$4,$5)`, id, profileID, name, typ, cur)
	return id
}

// Category inserts a category (kind expense|income).
func Category(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, name string, parent *uuid.UUID) uuid.UUID {
	id := uuid.New()
	exec(t, pool, `INSERT INTO categories (id, profile_id, parent_id, name) VALUES ($1,$2,$3,$4)`, id, profileID, parent, name)
	return id
}

// Merchant inserts a merchant.
func Merchant(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, name string) uuid.UUID {
	id := uuid.New()
	exec(t, pool, `INSERT INTO merchants (id, profile_id, name, normalized_name) VALUES ($1,$2,$3,lower($3))`, id, profileID, name)
	return id
}

// Txn inserts an income/expense/refund/opening_balance transaction with one posting (signed
// amount: expenses negative) and, except for opening balances, one split of |amount|.
func Txn(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, kind, date string, account uuid.UUID, amount, cur string, cat *uuid.UUID, desc string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	exec(t, pool, `INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,$3,$4,$5)`, id, profileID, kind, date, desc)
	exec(t, pool, `INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,$4,$5)`, profileID, id, account, amount, cur)
	if kind != "opening_balance" && kind != "transfer" {
		exec(t, pool, `INSERT INTO transaction_splits (profile_id, transaction_id, category_id, amount, currency) VALUES ($1,$2,$3,abs($4::numeric),$5)`, profileID, id, cat, amount, cur)
	}
	return id
}

// Transfer inserts a same-currency transfer (-amount from, +amount to).
func Transfer(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, date string, from, to uuid.UUID, amount, cur string) uuid.UUID {
	id := uuid.New()
	exec(t, pool, `INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,'transfer',$3,'transfer')`, id, profileID, date)
	exec(t, pool, `INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency, line_no) VALUES ($1,$2,$3,-$4::numeric,$5,0),($1,$2,$6,$4::numeric,$5,1)`, profileID, id, from, amount, cur, to)
	return id
}

// Rate inserts a manual profile rate (1 base = rate quote) on a date.
func Rate(t testing.TB, pool *pgxpool.Pool, profileID uuid.UUID, base, quote, rate, date string) {
	exec(t, pool, `INSERT INTO exchange_rates (profile_id, base_currency, quote_currency, rate, rate_date, source) VALUES ($1,$2,$3,$4,$5,'manual')`, profileID, base, quote, rate, date)
}

// API is an authenticated client for a router built from module Register functions.
type API struct {
	t       testing.TB
	h       http.Handler
	Profile uuid.UUID
}

func NewAPI(t testing.TB, pool *pgxpool.Pool, userID, profileID uuid.UUID, register ...func(chi.Router, *app.Deps)) *API {
	deps := &app.Deps{Config: &config.Config{}, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(authz.WithPrincipal(req.Context(), authz.Principal{UserID: userID, ActorType: authz.ActorUser})))
		})
	})
	r.Route("/api/v1", func(v chi.Router) {
		for _, reg := range register {
			reg(v, deps)
		}
	})
	return &API{t: t, h: r, Profile: profileID}
}

// Do sends a request and decodes the JSON response into out (if non-nil). Returns the status.
func (a *API) Do(method, path string, body any, out any) int {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		if s, ok := body.(string); ok {
			rd = strings.NewReader(s)
		} else {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
	}
	req := httptest.NewRequest(method, "/api/v1"+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(authz.ProfileHeader, a.Profile.String())
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if out != nil && rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			a.t.Fatalf("%s %s: decode %q: %v", method, path, rec.Body.String(), err)
		}
	}
	return rec.Code
}

// Must is Do that fails the test unless the status matches.
func (a *API) Must(want int, method, path string, body any, out any) {
	a.t.Helper()
	var raw json.RawMessage
	got := a.Do(method, path, body, &raw)
	if got != want {
		a.t.Fatalf("%s %s: status %d want %d: %s", method, path, got, want, raw)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			a.t.Fatalf("decode: %v", err)
		}
	}
}
