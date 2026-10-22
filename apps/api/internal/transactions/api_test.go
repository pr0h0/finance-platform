package transactions_test

// DB integration tests for the ledger-core modules through their real HTTP handlers, against a real
// PostgreSQL (internal/testdb). They cover PLAN §46 critical cases 1–9, 15, 18 and 19.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/accounts"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/attachments"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/categories"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/currency"
	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/merchants"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
	"github.com/pr0h0/finance-platform/apps/api/internal/transactions"
)

type api struct {
	t       *testing.T
	h       http.Handler
	pool    *pgxpool.Pool
	user    uuid.UUID
	profile uuid.UUID
	cfg     *config.Config
}

func newAPI(t *testing.T) *api {
	t.Helper()
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	cfg := &config.Config{AttachmentsDir: t.TempDir(), MaxUploadBytes: 1 << 20, StorageBackend: "local", FXProviders: nil} // no network in tests; the provider test enables its fake
	deps := &app.Deps{Config: cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	r.Use(middleware.RequestID, httpx.MaxBody(1<<20))
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if id, err := uuid.Parse(r.Header.Get("X-Test-User")); err == nil {
				r = r.WithContext(authz.WithPrincipal(r.Context(), authz.Principal{UserID: id, ActorType: authz.ActorUser, IsAdmin: true}))
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Route("/api/v1", func(v chi.Router) {
		for _, reg := range []func(chi.Router, *app.Deps){accounts.Register, ledger.Register, transactions.Register, categories.Register,
			merchants.Register, currency.Register, exchangerates.Register, attachments.Register} {
			reg(v, deps)
		}
	})
	return &api{t: t, h: r, pool: pool, user: user, profile: profile, cfg: cfg}
}

// call sends a JSON request and decodes the response into out (if non-nil); returns the status.
func (a *api) call(method, path string, body any, out any) int {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, "/api/v1"+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-User", a.user.String())
	req.Header.Set("X-Profile-ID", a.profile.String())
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if out != nil && rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			a.t.Fatalf("%s %s: decode %q: %v", method, path, rec.Body.String(), err)
		}
	}
	return rec.Code
}

// must is call + status assertion.
func (a *api) must(status int, method, path string, body any, out any) {
	a.t.Helper()
	var raw json.RawMessage
	got := a.call(method, path, body, &raw)
	if got != status {
		a.t.Fatalf("%s %s: status %d, want %d: %s", method, path, got, status, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			a.t.Fatal(err)
		}
	}
}

type obj = map[string]any

func m(amount, cur string) obj { return obj{"amount": amount, "currency": cur} }

type txOut struct {
	ID       uuid.UUID `json:"id"`
	Kind     string    `json:"kind"`
	Version  int       `json:"version"`
	Postings []struct {
		AccountID uuid.UUID `json:"accountId"`
		Amount    obj       `json:"amount"`
	} `json:"postings"`
	Splits []struct {
		ID         uuid.UUID  `json:"id"`
		CategoryID *uuid.UUID `json:"categoryId"`
		Amount     obj        `json:"amount"`
	} `json:"splits"`
	Conversion *struct {
		Rate   string `json:"rate"`
		Method string `json:"method"`
		Fee    obj    `json:"fee"`
	} `json:"conversion"`
	RelatedTransactionID *uuid.UUID `json:"relatedTransactionId"`
	BookingDate          string     `json:"bookingDate"`
	ExcludeFromReports   bool       `json:"excludeFromReports"`
	DeletedAt            *string    `json:"deletedAt"`
	Description          string     `json:"description"`
}

func (a *api) account(name, typ, cur, opening string) uuid.UUID {
	a.t.Helper()
	body := obj{"name": name, "accountType": typ, "currency": cur, "openingDate": "2026-01-01"}
	if opening != "" {
		body["openingBalance"] = m(opening, cur)
	}
	var out struct{ ID uuid.UUID }
	a.must(201, "POST", "/accounts", body, &out)
	return out.ID
}

func (a *api) category(name string, parent *uuid.UUID) uuid.UUID {
	a.t.Helper()
	var out struct{ ID uuid.UUID }
	a.must(201, "POST", "/categories", obj{"name": name, "parentId": parent}, &out)
	return out.ID
}

func (a *api) balance(acct uuid.UUID) string {
	a.t.Helper()
	var out struct {
		Balances []obj `json:"balances"`
	}
	a.must(200, "GET", "/accounts/"+acct.String(), nil, &out)
	return out.Balances[0]["amount"].(string)
}

// spending applies ADR 0003's analytics rule (splits of expenses minus splits of refunds; transfers,
// fx and opening balances never count) — the property critical cases 3, 4, 6 and 7 protect.
func (a *api) spending() (expense, income string) {
	a.t.Helper()
	err := a.pool.QueryRow(context.Background(), `SELECT
		COALESCE(SUM(s.amount) FILTER (WHERE t.kind = 'expense'), 0)::numeric(30,2)::text
		  || '|' || (COALESCE(SUM(s.amount) FILTER (WHERE t.kind = 'expense'), 0) - COALESCE(SUM(s.amount) FILTER (WHERE t.kind = 'refund'), 0))::numeric(30,2)::text,
		COALESCE(SUM(s.amount) FILTER (WHERE t.kind = 'income'), 0)::numeric(30,2)::text
		FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
		WHERE t.profile_id = $1 AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'void' AND NOT t.exclude_from_reports`,
		a.profile).Scan(&expense, &income)
	if err != nil {
		a.t.Fatal(err)
	}
	return expense, income
}

