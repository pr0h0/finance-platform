package budgets

import (
	"net/http"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin/fintest"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func init() {
	fin.Now = func() time.Time { return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC) }
}

func TestPeriodFor(t *testing.T) {
	cases := []struct {
		typ          string
		anchor       int
		start, d     string
		wantS, wantE string
	}{
		{"monthly", 1, "2026-01-01", "2026-10-15", "2026-10-01", "2026-10-31"},
		{"monthly", 25, "2026-01-01", "2026-10-15", "2026-09-25", "2026-10-24"}, // salary-day month
		{"monthly", 31, "2026-01-01", "2026-02-15", "2026-01-31", "2026-02-27"}, // anchor clamps to Feb 28
		{"monthly", 31, "2026-01-01", "2026-03-05", "2026-02-28", "2026-03-30"},
		{"weekly", 1, "2026-10-05", "2026-10-15", "2026-10-12", "2026-10-18"},
		{"quarterly", 1, "2026-01-01", "2026-08-10", "2026-07-01", "2026-09-30"},
		{"yearly", 1, "2026-04-01", "2027-02-01", "2026-04-01", "2027-03-31"},
		{"monthly", 1, "2026-10-10", "2026-10-15", "2026-10-10", "2026-10-31"}, // first period starts at budget start
	}
	for _, c := range cases {
		s, e, ok := PeriodFor(Budget{PeriodType: c.typ, PeriodAnchorDay: c.anchor, StartDate: c.start}, fin.MustDate(c.d))
		if !ok || fin.Fmt(s) != c.wantS || fin.Fmt(e) != c.wantE {
			t.Errorf("%s/%d %s: got %s..%s want %s..%s", c.typ, c.anchor, c.d, fin.Fmt(s), fin.Fmt(e), c.wantS, c.wantE)
		}
	}
	end := "2026-03-31"
	if _, _, ok := PeriodFor(Budget{PeriodType: "custom", StartDate: "2026-01-01", EndDate: &end}, fin.MustDate("2026-04-01")); ok {
		t.Error("date after a custom budget must be outside")
	}
}

func TestCarry(t *testing.T) {
	m := func(s string) money.Money { return money.MustParse(s, "BAM") }
	cases := []struct{ policy, limit, in, actual, want string }{
		{"carry_surplus", "500.00", "0.00", "420.00", "80.00"},
		{"carry_surplus", "500.00", "0.00", "520.00", "0.00"},
		{"carry_deficit", "500.00", "0.00", "520.00", "-20.00"},
		{"carry_deficit", "500.00", "0.00", "420.00", "0.00"},
		{"carry_both", "500.00", "30.00", "600.00", "-70.00"},
		{"none", "500.00", "0.00", "100.00", "0.00"},
	}
	for _, c := range cases {
		if got := Carry(c.policy, m(c.limit), m(c.in), m(c.actual)); got.Amount() != c.want {
			t.Errorf("%+v: got %s", c, got.Amount())
		}
	}
}

