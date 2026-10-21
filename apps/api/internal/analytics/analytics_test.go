package analytics

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC) }
}

func rowBy(t *testing.T, rows fin.Rows, key string) fin.Row {
	t.Helper()
	for _, r := range rows.Rows {
		if r.Key == key {
			return r
		}
	}
	t.Fatalf("row %q missing in %+v", key, rows.Rows)
	return fin.Row{}
}

func TestNormalizeMerchant(t *testing.T) {
	if got := NormalizeMerchant("KONZUM 123  Sarajevo #4411"); got != "konzum sarajevo" {
		t.Fatal(got)
	}
}

func TestAggregations(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	chk := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	card := fintest.Account(t, pool, profile, "Card", "credit_card", "BAM")
	usd := fintest.Account(t, pool, profile, "USD wallet", "wallet", "USD")
	food := fintest.Category(t, pool, profile, "Food", nil)
	rest := fintest.Category(t, pool, profile, "Restaurants", &food)
	shop := fintest.Merchant(t, pool, profile, "Konzum")

	fintest.Txn(t, pool, profile, "opening_balance", "2026-09-01", chk, "1000.00", "BAM", nil, "open")
	fintest.Txn(t, pool, profile, "income", "2026-10-01", chk, "2000.00", "BAM", nil, "Salary")
	groceries := fintest.Txn(t, pool, profile, "expense", "2026-10-02", card, "-100.00", "BAM", &food, "KONZUM 0042")
	_, _ = pool.Exec(fintest.Ctx(user), `UPDATE transactions SET merchant_id = $1 WHERE id = $2`, shop, groceries)
	fintest.Txn(t, pool, profile, "expense", "2026-10-03", chk, "-60.00", "BAM", &rest, "Pizza 12")
	fintest.Txn(t, pool, profile, "expense", "2026-10-04", chk, "-40.00", "BAM", &rest, "PIZZA 77")
	fintest.Txn(t, pool, profile, "refund", "2026-10-05", chk, "10.00", "BAM", &rest, "Pizza refund")
	// Credit-card payment is a transfer: card purchases count once, income is not inflated (PLAN §46 cases 3, 4, 7).
	fintest.Transfer(t, pool, profile, "2026-10-06", chk, card, "100.00", "BAM")
	// USD spending: valued at its booking-date rate; one date has no rate.
	fintest.Rate(t, pool, profile, "USD", "BAM", "1.800000", "2026-10-01")
	fintest.Rate(t, pool, profile, "USD", "BAM", "1.700000", "2026-10-08")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", usd, "500.00", "USD", nil, "open")
	fintest.Txn(t, pool, profile, "expense", "2026-10-07", usd, "-10.00", "USD", &food, "Snack")
	fintest.Txn(t, pool, profile, "expense", "2026-10-09", usd, "-20.00", "USD", &food, "Snack 2")

	var res fin.Rows
	api.Must(http.StatusOK, "GET", "/analytics/spending-by-category?from=2026-10-01&to=2026-10-31", nil, &res)
	// Food own: 100 + 18.00 (10 USD @1.8) + 34.00 (20 USD @1.7); Restaurants 60 + 40 - 10 = 90.
	if rowBy(t, res, food.String()).Amount.Amount() != "152.00" || rowBy(t, res, rest.String()).Amount.Amount() != "90.00" || *rowBy(t, res, rest.String()).ParentKey != food.String() {
		t.Fatalf("by category: %+v", res.Rows)
	}
	if res.Total.Amount() != "242.00" || !res.Complete {
		t.Fatalf("total %v complete %v", res.Total, res.Complete)
	}
	api.Must(http.StatusOK, "GET", "/analytics/spending-by-category?from=2026-10-01&to=2026-10-31&groupBy=parent", nil, &res)
	if len(res.Rows) != 1 || res.Rows[0].Amount.Amount() != "242.00" {
		t.Fatalf("parent rollup: %+v", res.Rows)
	}

	api.Must(http.StatusOK, "GET", "/analytics/income-vs-expenses?from=2026-10-01&to=2026-10-31&interval=month", nil, &res)
	if rowBy(t, res, "2026-10:income").Amount.Amount() != "2000.00" || rowBy(t, res, "2026-10:expenses").Amount.Amount() != "242.00" || res.Total.Amount() != "1758.00" {
		t.Fatalf("income vs expenses: %+v", res.Rows)
	}
	api.Must(http.StatusOK, "GET", "/analytics/savings-rate?from=2026-10-01&to=2026-10-31&interval=month", nil, &res)
	if *rowBy(t, res, "2026-10").Value != "0.8790" {
		t.Fatalf("savings rate: %+v", res.Rows)
	}

	api.Must(http.StatusOK, "GET", "/analytics/spending-by-merchant?from=2026-10-01&to=2026-10-31", nil, &res)
	if rowBy(t, res, shop.String()).Amount.Amount() != "100.00" || rowBy(t, res, "name:pizza").Count != 2 {
		t.Fatalf("by merchant: %+v", res.Rows)
	}

	// Net worth on Oct 31: checking 1000+2000-60-40+10-100 = 2810; USD 470 @1.7 = 799; card -100+100 = 0.
	api.Must(http.StatusOK, "GET", "/analytics/net-worth?from=2026-10-01&to=2026-10-31", nil, &res)
	if rowBy(t, res, "2026-10:assets").Amount.Amount() != "3609.00" || rowBy(t, res, "2026-10:liabilities").Amount.Amount() != "0.00" || res.Total.Amount() != "3609.00" {
		t.Fatalf("net worth: %+v", res.Rows)
	}
	api.Must(http.StatusOK, "GET", "/analytics/currency-exposure?to=2026-10-31", nil, &res)
	if rowBy(t, res, "USD").Native.Amount() != "470.00" || rowBy(t, res, "USD").Amount.Amount() != "799.00" {
		t.Fatalf("exposure: %+v", res.Rows)
	}

	// Missing rate: EUR reporting with a GBP expense that has no rate at all.
	gbp := fintest.Account(t, pool, profile, "GBP", "cash", "GBP")
	fintest.Txn(t, pool, profile, "expense", "2026-10-10", gbp, "-5.00", "GBP", &food, "Tea")
	api.Must(http.StatusOK, "GET", "/analytics/spending-by-category?from=2026-10-01&to=2026-10-31", nil, &res)
	if res.Complete || len(res.MissingRates) != 1 || res.MissingRates[0].From != "GBP" || res.Total.Amount() != "242.00" {
		t.Fatalf("missing rate handling: complete=%v missing=%+v total=%v", res.Complete, res.MissingRates, res.Total)
	}

	api.Must(http.StatusOK, "GET", "/analytics/compare?from=2026-10-01&to=2026-10-31&compareFrom=2026-09-01&compareTo=2026-09-30", nil, &res)
	f := rowBy(t, res, food.String())
	if f.Previous == nil || f.Previous.Amount() != "0.00" || f.Amount.Amount() != "242.00" {
		t.Fatalf("compare: %+v", f)
	}

	// Reports in all formats.
	var rep Report
	api.Must(http.StatusOK, "GET", "/reports/custom?from=2026-10-01&to=2026-10-31", nil, &rep)
	if rep.Income.Amount() != "2000.00" || rep.Expenses.Amount() != "242.00" || rep.Complete {
		t.Fatalf("report: %+v", rep)
	}
	for _, format := range []string{"csv", "pdf"} {
		req := httptest.NewRequest("GET", "/api/v1/reports/monthly?from=2026-10-01&format="+format, nil)
		req.Header.Set(authz.ProfileHeader, profile.String())
		rec := httptest.NewRecorder()
		fintest.NewAPI(t, pool, user, profile, Register).Handler().ServeHTTP(rec, req)
		body := rec.Body.String()
		if rec.Code != 200 || (format == "csv" && !strings.Contains(body, "summary,Expenses,2026-10-01..2026-10-31,242.00,BAM")) || (format == "pdf" && !strings.HasPrefix(body, "%PDF-1.4")) {
			t.Fatalf("%s report: %d %s", format, rec.Code, body[:min(300, len(body))])
		}
	}
}