func TestCriticalExpenseIncomeTransferCreditCard(t *testing.T) {
	a := newAPI(t)
	checking := a.account("Checking", "checking", "BAM", "1000.00")
	savings := a.account("Savings", "savings", "BAM", "")
	card := a.account("Visa", "credit_card", "BAM", "")
	food := a.category("Food", nil)

	// 1. expense updates balance
	var exp txOut
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": checking, "amount": m("150.00", "BAM"),
		"bookingDate": "2026-02-01", "categoryId": food, "description": "Groceries"}, &exp)
	if a.balance(checking) != "850.00" || exp.Postings[0].Amount["amount"] != "-150.00" {
		t.Fatalf("expense: balance %s posting %v", a.balance(checking), exp.Postings[0].Amount)
	}
	// 2. income updates balance
	a.must(201, "POST", "/transactions", obj{"kind": "income", "accountId": checking, "amount": m("2000.00", "BAM"), "bookingDate": "2026-02-02"}, nil)
	if got := a.balance(checking); got != "2850.00" {
		t.Fatalf("income: balance %s", got)
	}
	e0, i0 := a.spending()

	// 3/4. transfers do not inflate income or expenses
	var tr txOut
	a.must(201, "POST", "/transactions", obj{"kind": "transfer", "accountId": checking, "toAccountId": savings, "amount": m("300.00", "BAM"), "bookingDate": "2026-02-03"}, &tr)
	if tr.Kind != "transfer" || len(tr.Splits) != 0 || a.balance(checking) != "2550.00" || a.balance(savings) != "300.00" {
		t.Fatalf("transfer: %+v checking %s savings %s", tr, a.balance(checking), a.balance(savings))
	}
	if e, i := a.spending(); e != e0 || i != i0 {
		t.Fatalf("transfer changed spending/income: %s %s -> %s %s", e0, i0, e, i)
	}

	// 7. credit card purchase + payment counted once
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": card, "amount": m("200.00", "BAM"), "bookingDate": "2026-02-04", "categoryId": food}, nil)
	a.must(201, "POST", "/transactions", obj{"kind": "transfer", "accountId": checking, "toAccountId": card, "amount": m("200.00", "BAM"), "bookingDate": "2026-02-05"}, nil)
	if a.balance(card) != "0.00" || a.balance(checking) != "2350.00" {
		t.Fatalf("card payment: card %s checking %s", a.balance(card), a.balance(checking))
	}
	if e, _ := a.spending(); e != "350.00|350.00" {
		t.Fatalf("card purchase counted %s, want 350.00 once", e)
	}

	// Net worth: assets 2350 + 300, liability 0; transfers never change it.
	var bal struct {
		NetWorth    obj `json:"netWorth"`
		Assets      obj `json:"assets"`
		Liabilities obj `json:"liabilities"`
	}
	a.must(200, "GET", "/balances", nil, &bal)
	if bal.NetWorth["amount"] != "2650.00" || bal.Liabilities["amount"] != "0.00" {
		t.Fatalf("net worth %+v", bal)
	}
	// Historic balance as of a past date.
	a.must(200, "GET", "/balances?asOf=2026-02-01", nil, &bal)
	if bal.NetWorth["amount"] != "850.00" {
		t.Fatalf("asOf net worth %v", bal.NetWorth)
	}

	// Balance history: end-of-day running balance.
	var hist struct {
		Points []struct {
			Date    string `json:"date"`
			Balance obj    `json:"balance"`
		} `json:"points"`
	}
	a.must(200, "GET", "/accounts/"+checking.String()+"/balance-history?from=2026-01-31&to=2026-02-05", nil, &hist)
	want := []string{"1000.00", "850.00", "2850.00", "2550.00", "2550.00", "2350.00"}
	for i, p := range hist.Points {
		if p.Balance["amount"] != want[i] {
			t.Fatalf("history[%d] %s = %v, want %s", i, p.Date, p.Balance, want[i])
		}
	}

	// Validation: same-account transfer, wrong currency, negative expense amount.
	a.must(422, "POST", "/transactions", obj{"kind": "transfer", "accountId": checking, "toAccountId": checking, "amount": m("1.00", "BAM"), "bookingDate": "2026-02-05"}, nil)
	a.must(422, "POST", "/transactions", obj{"kind": "expense", "accountId": checking, "amount": m("1.00", "EUR"), "bookingDate": "2026-02-05"}, nil)
	a.must(422, "POST", "/transactions", obj{"kind": "expense", "accountId": checking, "amount": m("-1.00", "BAM"), "bookingDate": "2026-02-05"}, nil)
	if code := a.call("POST", "/transactions", obj{"kind": "expense", "accountId": checking, "amount": m("1.005", "BAM"), "bookingDate": "2026-02-05"}, nil); code != 400 {
		t.Fatalf("over-precise amount accepted: %d", code)
	}
	// Accounts with history cannot be deleted (archive instead).
	a.must(409, "DELETE", "/accounts/"+checking.String(), nil, nil)
}

