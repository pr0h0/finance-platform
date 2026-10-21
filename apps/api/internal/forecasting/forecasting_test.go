package forecasting

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC) }
}

func bam(s string) money.Money { return money.MustParse(s, "BAM") }

func TestScenarioRules(t *testing.T) {
	lo, hi := bam("80.00"), bam("120.00")
	e, c, o := Scenarios(-1, "expense", "possible", bam("100.00"), &lo, &hi)
	if e.Amount() != "-100.00" || c.Amount() != "-120.00" || o != nil {
		t.Fatalf("possible expense: %v %v %v", e, c, o)
	}
	e, c, o = Scenarios(1, "income", "expected", bam("100.00"), &lo, &hi)
	if e.Amount() != "100.00" || c != nil || o.Amount() != "120.00" {
		t.Fatalf("expected income: %v %v %v", e, c, o)
	}
	e, c, o = Scenarios(-1, "expense", "speculative", bam("100.00"), nil, nil)
	if e != nil || c.Amount() != "-100.00" || o != nil {
		t.Fatalf("speculative expense: %v %v %v", e, c, o)
	}
}

func TestProjectPure(t *testing.T) {
	acc := uuid.New()
	ev := func(d string, amt string) Event {
		m := bam(amt)
		e, c, o := Certain(m)
		return Event{Date: fin.MustDate(d), AccountID: &acc, Expected: e, Conservative: c, Optimistic: o}
	}
	f := Project(Input{From: fin.MustDate("2026-10-01"), To: fin.MustDate("2026-10-31"), Currency: "BAM",
		Start: map[uuid.UUID]money.Money{acc: bam("100.00")}, Events: []Event{ev("2026-10-05", "-150.00"), ev("2026-10-07", "100.00"), ev("2026-10-20", "-60.00")},
		Reserve: bam("0.00"), MonthEnd: fin.MustDate("2026-10-31")})
	if len(f.Days) != 31 || f.Lowest.Amount.Amount() != "-50.00" || f.Lowest.Date != "2026-10-05" || f.MonthEnd.Amount() != "-10.00" {
		t.Fatalf("projection: lowest %+v monthEnd %v", f.Lowest, f.MonthEnd)
	}
	// account + total shortfalls, each two runs: Oct 5-6 and Oct 20..end.
	var accRuns int
	for _, s := range f.Shortfalls {
		if s.AccountID != nil && s.Scenario == "expected" {
			accRuns++
		}
	}
	if accRuns != 2 || *f.Shortfalls[0].Until != "2026-10-06" {
		t.Fatalf("shortfalls: %+v", f.Shortfalls)
	}
}

// PLAN §46 case 12 (mid-month negative balance) and 13 (matched plans not counted again).
func TestCashFlowForecast(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", acc, "500.00", "BAM", nil, "Opening")

	plan := func(kind, desc, amount, due, conf string) planning.Plan {
		var p planning.Plan
		api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": kind, "accountId": acc, "description": desc,
			"amount": map[string]string{"amount": amount, "currency": "BAM"}, "dueDate": due, "confidence": conf,
			"recurrence": map[string]any{"rrule": "FREQ=MONTHLY"}}, &p)
		return p
	}
	plan("expense", "Rent", "800.00", "2026-10-20", "certain")
	plan("income", "Salary", "1000.00", "2026-10-25", "certain")
	phone := plan("expense", "Phone", "40.00", "2026-10-10", "certain") // overdue unless matched
	plan("income", "Maybe bonus", "300.00", "2026-10-28", "possible")

	// The phone bill was paid on Oct 10 and matched: it must not be counted again.
	paid := fintest.Txn(t, pool, profile, "expense", "2026-10-10", acc, "-40.00", "BAM", nil, "Phone")
	api.Must(http.StatusOK, "PUT", "/plans/"+phone.ID.String()+"/occurrences/2026-10-10", map[string]any{"status": "matched", "matchedTransactionId": paid}, nil)

	var f Forecast
	api.Must(http.StatusOK, "GET", "/forecasts/cash-flow?days=30", nil, &f)
	// Start: 500 - 40 = 460. Oct 20: -340 (mid-month negative), Oct 25: +660, Nov 10 phone: 620, Nov 14 end.
	if f.Start.Amount() != "460.00" || f.Lowest.Date != "2026-10-20" || f.Lowest.Amount.Amount() != "-340.00" {
		t.Fatalf("start %v lowest %+v", f.Start, f.Lowest)
	}
	if f.MonthEnd.Amount() != "660.00" {
		t.Fatalf("month end %v", f.MonthEnd)
	}
	found := false
	for _, s := range f.Shortfalls {
		if s.AccountID != nil && *s.AccountID == acc && s.Date == "2026-10-20" && *s.Until == "2026-10-24" && s.Amount.Amount() == "-340.00" {
			found = true
		}
	}
	if !found {
		t.Fatalf("mid-month shortfall not detected: %+v", f.Shortfalls)
	}
	for _, d := range f.Days {
		for _, e := range d.Events {
			if e.SourceID == phone.ID && d.Date == "2026-10-15" {
				t.Fatal("matched phone occurrence counted again (as overdue)")
			}
		}
	}
	// Optimistic includes the possible bonus, expected does not.
	last := f.Days[len(f.Days)-1]
	if last.Expected.Amount() != "620.00" || last.Optimistic.Amount() != "920.00" || last.Conservative.Amount() != "620.00" {
		t.Fatalf("scenarios at end: %+v", last)
	}
	if f.SafeToSpend.Amount() != "0.00" || f.SafeToSpendUntil != "2026-10-24" {
		t.Fatalf("safe to spend %v until %s", f.SafeToSpend, f.SafeToSpendUntil)
	}

	// What-if: an extra 1000 BAM income on Oct 18 removes the shortfall; nothing is written.
	var before, after int64
	ctx := context.Background()
	_ = pool.QueryRow(ctx, `SELECT sync_version FROM profiles WHERE id = $1`, profile).Scan(&before)
	var sim Forecast
	api.Must(http.StatusOK, "POST", "/forecasts/scenarios", map[string]any{"days": 30, "adjustments": []map[string]any{
		{"description": "Gift", "accountId": acc, "amount": map[string]string{"amount": "1000.00", "currency": "BAM"}, "date": "2026-10-18"},
	}}, &sim)
	_ = pool.QueryRow(ctx, `SELECT sync_version FROM profiles WHERE id = $1`, profile).Scan(&after)
	if before != after {
		t.Fatal("simulation mutated data")
	}
	if sim.Lowest.Amount.Amount() != "460.00" || len(sim.Shortfalls) != 0 {
		t.Fatalf("simulation: lowest %+v shortfalls %+v", sim.Lowest, sim.Shortfalls)
	}
	var s2t struct {
		Amount money.Money
		Until  string
	}
	api.Must(http.StatusOK, "GET", "/forecasts/safe-to-spend?reserve=100.00", nil, &s2t)
	if s2t.Amount.Amount() != "0.00" {
		t.Fatalf("safe-to-spend: %+v", s2t)
	}
	var lt Forecast
	api.Must(http.StatusOK, "GET", "/forecasts/long-term?months=12", nil, &lt)
	// 12 month ends + final day; net +160/month after October.
	if len(lt.Days) < 12 || lt.Days[0].Date != "2026-10-31" || lt.Days[0].Expected.Amount() != "660.00" || lt.Days[1].Expected.Amount() != "820.00" {
		t.Fatalf("long term: %+v", lt.Days[:2])
	}
}