// PLAN §46 case 10 (actual and planned separately) and 13 (matched plans not double counted).
func TestBudgetActualVsPlanned(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register, planning.Register)
	acc := fintest.Account(t, pool, profile, "Checking", "checking", "BAM")
	eurCard := fintest.Account(t, pool, profile, "EUR card", "checking", "EUR")
	food := fintest.Category(t, pool, profile, "Food", nil)
	groceries := fintest.Category(t, pool, profile, "Groceries", &food)
	fun := fintest.Category(t, pool, profile, "Fun", nil)

	var b Budget
	api.Must(http.StatusCreated, "POST", "/budgets", map[string]any{
		"name": "Monthly", "periodType": "monthly", "startDate": "2026-01-01", "currency": "BAM", "rolloverPolicy": "carry_surplus",
		"alertThresholds": []string{"0.5", "0.8", "1.0"},
		"allocations": []map[string]any{
			{"categoryId": food, "amount": map[string]string{"amount": "500.00", "currency": "BAM"}},
			{"categoryId": nil, "amount": map[string]string{"amount": "1500.00", "currency": "BAM"}},
		},
	}, &b)

	// Actual: 120 BAM groceries (subcategory rolls up into Food) + 10 EUR (= 19.56 BAM at the fixed rate),
	// a 20 BAM refund, and 50 BAM fun (only in the overall line). Income and transfers never count.
	marketID := fintest.Txn(t, pool, profile, "expense", "2026-10-03", acc, "-120.00", "BAM", &groceries, "Market")
	fintest.Txn(t, pool, profile, "expense", "2026-10-04", eurCard, "-10.00", "EUR", &food, "Cafe")
	fintest.Txn(t, pool, profile, "refund", "2026-10-05", acc, "20.00", "BAM", &groceries, "Market refund")
	fintest.Txn(t, pool, profile, "expense", "2026-10-06", acc, "-50.00", "BAM", &fun, "Cinema")
	fintest.Txn(t, pool, profile, "income", "2026-10-01", acc, "3000.00", "BAM", nil, "Salary")
	fintest.Transfer(t, pool, profile, "2026-10-02", acc, eurCard, "100.00", "BAM")
	fintest.Txn(t, pool, profile, "expense", "2026-09-30", acc, "-999.00", "BAM", &groceries, "previous month")

	// Planned: weekly grocery run 50 BAM on Fridays; Oct 2 & 9 already happened.
	var plan planning.Plan
	api.Must(http.StatusCreated, "POST", "/plans", map[string]any{"kind": "expense", "accountId": acc, "categoryId": groceries, "description": "Groceries",
		"amount": map[string]string{"amount": "50.00", "currency": "BAM"}, "dueDate": "2026-10-02", "recurrence": map[string]any{"rrule": "FREQ=WEEKLY"}}, &plan)
	// Oct 2 was paid by the 120 BAM market transaction (matched), Oct 9 skipped.
	api.Must(http.StatusOK, "PUT", "/plans/"+plan.ID.String()+"/occurrences/2026-10-02", map[string]any{"status": "matched", "matchedTransactionId": marketID}, nil)
	api.Must(http.StatusOK, "PUT", "/plans/"+plan.ID.String()+"/occurrences/2026-10-09", map[string]any{"status": "skipped"}, nil)

	var st Status
	api.Must(http.StatusOK, "GET", "/budgets/"+b.ID.String()+"/status?date=2026-10-15", nil, &st)
	if st.PeriodStart != "2026-10-01" || st.PeriodEnd != "2026-10-31" || !st.Complete {
		t.Fatalf("period: %+v", st)
	}
	foodLine, all := st.Lines[1], st.Lines[0]
	if foodLine.CategoryID == nil || *foodLine.CategoryID != food {
		foodLine, all = st.Lines[0], st.Lines[1]
	}
	// actual food = 120 + 19.56 - 20 = 119.56; planned = Oct 16, 23, 30 = 150 (matched Oct 2 and skipped Oct 9 excluded).
	if foodLine.Actual.Amount() != "119.56" || foodLine.Planned.Amount() != "150.00" || foodLine.Remaining.Amount() != "230.44" {
		t.Fatalf("food line: %+v", foodLine)
	}
	if *foodLine.Utilization != "0.2391" || foodLine.Alert != nil || *foodLine.ProjectedUtilization != "0.5391" {
		t.Fatalf("food utilization: %+v", foodLine)
	}
	if all.Actual.Amount() != "169.56" || all.Planned.Amount() != "150.00" || st.Totals.Remaining.Amount() != "1180.44" {
		t.Fatalf("overall line: %+v totals %+v", all, st.Totals)
	}

	// Close October: carry_surplus moves 500 - 119.56 = 380.44 into November.
	api.Must(http.StatusOK, "POST", "/budgets/"+b.ID.String()+"/periods/close?date=2026-10-15", nil, &st)
	api.Must(http.StatusConflict, "POST", "/budgets/"+b.ID.String()+"/periods/close?date=2026-10-15", nil, nil)
	api.Must(http.StatusOK, "GET", "/budgets/"+b.ID.String()+"/status?date=2026-11-10", nil, &st)
	for _, l := range st.Lines {
		if l.CategoryID != nil && *l.CategoryID == food && (l.RolloverIn.Amount() != "380.44" || l.Limit.Amount() != "500.00") {
			t.Fatalf("november food line: %+v", l)
		}
	}
	// Alerts: 0.5 threshold reached when actual >= 250.
	fintest.Txn(t, pool, profile, "expense", "2026-10-20", acc, "-200.00", "BAM", &food, "Feast")
	api.Must(http.StatusOK, "GET", "/budgets/"+b.ID.String()+"/status?date=2026-10-20", nil, &st)
	for _, l := range st.Lines {
		if l.CategoryID != nil && *l.CategoryID == food && (l.Alert == nil || *l.Alert != "0.5") {
			t.Fatalf("expected 0.5 alert: %+v", l)
		}
	}
	alerts, err := CurrentAlerts(fintest.Ctx(user), pool, profile, fin.MustDate("2026-10-20"))
	if err != nil || len(alerts) != 1 {
		t.Fatalf("alerts: %+v %v", alerts, err)
	}
}