func TestCriticalSplitsAndRefunds(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "500.00")
	food := a.category("Food", nil)
	groceries := a.category("Groceries", &food)
	home := a.category("Home", nil)

	// 5. split totals remain exact
	a.must(422, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("100.00", "BAM"), "bookingDate": "2026-03-01",
		"splits": []obj{{"categoryId": groceries, "amount": m("33.33", "BAM")}, {"categoryId": home, "amount": m("33.33", "BAM")}, {"categoryId": nil, "amount": m("33.33", "BAM")}}}, nil)
	var tx txOut
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("100.00", "BAM"), "bookingDate": "2026-03-01",
		"splits": []obj{{"categoryId": groceries, "amount": m("33.33", "BAM")}, {"categoryId": home, "amount": m("33.33", "BAM")}, {"categoryId": nil, "amount": m("33.34", "BAM")}}}, &tx)
	if len(tx.Splits) != 3 || a.balance(acct) != "400.00" {
		t.Fatalf("splits %+v balance %s", tx.Splits, a.balance(acct))
	}
	// Reorder + recategorize keeps split ids and never changes balances.
	var re txOut
	a.must(200, "PUT", "/transactions/"+tx.ID.String()+"/splits", obj{"version": tx.Version, "splits": []obj{
		{"id": tx.Splits[2].ID, "categoryId": home, "amount": m("33.34", "BAM")},
		{"id": tx.Splits[0].ID, "categoryId": groceries, "amount": m("33.33", "BAM")},
		{"id": tx.Splits[1].ID, "categoryId": home, "amount": m("33.33", "BAM")}}}, &re)
	if re.Splits[0].ID != tx.Splits[2].ID || re.Splits[1].ID != tx.Splits[0].ID || a.balance(acct) != "400.00" {
		t.Fatalf("reorder lost ids: %+v", re.Splits)
	}
	// Stale version -> 409; unbalanced replacement -> 422 and nothing changes.
	a.must(409, "PUT", "/transactions/"+tx.ID.String()+"/splits", obj{"version": tx.Version, "splits": []obj{{"categoryId": home, "amount": m("100.00", "BAM")}}}, nil)
	a.must(422, "PUT", "/transactions/"+tx.ID.String()+"/splits", obj{"version": re.Version, "splits": []obj{{"categoryId": home, "amount": m("99.99", "BAM")}}}, nil)
	// Amount edit of a multi-split transaction must re-split explicitly.
	a.must(422, "PATCH", "/transactions/"+tx.ID.String(), obj{"version": re.Version, "amount": m("90.00", "BAM")}, nil)

	// Filtering by a parent category includes its subcategories.
	var list struct{ Items []txOut }
	a.must(200, "GET", "/transactions?categoryId="+food.String(), nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != tx.ID {
		t.Fatalf("parent category filter: %+v", list.Items)
	}

	// 6. partial refunds linked to the original, allocated proportionally, capped.
	var exp txOut
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("90.00", "BAM"), "bookingDate": "2026-03-02",
		"splits": []obj{{"categoryId": groceries, "amount": m("60.00", "BAM")}, {"categoryId": home, "amount": m("30.00", "BAM")}}}, &exp)
	var ref txOut
	a.must(201, "POST", "/transactions/"+exp.ID.String()+"/refunds", obj{"amount": m("10.00", "BAM"), "bookingDate": "2026-03-05"}, &ref)
	if ref.Kind != "refund" || *ref.RelatedTransactionID != exp.ID || len(ref.Splits) != 2 ||
		ref.Splits[0].Amount["amount"] != "6.67" || ref.Splits[1].Amount["amount"] != "3.33" {
		t.Fatalf("refund %+v", ref)
	}
	if a.balance(acct) != "320.00" {
		t.Fatalf("refund balance %s", a.balance(acct))
	}
	if e, inc := a.spending(); e != "190.00|180.00" || inc != "0.00" {
		t.Fatalf("refund must reduce spending, not add income: %s %s", e, inc)
	}
	a.must(422, "POST", "/transactions/"+exp.ID.String()+"/refunds", obj{"amount": m("80.01", "BAM"), "bookingDate": "2026-03-06"}, nil)
	a.must(201, "POST", "/transactions/"+exp.ID.String()+"/refunds", obj{"amount": m("80.00", "BAM"), "bookingDate": "2026-03-06", "categoryId": home}, nil)
	a.must(422, "POST", "/transactions/"+exp.ID.String()+"/refunds", obj{"amount": m("0.01", "BAM"), "bookingDate": "2026-03-06"}, nil)

	// Split templates: fixed amount + weighted remainder, exact.
	var st struct{ ID uuid.UUID }
	a.must(201, "POST", "/split-templates", obj{"name": "Shared", "lines": []obj{
		{"categoryId": home, "amount": m("10.00", "BAM")}, {"categoryId": groceries, "weight": "1"}, {"categoryId": nil, "weight": "2"}}}, &st)
	var cur txOut
	a.must(200, "GET", "/transactions/"+exp.ID.String(), nil, &cur)
	a.must(200, "PUT", "/transactions/"+exp.ID.String()+"/splits", obj{"version": cur.Version, "splitTemplateId": st.ID}, &cur)
	if len(cur.Splits) != 3 || cur.Splits[1].Amount["amount"] != "26.67" || cur.Splits[2].Amount["amount"] != "53.33" {
		t.Fatalf("split template: %+v", cur.Splits)
	}
}

