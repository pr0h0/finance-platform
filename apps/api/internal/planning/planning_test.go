package planning

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC) }
}

func TestAnnualize(t *testing.T) {
	a, m, err := Annualize(money.MustParse("9.99", "EUR"), "FREQ=MONTHLY")
	if err != nil || a.Amount() != "119.88" || m.Amount() != "9.99" {
		t.Fatalf("monthly: %v %v %v", a, m, err)
	}
	a, m, _ = Annualize(money.MustParse("120.00", "BAM"), "FREQ=YEARLY")
	if a.Amount() != "120.00" || m.Amount() != "10.00" {
		t.Fatalf("yearly: %v %v", a, m)
	}
	a, m, _ = Annualize(money.MustParse("10.00", "BAM"), "FREQ=WEEKLY;INTERVAL=2")
	if a.Amount() != "260.00" || m.Amount() != "21.67" {
		t.Fatalf("biweekly: %v %v", a, m)
	}
}

func TestPlansOccurrencesAndMatching(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")

	// Monthly rent on the 31st: month boundaries clamp (PLAN §46 case 11).
	var rent Plan
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{
		"kind": "expense", "accountId": acc, "description": "Rent", "amount": map[string]string{"amount": "800.00", "currency": "BAM"},
		"dueDate": "2026-08-31", "recurrence": map[string]any{"rrule": "FREQ=MONTHLY"}, "priority": "essential", "confidence": "certain",
	}, &rent)
	if rent.Recurrence == nil || rent.Recurrence.StartDate != "2026-08-31" || rent.Version != 1 {
		t.Fatalf("plan: %+v", rent)
	}
	var occ struct{ Items []Occurrence }
	api.Must(http.StatusOK, "GET", "/plans/occurrences?from=2026-09-01&to=2027-03-31", nil, &occ)
	var got []string
	for _, o := range occ.Items {
		got = append(got, o.Date)
	}
	want := []string{"2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if !occ.Items[0].Overdue {
		t.Fatal("September occurrence should be overdue on 2026-10-15")
	}

	// Pay September's rent; suggestions find it, matching it resolves the occurrence.
	tx := fintest.Txn(t, pool, profile, "expense", "2026-10-01", acc, "-800.00", "BAM", nil, "Landlord")
	var sugg struct{ Items []MatchSuggestion }
	api.Must(http.StatusOK, "GET", "/plans/match-suggestions?from=2026-09-01&to=2026-10-20", nil, &sugg)
	if len(sugg.Items) != 1 || sugg.Items[0].TransactionID != tx || sugg.Items[0].OccurrenceDate != "2026-09-30" {
		t.Fatalf("suggestions: %+v", sugg.Items)
	}
	var o Occurrence
	api.Must(http.StatusOK, "PUT", "/plans/"+rent.ID.String()+"/occurrences/2026-09-30", map[string]any{"status": "matched", "matchedTransactionId": tx}, &o)
	if o.Status != "matched" || o.MatchedTransactionID == nil || *o.MatchedTransactionID != tx {
		t.Fatalf("occurrence: %+v", o)
	}
	// The same transaction cannot satisfy a second occurrence (no double counting).
	api.Must(http.StatusConflict, "PUT", "/plans/"+rent.ID.String()+"/occurrences/2026-10-31", map[string]any{"status": "matched", "matchedTransactionId": tx}, nil)
	// A date that is not an occurrence is 404.
	api.Must(http.StatusNotFound, "PUT", "/plans/"+rent.ID.String()+"/occurrences/2026-10-30", map[string]any{"status": "skipped"}, nil)
	api.Must(http.StatusOK, "GET", "/plans/match-suggestions?from=2026-09-01&to=2026-10-20", nil, &sugg)
	if len(sugg.Items) != 0 {
		t.Fatalf("matched transaction suggested again: %+v", sugg.Items)
	}

	// Planned vs actual for September: planned 800, actual 800.
	var pva fin.Rows
	api.Must(http.StatusOK, "GET", "/plans/planned-vs-actual?from=2026-09-01&to=2026-09-30", nil, &pva)
	if len(pva.Rows) != 2 || pva.Rows[0].Actual == nil || pva.Rows[0].Actual.Amount() != "800.00" || pva.Rows[0].Variance.Amount() != "0.00" {
		t.Fatalf("pva: %+v", pva.Rows)
	}

	// Patch needs the version; stale version conflicts.
	api.Must(http.StatusUnprocessableEntity, "PATCH", "/plans/"+rent.ID.String(), map[string]any{"description": "Flat"}, nil)
	api.Must(http.StatusConflict, "PATCH", "/plans/"+rent.ID.String(), map[string]any{"description": "Flat", "version": 7}, nil)
	var patched Plan
	api.Must(http.StatusOK, "PATCH", "/plans/"+rent.ID.String(), map[string]any{"description": "Flat", "version": 1}, &patched)
	if patched.Description != "Flat" || patched.Amount.Amount() != "800.00" || patched.Recurrence == nil || patched.Version != 2 {
		t.Fatalf("patched: %+v", patched)
	}

	// Every mutation went through the change log.
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sync_changes WHERE profile_id = $1 AND entity_type IN ('planned_transactions','planned_occurrences','recurrence_schedules')`, profile).Scan(&n); err != nil || n < 4 {
		t.Fatalf("sync changes: %d %v", n, err)
	}
}

func TestInstallments(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	var p Plan
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{
		"kind": "expense", "description": "TV", "amount": map[string]string{"amount": "100.00", "currency": "BAM"},
		"dueDate": "2026-09-05", "recurrence": map[string]any{"rrule": "FREQ=MONTHLY"}, "installmentTotal": 6, "installmentStart": 2,
	}, &p)
	api.Must(http.StatusOK, "PUT", "/plans/"+p.ID.String()+"/occurrences/2026-09-05", map[string]any{"status": "paid_manual"}, nil)
	api.Must(http.StatusOK, "GET", "/plans/"+p.ID.String(), nil, &p)
	in := p.Installments
	// 1 paid before tracking + 1 paid now; 4 left (Oct..Jan).
	if in == nil || in.Paid != 2 || in.Remaining != 4 || in.Outstanding.Amount() != "400.00" || in.PaidAmount.Amount() != "100.00" || *in.NextDueDate != "2026-10-05" {
		t.Fatalf("installments: %+v", in)
	}
	var occ struct{ Items []Occurrence }
	api.Must(http.StatusOK, "GET", "/plans/occurrences?from=2026-09-01&to=2027-12-31", nil, &occ)
	if len(occ.Items) != 5 || *occ.Items[4].InstallmentNumber != 6 {
		t.Fatalf("installment occurrences: %+v", occ.Items)
	}
}

func TestSubscriptionLifecycle(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	var s Subscription
	api.Must(http.StatusCreated, "POST", "/subscriptions", map[string]any{
		"name": "Streaming", "amount": map[string]string{"amount": "9.99", "currency": "EUR"}, "nextDate": "2026-10-20",
	}, &s)
	if s.Annualized == nil || s.Annualized.Amount() != "119.88" || s.NextDate == nil || *s.NextDate != "2026-10-20" {
		t.Fatalf("created: %+v", s)
	}
	// Price change effective November: October keeps the old price.
	api.Must(http.StatusOK, "PATCH", "/subscriptions/"+s.ID.String(), map[string]any{
		"amount": map[string]string{"amount": "12.99", "currency": "EUR"}, "effectiveDate": "2026-11-01", "version": s.Version,
	}, &s)
	if s.Amount.Amount() != "12.99" || len(s.PriceHistory) != 2 || *s.PriceHistory[1].To != "2026-11-19" || s.PriceHistory[0].From != "2026-11-20" {
		t.Fatalf("price change: %+v", s)
	}
	var occ struct{ Items []Occurrence }
	api.Must(http.StatusOK, "GET", "/plans/occurrences?from=2026-10-01&to=2026-12-31", nil, &occ)
	if len(occ.Items) != 3 || occ.Items[0].Amount.Amount() != "9.99" || occ.Items[1].Amount.Amount() != "12.99" {
		t.Fatalf("occurrences after price change: %+v", occ.Items)
	}
	// Cancel on Dec 1: no more occurrences after it.
	api.Must(http.StatusOK, "PATCH", "/subscriptions/"+s.ID.String(), map[string]any{"status": "cancelled", "cancelledAt": "2026-12-01", "version": s.Version}, &s)
	api.Must(http.StatusOK, "GET", "/plans/occurrences?from=2026-10-01&to=2027-06-30", nil, &occ)
	if len(occ.Items) != 2 {
		t.Fatalf("occurrences after cancel: %+v", occ.Items)
	}
	if s.Status != "cancelled" || *s.CancelledAt != "2026-12-01" {
		t.Fatalf("cancel: %+v", s)
	}
	api.Must(http.StatusNoContent, "DELETE", "/subscriptions/"+s.ID.String(), nil, nil)
	api.Must(http.StatusNotFound, "GET", "/subscriptions/"+s.ID.String(), nil, nil)
}

func TestPlanValidationAndAuthz(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	_, other := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	foreignAcc := fintest.Account(t, pool, other, "Theirs", "checking", "BAM")
	var e struct {
		Error struct {
			Details struct{ Fields map[string]string }
		}
	}
	api.Must(http.StatusUnprocessableEntity, "POST", "/plans", map[string]any{
		"kind": "transfer", "accountId": foreignAcc, "amount": map[string]string{"amount": "-1.00", "currency": "BAM"}, "dueDate": "2026-13-01",
		"recurrence": map[string]any{"rrule": "FREQ=HOURLY"},
	}, &e)
	for _, f := range []string{"accountId", "amount", "dueDate", "toAccountId", "recurrence.rrule"} {
		if e.Error.Details.Fields[f] == "" {
			t.Errorf("expected validation error on %s: %+v", f, e.Error.Details.Fields)
		}
	}
	// Plans of another profile are invisible.
	otherAPI := fintest.NewAPI(t, pool, user, other, Register)
	otherAPI.Must(http.StatusForbidden, "GET", "/plans", nil, nil)
}