func TestTemplates(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	cat := fintest.Category(t, pool, profile, "Rent", nil)
	var tpl, b Budget
	api.Must(http.StatusCreated, "POST", "/budgets", map[string]any{"name": "Lean month", "periodType": "monthly", "startDate": "2026-01-01",
		"currency": "BAM", "isTemplate": true, "allocations": []map[string]any{{"categoryId": cat, "amount": map[string]string{"amount": "700.00", "currency": "BAM"}}}}, &tpl)
	api.Must(http.StatusCreated, "POST", "/budgets/"+tpl.ID.String()+"/instantiate", map[string]any{"name": "Nov", "startDate": "2026-11-01"}, &b)
	if b.IsTemplate || b.TemplateID == nil || *b.TemplateID != tpl.ID || len(b.Allocations) != 1 || b.Allocations[0].Amount.Amount() != "700.00" {
		t.Fatalf("instance: %+v", b)
	}
	api.Must(http.StatusUnprocessableEntity, "POST", "/budgets/"+b.ID.String()+"/instantiate", map[string]any{"startDate": "2026-12-01"}, nil)
	api.Must(http.StatusUnprocessableEntity, "POST", "/budgets", map[string]any{"name": "x", "periodType": "custom", "startDate": "2026-01-01", "currency": "BAM",
		"allocations": []map[string]any{{"categoryId": nil, "amount": map[string]string{"amount": "1.00", "currency": "EUR"}}}}, nil)
	var patched Budget
	api.Must(http.StatusOK, "PATCH", "/budgets/"+b.ID.String(), map[string]any{"name": "November", "version": b.Version}, &patched)
	if patched.Name != "November" || len(patched.Allocations) != 1 || patched.PeriodType != "monthly" {
		t.Fatalf("patched: %+v", patched)
	}
}

// Sync clients keep allocations in their own budget_allocations table, so every REST/MCP write of a
// budget's allocations must reach them as budget_allocations changes (not only inside the budget).
func TestAllocationsAreSyncChanges(t *testing.T) {
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	api := fintest.NewAPI(t, pool, user, profile, Register)
	food := fintest.Category(t, pool, profile, "Food", nil)
	amt := func(s string) map[string]string { return map[string]string{"amount": s, "currency": "BAM"} }
	var b Budget
	api.Must(http.StatusCreated, "POST", "/budgets", map[string]any{"name": "Oct", "periodType": "monthly", "startDate": "2026-10-01",
		"currency": "BAM", "rolloverPolicy": "carry_surplus", "allocations": []map[string]any{{"categoryId": nil, "amount": amt("500.00")}, {"categoryId": food, "amount": amt("100.00")}}}, &b)
	count := func(op string) int {
		var n int
		if err := pool.QueryRow(fintest.Ctx(user), `SELECT count(*) FROM sync_changes c JOIN budget_allocations a ON a.id = c.entity_id
			WHERE c.profile_id = $1 AND c.entity_type = 'budget_allocations' AND c.op = $2 AND a.budget_id = $3`, profile, op, b.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count("upsert") != 2 || count("delete") != 0 {
		t.Fatalf("create: upserts %d deletes %d", count("upsert"), count("delete"))
	}
	var bid, a string
	if err := pool.QueryRow(fintest.Ctx(user), `SELECT c.data->>'budgetId', c.data->'amount'->>'amount' FROM sync_changes c JOIN budget_allocations a ON a.id = c.entity_id
		WHERE c.entity_type = 'budget_allocations' AND a.category_id = $1`, food).Scan(&bid, &a); err != nil || bid != b.ID.String() || a != "100.00" {
		t.Fatalf("snapshot %s %s %v", bid, a, err)
	}
	api.Must(http.StatusOK, "PATCH", "/budgets/"+b.ID.String(), map[string]any{"version": b.Version, "allocations": []map[string]any{{"categoryId": nil, "amount": amt("600.00")}}}, &b)
	if count("upsert") != 3 || count("delete") != 2 {
		t.Fatalf("update: upserts %d deletes %d", count("upsert"), count("delete"))
	}
	// period close writes next-period rollover rows: they sync too
	api.Must(http.StatusOK, "POST", "/budgets/"+b.ID.String()+"/periods/close?date=2026-10-15", nil, nil)
	if count("upsert") != 4 {
		t.Fatalf("close: upserts %d", count("upsert"))
	}
}