func TestCriticalFXRoundingAndHistoricalRates(t *testing.T) {
	a := newAPI(t)
	eur := a.account("EUR account", "checking", "EUR", "1000.00")
	bam := a.account("BAM account", "checking", "BAM", "")
	usd := a.account("USD account", "checking", "USD", "")
	fees := a.category("Bank fees", nil)

	// 8. fixed EUR/BAM parity, single rounding half-up: 100.00 * 1.95583 = 195.583 -> 195.58
	var fx txOut
	a.must(201, "POST", "/transactions", obj{"kind": "transfer", "accountId": eur, "toAccountId": bam, "amount": m("100.00", "EUR"),
		"bookingDate": "2026-04-01", "fee": m("1.50", "EUR"), "feeCategoryId": fees}, &fx)
	if fx.Kind != "fx" || fx.Postings[1].Amount["amount"] != "195.58" || fx.Conversion.Method != "fixed" || fx.Conversion.Rate != "1.95583" {
		t.Fatalf("fx: %+v %+v", fx.Postings, fx.Conversion)
	}
	if fx.Conversion.Fee["amount"] != "1.50" || a.balance(eur) != "898.50" || a.balance(bam) != "195.58" {
		t.Fatalf("fee: %+v eur %s bam %s", fx.Conversion, a.balance(eur), a.balance(bam))
	}
	var fee struct{ Items []txOut }
	a.must(200, "GET", "/transactions?relatedTransactionId="+fx.ID.String(), nil, &fee)
	if len(fee.Items) != 1 || fee.Items[0].Kind != "expense" || *fee.Items[0].Splits[0].CategoryID != fees {
		t.Fatalf("fee expense: %+v", fee.Items)
	}
	var conv struct {
		To     obj    `json:"to"`
		Rate   string `json:"rate"`
		Source string `json:"source"`
	}
	a.must(200, "POST", "/convert", obj{"amount": m("0.05", "EUR"), "to": "BAM"}, &conv)
	if conv.To["amount"] != "0.10" || conv.Source != "fixed" { // 0.0977915 -> 0.10
		t.Fatalf("convert: %+v", conv)
	}
	a.must(200, "POST", "/convert", obj{"amount": m("0.05", "EUR"), "to": "BAM", "rounding": "down"}, &conv)
	if conv.To["amount"] != "0.09" {
		t.Fatalf("convert down: %+v", conv)
	}
	// Inverse direction uses the same snapshot: 195.58 BAM / 1.95583 = 99.998466... -> 100.00
	a.must(200, "POST", "/convert", obj{"amount": m("195.58", "BAM"), "to": "EUR"}, &conv)
	if conv.To["amount"] != "100.00" {
		t.Fatalf("inverse: %+v", conv)
	}

	// 9. historical rates preserved: manual EUR/USD snapshots on two dates.
	a.must(201, "POST", "/exchange-rates", obj{"baseCurrency": "EUR", "quoteCurrency": "USD", "rate": "1.10", "rateDate": "2026-01-10"}, nil)
	a.must(409, "POST", "/exchange-rates", obj{"baseCurrency": "EUR", "quoteCurrency": "USD", "rate": "1.11", "rateDate": "2026-01-10"}, nil)
	var jan txOut
	a.must(201, "POST", "/transactions", obj{"kind": "transfer", "accountId": eur, "toAccountId": usd, "amount": m("10.00", "EUR"), "bookingDate": "2026-01-20"}, &jan)
	if jan.Postings[1].Amount["amount"] != "11.00" || jan.Conversion.Rate != "1.1" || jan.Conversion.Method != "manual" {
		t.Fatalf("jan fx: %+v %+v", jan.Postings, jan.Conversion)
	}
	var rate struct{ ID uuid.UUID }
	a.must(201, "POST", "/exchange-rates", obj{"baseCurrency": "EUR", "quoteCurrency": "USD", "rate": "1.20", "rateDate": "2026-02-10"}, &rate)
	a.must(200, "POST", "/convert", obj{"amount": m("10.00", "EUR"), "to": "USD", "date": "2026-01-25"}, &conv)
	if conv.To["amount"] != "11.00" {
		t.Fatalf("historical lookup: %+v", conv)
	}
	a.must(200, "POST", "/convert", obj{"amount": m("10.00", "EUR"), "to": "USD", "date": "2026-02-15"}, &conv)
	if conv.To["amount"] != "12.00" {
		t.Fatalf("newer lookup: %+v", conv)
	}
	a.must(200, "GET", "/transactions/"+jan.ID.String(), nil, &jan)
	if jan.Postings[1].Amount["amount"] != "11.00" || jan.Conversion.Rate != "1.1" {
		t.Fatalf("recorded fx changed after a new rate: %+v", jan.Conversion)
	}
	// Cross rate USD -> BAM via EUR: 12.00 USD / 1.2 * 1.95583 = 19.5583 -> 19.56
	a.must(200, "POST", "/convert", obj{"amount": m("12.00", "USD"), "to": "BAM", "date": "2026-02-15"}, &conv)
	if conv.To["amount"] != "19.56" {
		t.Fatalf("cross: %+v", conv)
	}
	// A used manual rate cannot be deleted; an unused one can.
	var jr struct {
		Items []struct {
			ID       uuid.UUID `json:"id"`
			RateDate string    `json:"rateDate"`
		}
	}
	a.must(200, "GET", "/exchange-rates?base=EUR&quote=USD", nil, &jr)
	if len(jr.Items) != 2 || jr.Items[0].RateDate != "2026-02-10" {
		t.Fatalf("rates list %+v", jr.Items)
	}
	a.must(409, "DELETE", "/exchange-rates/"+jr.Items[1].ID.String(), nil, nil)
	a.must(204, "DELETE", "/exchange-rates/"+rate.ID.String(), nil, nil)

	// Bank-actual settlement amount (manual override of the amount charged).
	var actual txOut
	a.must(201, "POST", "/transactions", obj{"kind": "transfer", "accountId": eur, "toAccountId": usd, "amount": m("100.00", "EUR"),
		"toAmount": m("108.37", "USD"), "bookingDate": "2026-04-02"}, &actual)
	if actual.Conversion.Method != "bank_actual" || actual.Conversion.Rate != "1.0837" {
		t.Fatalf("bank actual: %+v", actual.Conversion)
	}
	// Net worth in BAM converts every account; no rate -> totals null + missingRates.
	var bal struct {
		NetWorth     obj      `json:"netWorth"`
		MissingRates []string `json:"missingRates"`
	}
	a.must(200, "GET", "/balances?asOf=2026-04-02", nil, &bal)
	if bal.NetWorth == nil || len(bal.MissingRates) != 0 {
		t.Fatalf("net worth: %+v", bal)
	}
	a.must(200, "GET", "/balances?asOf=2026-04-02&currency=JPY", nil, &bal)
	if bal.NetWorth != nil || len(bal.MissingRates) == 0 {
		t.Fatalf("missing rates must null the totals: %+v", bal)
	}
}

