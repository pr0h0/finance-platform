package savings

import (
	"net/http"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC) }
}

func TestGoalsContributionsAndProjection(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	m := func(a string) map[string]string { return map[string]string{"amount": a, "currency": "BAM"} }

	var g Goal
	api.Must(http.StatusCreated, "POST", "/goals", map[string]any{"name": "Bike", "targetAmount": m("1200.00"), "startingAmount": m("200.00"), "targetDate": "2027-04-15"}, &g)
	// 1000 left over 6 months -> 166.67 per month (rounded up).
	if g.Saved.Amount() != "200.00" || g.RequiredMonthly.Amount() != "166.67" || g.EstimatedCompletion != nil || g.OnTrack || g.Progress != "0.1667" {
		t.Fatalf("new goal: %+v", g)
	}
	var c Contribution
	api.Must(http.StatusCreated, "POST", "/goals/"+g.ID.String()+"/contributions", map[string]any{"amount": m("300.00"), "contributionDate": "2026-09-01"}, &c)
	api.Must(http.StatusCreated, "POST", "/goals/"+g.ID.String()+"/contributions", map[string]any{"amount": m("-50.00"), "contributionDate": "2026-10-01"}, nil)
	api.Must(http.StatusUnprocessableEntity, "POST", "/goals/"+g.ID.String()+"/contributions", map[string]any{"amount": map[string]string{"amount": "5.00", "currency": "EUR"}, "contributionDate": "2026-10-01"}, nil)
	api.Must(http.StatusOK, "GET", "/goals/"+g.ID.String(), nil, &g)
	// saved 450; 250 net per 6 months; 750 left -> 18 months -> 2028-04-15 (not on track for 2027-04-15).
	if g.Saved.Amount() != "450.00" || g.Basis != "history" || g.EstimatedCompletion == nil || *g.EstimatedCompletion != "2028-04-15" || g.OnTrack {
		t.Fatalf("after contributions: %+v", g)
	}
	// Reaching the target completes the goal.
	api.Must(http.StatusCreated, "POST", "/goals/"+g.ID.String()+"/contributions", map[string]any{"amount": m("750.00"), "contributionDate": "2026-10-15"}, nil)
	api.Must(http.StatusOK, "GET", "/goals/"+g.ID.String(), nil, &g)
	if g.Status != "completed" || g.CompletedAt == nil || !g.OnTrack {
		t.Fatalf("completed: %+v", g)
	}
	api.Must(http.StatusNoContent, "DELETE", "/goals/"+g.ID.String()+"/contributions/"+c.ID.String(), nil, nil)
	var list struct{ Items []Contribution }
	api.Must(http.StatusOK, "GET", "/goals/"+g.ID.String()+"/contributions", nil, &list)
	if len(list.Items) != 2 {
		t.Fatalf("contributions: %d", len(list.Items))
	}

	// Account-backed goal with a planned monthly transfer of 250 into it.
	checking := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	savingsAcc := fintest.Account(t, pool, profile, "Savings", "savings", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-10-01", savingsAcc, "500.00", "BAM", nil, "open")
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "transfer", "accountId": checking, "toAccountId": savingsAcc, "description": "Save",
		"amount": m("250.00"), "dueDate": "2026-11-01", "recurrence": map[string]any{"rrule": "FREQ=MONTHLY"}}, nil)
	var car Goal
	api.Must(http.StatusCreated, "POST", "/goals", map[string]any{"name": "Car", "targetAmount": m("1500.00"), "accountId": savingsAcc, "targetDate": "2027-03-01"}, &car)
	if car.Saved.Amount() != "500.00" || car.Basis != "planned" || *car.EstimatedCompletion != "2027-02-01" || !car.OnTrack {
		t.Fatalf("planned goal: %+v", car)
	}
}

func TestEmergencyFund(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	card := fintest.Account(t, pool, profile, "Card", "credit_card", "BAM")
	fintest.Txn(t, pool, profile, "opening_balance", "2026-01-01", acc, "3000.00", "BAM", nil, "open")
	fintest.Txn(t, pool, profile, "expense", "2026-05-10", card, "-600.00", "BAM", nil, "card spend")

	var ef EmergencyFund
	// No essential plans: average of the last 6 full months (Apr..Sep) = 600 / 6 = 100.
	api.Must(http.StatusOK, "GET", "/goals/emergency-fund", nil, &ef)
	if ef.Reserves.Amount() != "3000.00" || ef.EssentialMonthly.Amount() != "100.00" || *ef.MonthsCovered != "30.0" || ef.ExpensesBasis != "average_spending_6_months" {
		t.Fatalf("history basis: %+v", ef)
	}
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "expense", "accountId": acc, "description": "Rent", "priority": "essential",
		"amount": map[string]string{"amount": "800.00", "currency": "BAM"}, "dueDate": "2026-11-01", "recurrence": map[string]any{"rrule": "FREQ=MONTHLY"}}, nil)
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "expense", "accountId": acc, "description": "Insurance", "priority": "essential",
		"amount": map[string]string{"amount": "1200.00", "currency": "BAM"}, "dueDate": "2027-01-10", "recurrence": map[string]any{"rrule": "FREQ=YEARLY"}}, nil)
	api.Must(http.StatusOK, "GET", "/goals/emergency-fund", nil, &ef)
	// 800 + 100 = 900 per month; 3000 / 900 = 3.3 months; target 6 months = 5400 -> shortfall 2400.
	if ef.EssentialMonthly.Amount() != "900.00" || *ef.MonthsCovered != "3.3" || ef.Target.Amount() != "5400.00" || ef.Shortfall.Amount() != "2400.00" {
		t.Fatalf("plan basis: %+v", ef)
	}
}