func TestAnomaliesAndInsights(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	chk := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	food := fintest.Category(t, pool, profile, "Food", nil)
	for i := 0; i < 8; i++ {
		fintest.Txn(t, pool, profile, "expense", fmt.Sprintf("2026-%02d-10", 5+i/2), chk, "-30.00", "BAM", &food, "Market")
	}
	big := fintest.Txn(t, pool, profile, "expense", "2026-10-12", chk, "-200.00", "BAM", &food, "Market")
	var out struct{ Items []Anomaly }
	api.Must(http.StatusOK, "GET", "/analytics/anomalies?from=2026-10-01&to=2026-10-31", nil, &out)
	if len(out.Items) != 1 || out.Items[0].TransactionID != big || out.Items[0].Rule != ruleCategory || out.Items[0].Baseline.Amount() != "30.00" {
		t.Fatalf("anomalies: %+v", out.Items)
	}
	api.Must(http.StatusNoContent, "POST", "/analytics/anomalies/"+big.String()+"/dismiss?rule="+ruleCategory, nil, nil)
	api.Must(http.StatusNoContent, "POST", "/analytics/anomalies/"+big.String()+"/dismiss?rule="+ruleCategory, nil, nil) // idempotent
	api.Must(http.StatusOK, "GET", "/analytics/anomalies?from=2026-10-01&to=2026-10-31", nil, &out)
	if len(out.Items) != 0 {
		t.Fatalf("dismissed anomaly still listed: %+v", out.Items)
	}
	api.Must(http.StatusOK, "GET", "/analytics/anomalies?from=2026-10-01&to=2026-10-31&includeDismissed=true", nil, &out)
	if len(out.Items) != 1 || !out.Items[0].Dismissed {
		t.Fatalf("includeDismissed: %+v", out.Items)
	}
	api.Must(http.StatusNoContent, "DELETE", "/analytics/anomalies/"+big.String()+"/dismiss?rule="+ruleCategory, nil, nil)

	// September spending spike: 60/month in Jun..Aug -> Sep 300 is +400%.
	fintest.Txn(t, pool, profile, "expense", "2026-09-20", chk, "-300.00", "BAM", &food, "Party")
	fintest.Txn(t, pool, profile, "income", "2026-09-01", chk, "1000.00", "BAM", nil, "Salary")
	var ins struct{ Items []Insight }
	api.Must(http.StatusOK, "GET", "/analytics/insights", nil, &ins)
	kinds := map[string]bool{}
	for _, i := range ins.Items {
		kinds[i.Kind] = true
	}
	if !kinds["category_spike"] || !kinds["savings_rate"] {
		t.Fatalf("insights: %+v", ins.Items)
	}
}