func TestCriticalImportedEvidenceAndAdjustments(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "")
	ctx := authz.WithPrincipal(context.Background(), authz.Principal{UserID: a.user, ActorType: authz.ActorUser})
	var batchID, recordID uuid.UUID
	err := a.pool.QueryRow(ctx, `INSERT INTO import_batches (profile_id, account_id, importer_id, importer_version, file_name, file_sha256, file_size)
		VALUES ($1,$2,'synthetic','1','s.csv','\x00',1) RETURNING id`, a.profile, acct).Scan(&batchID)
	if err == nil {
		err = a.pool.QueryRow(ctx, `INSERT INTO imported_raw_records (profile_id, import_batch_id, account_id, row_number, source_description,
			posting_date, amount, direction, currency, raw, dedupe_fingerprint, file_sha256, importer_id, importer_version)
			VALUES ($1,$2,$3,1,'KONZUM 123 SARAJEVO','2026-05-01',-42.50,'debit','BAM','{}','fp1','\x00','synthetic','1') RETURNING id`,
			a.profile, batchID, acct).Scan(&recordID)
	}
	if err != nil {
		t.Fatal(err)
	}
	var imported *ledger.Transaction
	err = pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		amt, _ := json.Marshal(m("-42.50", "BAM"))
		var p ledger.Posting
		p.AccountID = acct
		_ = json.Unmarshal(amt, &p.Amount)
		var s ledger.Split
		_ = json.Unmarshal([]byte(`{"amount":{"amount":"42.50","currency":"BAM"}}`), &s)
		imported, err = ledger.Create(ctx, tx, &ledger.Transaction{ProfileID: a.profile, Kind: "expense", BookingDate: "2026-05-01",
			Description: "KONZUM 123 SARAJEVO", Source: "import", ImportRecordID: &recordID, TagIDs: []uuid.UUID{},
			Postings: []ledger.Posting{p}, Splits: []ledger.Split{s}}, "transaction.import", nil)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	id := imported.ID.String()
	// Interpretation is editable; evidence is not.
	var cur txOut
	a.must(200, "PATCH", "/transactions/"+id, obj{"version": 1, "description": "Konzum groceries"}, &cur)
	var e struct {
		Error struct{ Code string } `json:"error"`
	}
	if code := a.call("PATCH", "/transactions/"+id, obj{"version": cur.Version, "amount": m("40.00", "BAM")}, &e); code != 409 || e.Error.Code != "imported_evidence" {
		t.Fatalf("imported amount edit: %d %+v", code, e)
	}
	a.must(409, "PATCH", "/transactions/"+id, obj{"version": cur.Version, "bookingDate": "2026-05-02"}, nil)
	// 15. raw record intact (and the DB refuses updates outright).
	var desc, amount string
	if err := a.pool.QueryRow(ctx, `SELECT source_description, amount::text FROM imported_raw_records WHERE id = $1`, recordID).Scan(&desc, &amount); err != nil || desc != "KONZUM 123 SARAJEVO" || amount != "-42.5000000000" {
		t.Fatalf("raw record changed: %q %q %v", desc, amount, err)
	}
	if _, err := a.pool.Exec(ctx, `UPDATE imported_raw_records SET amount = 1 WHERE id = $1`, recordID); err == nil {
		t.Fatal("raw record update allowed")
	}
	// Audited correction instead of rewriting.
	var adj txOut
	a.must(201, "POST", "/transactions/"+id+"/adjustments", obj{"amount": m("2.50", "BAM"), "bookingDate": "2026-05-03", "reason": "bank refunded rounding"}, &adj)
	if adj.Kind != "adjustment" || a.balance(acct) != "-40.00" {
		t.Fatalf("adjustment %+v balance %s", adj, a.balance(acct))
	}
	var links int
	_ = a.pool.QueryRow(ctx, `SELECT count(*) FROM transaction_adjustments WHERE transaction_id = $1 AND adjustment_transaction_id = $2`, imported.ID, adj.ID).Scan(&links)
	if links != 1 {
		t.Fatal("adjustment link missing")
	}
	var withSrc struct {
		SourceRecord struct {
			SourceDescription string `json:"sourceDescription"`
			Amount            obj    `json:"amount"`
		} `json:"sourceRecord"`
	}
	a.must(200, "GET", "/transactions/"+id, nil, &withSrc)
	if withSrc.SourceRecord.SourceDescription != "KONZUM 123 SARAJEVO" || withSrc.SourceRecord.Amount["amount"] != "-42.50" {
		t.Fatalf("source record: %+v", withSrc)
	}
	// Deleting an imported transaction excludes it from reports instead.
	a.must(204, "DELETE", "/transactions/"+id, nil, nil)
	a.must(200, "GET", "/transactions/"+id, nil, &cur)
	if !cur.ExcludeFromReports || cur.DeletedAt != nil || a.balance(acct) != "-40.00" {
		t.Fatalf("imported delete: %+v", cur)
	}
	// History shows every change with before/after.
	var hist struct {
		Items []struct{ Action string }
	}
	a.must(200, "GET", "/transactions/"+id+"/history", nil, &hist)
	if len(hist.Items) != 3 || hist.Items[0].Action != "transaction.exclude" || hist.Items[2].Action != "transaction.import" {
		t.Fatalf("history %+v", hist.Items)
	}
}

func TestCriticalOpeningBalanceReconciliationAndTimezone(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "250.00")
	a.must(409, "POST", "/transactions", obj{"kind": "opening_balance", "accountId": acct, "amount": m("1.00", "BAM"), "bookingDate": "2026-01-01"}, nil)
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("20.00", "BAM"), "bookingDate": "2026-03-29"}, nil)

	// 18. opening balances reconcile: statement 230.00 matches; 225.50 creates an adjustment.
	var rec struct {
		Difference              obj        `json:"difference"`
		LedgerBalance           obj        `json:"ledgerBalance"`
		AdjustmentTransactionID *uuid.UUID `json:"adjustmentTransactionId"`
	}
	a.must(200, "POST", "/reconciliations", obj{"accountId": acct, "statementDate": "2026-03-31", "statementBalance": m("230.00", "BAM"), "createAdjustment": true}, &rec)
	if rec.Difference["amount"] != "0.00" || rec.AdjustmentTransactionID != nil {
		t.Fatalf("reconcile match: %+v", rec)
	}
	a.must(200, "POST", "/reconciliations", obj{"accountId": acct, "statementDate": "2026-03-31", "statementBalance": m("225.50", "BAM"), "createAdjustment": true}, &rec)
	if rec.Difference["amount"] != "-4.50" || rec.AdjustmentTransactionID == nil || a.balance(acct) != "225.50" {
		t.Fatalf("reconcile adjust: %+v balance %s", rec, a.balance(acct))
	}

	// 19. timezone changes never shift calendar dates (booking_date is a date, not an instant).
	ctx := context.Background()
	for _, tz := range []string{"Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"} {
		if _, err := a.pool.Exec(ctx, `UPDATE profiles SET timezone = $2 WHERE id = $1`, a.profile, tz); err != nil {
			t.Fatal(err)
		}
		var list struct{ Items []txOut }
		a.must(200, "GET", "/transactions?from=2026-03-29&to=2026-03-29", nil, &list)
		if len(list.Items) != 1 || list.Items[0].BookingDate != "2026-03-29" {
			t.Fatalf("tz %s: %+v", tz, list.Items)
		}
		err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, fmt.Sprintf(`SET LOCAL TIME ZONE '%s'`, tz)); err != nil {
				return err
			}
			var d string
			if err := tx.QueryRow(ctx, `SELECT booking_date::text FROM transactions WHERE profile_id = $1 AND kind = 'expense'`, a.profile).Scan(&d); err != nil {
				return err
			}
			if d != "2026-03-29" {
				return fmt.Errorf("session tz %s shifted date to %s", tz, d)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestEditUndoDuplicateBulkSearchExportSync(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "100.00")
	food := a.category("Food", nil)
	var tag struct{ ID uuid.UUID }
	a.must(201, "POST", "/tags", obj{"name": "Vacation"}, &tag)
	a.must(409, "POST", "/tags", obj{"name": "vacation"}, nil)
	var mer struct{ ID uuid.UUID }
	a.must(201, "POST", "/merchants", obj{"name": "Konzum", "aliases": []string{"KONZUM d.d.", "Konzum Plus"}}, &mer)

	var tx txOut
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("10.00", "BAM"), "bookingDate": "2026-06-01",
		"categoryId": food, "description": "=HYPERLINK(\"x\")", "merchantId": mer.ID, "tagIds": []uuid.UUID{tag.ID}}, &tx)
	// Manual amount edit: postings replaced (immutable), single split follows.
	var ed txOut
	a.must(200, "PATCH", "/transactions/"+tx.ID.String(), obj{"version": tx.Version, "amount": m("12.00", "BAM"), "notes": "edited"}, &ed)
	if ed.Postings[0].Amount["amount"] != "-12.00" || ed.Splits[0].Amount["amount"] != "12.00" || a.balance(acct) != "88.00" {
		t.Fatalf("edit: %+v", ed)
	}
	var retired int
	_ = a.pool.QueryRow(context.Background(), `SELECT count(*) FROM postings WHERE transaction_id = $1 AND deleted_at IS NOT NULL`, tx.ID).Scan(&retired)
	if retired != 1 {
		t.Fatalf("old posting not retired: %d", retired)
	}
	a.must(409, "PATCH", "/transactions/"+tx.ID.String(), obj{"version": tx.Version, "notes": "stale"}, nil)
	// Undo restores the previous amount; undo of the create deletes.
	var und txOut
	a.must(200, "POST", "/transactions/"+tx.ID.String()+"/undo", nil, &und)
	if und.Postings[0].Amount["amount"] != "-10.00" || a.balance(acct) != "90.00" {
		t.Fatalf("undo: %+v", und)
	}
	// Duplicate.
	var dup txOut
	a.must(201, "POST", "/transactions/"+tx.ID.String()+"/duplicate", obj{"bookingDate": "2026-06-02"}, &dup)
	if dup.ID == tx.ID || dup.BookingDate != "2026-06-02" || a.balance(acct) != "80.00" {
		t.Fatalf("duplicate %+v", dup)
	}
	// Bulk is all-or-nothing.
	var br struct {
		Updated int
		Failed  []struct{ ID uuid.UUID }
	}
	a.must(200, "POST", "/transactions/bulk", obj{"transactionIds": []uuid.UUID{tx.ID, uuid.New()}, "set": obj{"excludeFromReports": true}}, &br)
	if br.Updated != 0 || len(br.Failed) != 1 {
		t.Fatalf("bulk partial: %+v", br)
	}
	a.must(200, "POST", "/transactions/bulk", obj{"transactionIds": []uuid.UUID{tx.ID, dup.ID}, "set": obj{"clearCategory": true, "removeTagIds": []uuid.UUID{tag.ID}}}, &br)
	if br.Updated != 2 {
		t.Fatalf("bulk: %+v", br)
	}
	// Search: text, merchant, amount range, uncategorized, cursor pagination.
	var list struct {
		Items      []txOut
		NextCursor string
	}
	a.must(200, "GET", "/transactions?q=hyperlink&uncategorized=true&minAmount=9.99&maxAmount=10.00&merchantId="+mer.ID.String(), nil, &list)
	if len(list.Items) != 2 {
		t.Fatalf("search: %d", len(list.Items))
	}
	a.must(200, "GET", "/transactions?limit=1", nil, &list)
	first := list.Items[0].ID
	a.must(200, "GET", "/transactions?limit=1&cursor="+list.NextCursor, nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID == first {
		t.Fatalf("cursor paging: %+v", list)
	}
	a.must(422, "GET", "/transactions?from=yesterday", nil, nil)

	// Export CSV escapes formulas in text cells but keeps signed amounts.
	req := httptest.NewRequest("GET", "/api/v1/transactions/export?format=csv", nil)
	req.Header.Set("X-Test-User", a.user.String())
	req.Header.Set("X-Profile-ID", a.profile.String())
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	csv := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(csv, `'=HYPERLINK`) || !strings.Contains(csv, ",-10.00,BAM,") || !strings.Contains(csv, "Konzum") {
		t.Fatalf("csv export: %d %s", rec.Code, csv)
	}
	req = httptest.NewRequest("GET", "/api/v1/transactions/export?format=json", nil)
	req.Header.Set("X-Test-User", a.user.String())
	req.Header.Set("X-Profile-ID", a.profile.String())
	rec = httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	var exp struct{ Items []txOut }
	if err := json.Unmarshal(rec.Body.Bytes(), &exp); err != nil || len(exp.Items) != 3 {
		t.Fatalf("json export: %v %d", err, len(exp.Items))
	}

	// Merchant alias matching on a raw bank description.
	var match struct {
		Merchant struct{ ID uuid.UUID }
	}
	a.must(200, "GET", "/merchants/match?description=POS%20KONZUM%20PLUS%20123456%20SARAJEVO", nil, &match)
	if match.Merchant.ID != mer.ID {
		t.Fatalf("merchant match: %+v", match)
	}
	a.must(404, "GET", "/merchants/match?description=BINGO", nil, nil)

	// Every mutation went through the change log: versions 1..n without gaps, matching the profile head.
	var n, lo, hi, head int64
	if err := a.pool.QueryRow(context.Background(), `SELECT count(*), min(server_version), max(server_version),
		(SELECT sync_version FROM profiles WHERE id = $1) FROM sync_changes WHERE profile_id = $1`, a.profile).Scan(&n, &lo, &hi, &head); err != nil {
		t.Fatal(err)
	}
	if n < 10 || lo != 1 || hi != n || head != n {
		t.Fatalf("change log: n=%d min=%d max=%d head=%d", n, lo, hi, head)
	}
	// Undo of create = delete (tombstone + delete change).
	a.must(200, "POST", "/transactions/"+dup.ID.String()+"/undo", nil, nil) // undoes the bulk edit
	a.must(200, "POST", "/transactions/"+dup.ID.String()+"/undo", nil, nil) // redo (undo of the undo)
}

func TestAuthorizationAndHierarchy(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "")
	parent := a.category("Parent", nil)
	child := a.category("Child", &parent)
	var c struct{ Version int }
	a.must(200, "GET", "/categories/"+parent.String(), nil, &c)
	a.must(422, "PATCH", "/categories/"+parent.String(), obj{"version": c.Version, "parentId": child}, nil) // cycle
	a.must(409, "DELETE", "/categories/"+parent.String(), nil, nil)                                         // has children
	a.must(409, "PATCH", "/categories/"+parent.String(), obj{"version": c.Version + 1, "name": "X"}, nil)

	// Transaction templates: CRUD, reference checks, optimistic concurrency, tombstone.
	var tpl struct {
		ID      uuid.UUID
		Version int
		Amount  obj
	}
	a.must(201, "POST", "/transaction-templates", obj{"name": "Coffee", "kind": "expense", "accountId": acct, "amount": m("3.50", "BAM"), "categoryId": child}, &tpl)
	a.must(422, "POST", "/transaction-templates", obj{"name": "Bad", "kind": "expense", "categoryId": uuid.New()}, nil)
	a.must(200, "PATCH", "/transaction-templates/"+tpl.ID.String(), obj{"version": tpl.Version, "amount": m("4.00", "BAM")}, &tpl)
	if tpl.Amount["amount"] != "4.00" || tpl.Version != 2 {
		t.Fatalf("template patch: %+v", tpl)
	}
	var tpls struct{ Items []obj }
	a.must(200, "GET", "/transaction-templates", nil, &tpls)
	a.must(204, "DELETE", "/transaction-templates/"+tpl.ID.String(), nil, nil)
	a.must(404, "GET", "/transaction-templates/"+tpl.ID.String(), nil, nil)
	if len(tpls.Items) != 1 || tpls.Items[0]["name"] != "Coffee" {
		t.Fatalf("templates list: %+v", tpls)
	}

	var seeded struct{ Created int }
	a.must(200, "POST", "/categories/defaults", nil, &seeded)
	if seeded.Created != 0 {
		t.Fatalf("defaults seeded into a non-empty profile")
	}

	// Another user's profile: forbidden, and ids of this profile are invisible there.
	other := &api{t: t, h: a.h, pool: a.pool, cfg: a.cfg}
	other.user, other.profile = testdb.SeedUserProfile(t, a.pool)
	other.must(404, "GET", "/accounts/"+acct.String(), nil, nil)
	other.must(422, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("1.00", "BAM"), "bookingDate": "2026-01-01"}, nil)
	intruder := *other
	intruder.profile = a.profile
	intruder.must(403, "GET", "/accounts", nil, nil)

	var defaults struct{ Created int }
	other.must(200, "POST", "/categories/defaults", nil, &defaults)
	if defaults.Created < 20 {
		t.Fatalf("defaults: %d", defaults.Created)
	}
}

func TestAttachments(t *testing.T) {
	a := newAPI(t)
	acct := a.account("Checking", "checking", "BAM", "")
	var tx txOut
	a.must(201, "POST", "/transactions", obj{"kind": "expense", "accountId": acct, "amount": m("5.00", "BAM"), "bookingDate": "2026-07-01"}, &tx)

	upload := func(name string, content []byte, fields map[string]string) (int, map[string]any) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		for k, v := range fields {
			_ = mw.WriteField(k, v)
		}
		fw, _ := mw.CreateFormFile("file", name)
		_, _ = fw.Write(content)
		_ = mw.Close()
		req := httptest.NewRequest("POST", "/api/v1/attachments", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("X-Test-User", a.user.String())
		req.Header.Set("X-Profile-ID", a.profile.String())
		req.Header.Set("Idempotency-Key", uuid.NewString()) // the web client always sends one
		rec := httptest.NewRecorder()
		a.h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	// a connected device uploads its local attachment under the same id; the id cannot be reused
	own := uuid.NewString()
	if code, out := upload("r.txt", []byte("receipt"), map[string]string{"id": own}); code != 201 || out["id"] != own {
		t.Fatalf("client id upload: %d %v", code, out)
	}
	if code, _ := upload("r.txt", []byte("receipt"), map[string]string{"id": own}); code != 409 {
		t.Fatalf("reused id: %d", code)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 100)...)
	code, att := upload("../../etc/passwd.png", png, map[string]string{"transactionId": tx.ID.String(), "purpose": "receipt"})
	if code != 201 || att["fileName"] != "passwd.png" || att["contentType"] != "image/png" || att["sizeBytes"].(float64) != 108 {
		t.Fatalf("upload: %d %v", code, att)
	}
	if code, _ := upload("evil.html", []byte("<html><script>alert(1)</script>"), nil); code != 415 {
		t.Fatalf("html accepted: %d", code)
	}
	if code, _ := upload("big.pdf", append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("a"), 2<<20)...), nil); code != 413 {
		t.Fatalf("oversize accepted: %d", code)
	}
	a.must(400, "POST", "/attachments", obj{"x": 1}, nil)

	id := att["id"].(string)
	req := httptest.NewRequest("GET", "/api/v1/attachments/"+id+"/content", nil)
	req.Header.Set("X-Test-User", a.user.String())
	req.Header.Set("X-Profile-ID", a.profile.String())
	rec := httptest.NewRecorder()
	a.h.ServeHTTP(rec, req)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), png) || rec.Header().Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: %d %v", rec.Code, rec.Header())
	}
	var withAtt struct {
		AttachmentIDs []string `json:"attachmentIds"`
	}
	a.must(200, "GET", "/transactions/"+tx.ID.String(), nil, &withAtt)
	if len(withAtt.AttachmentIDs) != 1 || withAtt.AttachmentIDs[0] != id {
		t.Fatalf("attachment not linked: %+v", withAtt)
	}
	a.must(200, "PATCH", "/attachments/"+id, obj{"version": 1, "transactionId": nil}, nil)
	var list struct{ Items []map[string]any }
	a.must(200, "GET", "/attachments?transactionId="+tx.ID.String(), nil, &list)
	if len(list.Items) != 0 {
		t.Fatal("unlink failed")
	}
	a.must(204, "DELETE", "/attachments/"+id, nil, nil)
	a.must(404, "GET", "/attachments/"+id+"/content", nil, nil)
}

func TestExchangeRateProviderFetchAndOfflineFallback(t *testing.T) {
	a := newAPI(t)
	hits := 0
	online := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if !online {
			http.Error(w, "down", 503)
			return
		}
		date := strings.TrimPrefix(r.URL.Path, "/")
		if date == "latest" {
			date = "2026-08-03"
		}
		// Numbers with many digits must survive exactly (json.Number, never float64).
		fmt.Fprintf(w, `{"amount":1.0,"base":"EUR","date":%q,"rates":{"USD":1.123456789012345678,"JPY":161.23,"XXX":1}}`, date)
	}))
	defer srv.Close()
	ctx := context.Background()
	if _, err := a.pool.Exec(ctx, `UPDATE exchange_rate_providers SET config = jsonb_build_object('url', $1::text, 'base', 'EUR') WHERE code = 'ecb'`, srv.URL); err != nil {
		t.Fatal(err)
	}
	a.cfg.FXProviders = []string{"ecb"}
	ps, err := exchangerates.EnabledHTTPProviders(ctx, a.pool, []string{"ecb"})
	if err != nil || len(ps) != 1 {
		t.Fatalf("providers: %v %v", ps, err)
	}
	n, err := exchangerates.Fetch(ctx, a.pool, ps[0], "")
	if err != nil || n != 2 {
		t.Fatalf("fetch: %d %v", n, err)
	}
	var stored string
	_ = a.pool.QueryRow(ctx, `SELECT rate::text FROM exchange_rates WHERE quote_currency = 'USD'`).Scan(&stored)
	if stored != "1.123456789012345678" {
		t.Fatalf("rate precision lost: %s", stored)
	}
	// Refetch never updates in place.
	if n, _ := exchangerates.Fetch(ctx, a.pool, ps[0], ""); n != 0 {
		t.Fatalf("refetch inserted %d", n)
	}
	var conv struct {
		To       obj    `json:"to"`
		RateDate string `json:"rateDate"`
		Stale    bool   `json:"stale"`
	}
	// Historical date not cached -> fetched on demand.
	a.must(200, "POST", "/convert", obj{"amount": m("100.00", "EUR"), "to": "USD", "date": "2026-06-15"}, &conv)
	if conv.RateDate != "2026-06-15" || conv.To["amount"] != "112.35" || conv.Stale {
		t.Fatalf("historical fetch: %+v", conv)
	}
	// Provider down: falls back to the cached snapshot and says so.
	online = false
	a.must(200, "POST", "/convert", obj{"amount": m("100.00", "EUR"), "to": "USD", "date": "2026-09-30"}, &conv)
	if !conv.Stale || conv.RateDate != "2026-08-03" {
		t.Fatalf("offline fallback: %+v", conv)
	}
	var lastErr *string
	_ = a.pool.QueryRow(ctx, `SELECT last_error FROM exchange_rate_providers WHERE code = 'ecb'`).Scan(&lastErr)
	if lastErr == nil {
		t.Fatal("provider error not recorded")
	}
	// Admin refresh endpoint reports the outage.
	a.must(502, "POST", "/exchange-rate-providers/"+ps[0].ID.String()+"/refresh", nil, nil)
	if hits < 4 {
		t.Fatalf("provider hits %d", hits)
	}
}
