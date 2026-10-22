// Package conformance_test runs the shared engine fixtures in packages/test-fixtures/conformance
// against the Go implementations (TypeScript runners: packages/finance-engine/src/
// engine-conformance.test.ts and packages/forecasting/src/conformance.test.ts). Families without an
// exported Go function yet are skipped with the function they wait for; their fixtures are still
// decoded and every money value is validated, so a malformed fixture fails here too.
package conformance_test

import (
	"context"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

const fixtureDir = "../../../../packages/test-fixtures/conformance"

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name+".json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

type wire struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

func (w wire) money(t *testing.T) money.Money {
	t.Helper()
	m, err := money.Parse(w.Amount, w.Currency)
	if err != nil {
		t.Fatalf("fixture money %v: %v", w, err)
	}
	return m
}

func day(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("fixture date %q: %v", s, err)
	}
	return d
}

// validateMoney walks decoded JSON and parses every {amount, currency} object.
func validateMoney(t *testing.T, v any) int {
	t.Helper()
	n := 0
	switch x := v.(type) {
	case map[string]any:
		a, okA := x["amount"].(string)
		c, okC := x["currency"].(string)
		if okA && okC && len(x) == 2 {
			if _, err := money.Parse(a, c); err != nil {
				t.Errorf("invalid money in fixture: %v (%v)", x, err)
			}
			return 1
		}
		for _, e := range x {
			n += validateMoney(t, e)
		}
	case []any:
		for _, e := range x {
			n += validateMoney(t, e)
		}
	}
	return n
}

func TestFixturesWellFormed(t *testing.T) {
	for _, name := range []string{"recurrence", "subscriptions", "fx_lookup", "aggregation", "budgets", "forecast"} {
		var v any
		load(t, name, &v)
		if validateMoney(t, v) == 0 && name != "recurrence" {
			t.Errorf("%s: no money values found", name)
		}
	}
}

func TestRecurrence(t *testing.T) {
	var fx struct {
		Cases []struct {
			Name  string `json:"name"`
			Input struct {
				Rrule                 string  `json:"rrule"`
				StartDate             string  `json:"startDate"`
				EndDate               *string `json:"endDate"`
				OccurrenceCount       *int    `json:"occurrenceCount"`
				BusinessDayAdjustment string  `json:"businessDayAdjustment"`
				From                  string  `json:"from"`
				To                    string  `json:"to"`
			} `json:"input"`
			Expected []struct{ Date, DueDate string } `json:"expected"`
			Error    *string                          `json:"error"`
		} `json:"cases"`
	}
	load(t, "recurrence", &fx)
	for _, c := range fx.Cases {
		spec := recurrence.Spec{RRule: c.Input.Rrule, Start: day(t, c.Input.StartDate), Count: c.Input.OccurrenceCount, Adjustment: c.Input.BusinessDayAdjustment}
		if c.Input.EndDate != nil {
			e := day(t, *c.Input.EndDate)
			spec.End = &e
		}
		occ, err := recurrence.Expand(spec, day(t, c.Input.From), day(t, c.Input.To), 0)
		if c.Error != nil {
			if err == nil {
				t.Errorf("%s: expected error (%s)", c.Name, *c.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		var got []struct{ Date, DueDate string }
		for _, o := range occ {
			got = append(got, struct{ Date, DueDate string }{o.Date.Format("2006-01-02"), o.Due.Format("2006-01-02")})
		}
		if len(got) != len(c.Expected) {
			t.Errorf("%s: got %v want %v", c.Name, got, c.Expected)
			continue
		}
		for i := range got {
			if got[i] != c.Expected[i] {
				t.Errorf("%s[%d]: got %v want %v", c.Name, i, got[i], c.Expected[i])
			}
		}
	}
}

func TestSubscriptions(t *testing.T) {
	var cases []struct {
		Rrule   string   `json:"rrule"`
		Amount  wire     `json:"amount"`
		PerYear [2]int64 `json:"perYear"`
		Annual  string   `json:"annual"`
		Monthly string   `json:"monthly"`
	}
	load(t, "subscriptions", &cases)
	for _, c := range cases {
		r, err := recurrence.Parse(c.Rrule)
		if err != nil {
			t.Errorf("%s: %v", c.Rrule, err)
			continue
		}
		num, den := recurrence.PerYear(r)
		if [2]int64{num, den} != c.PerYear {
			t.Errorf("%s: perYear %d/%d want %v", c.Rrule, num, den, c.PerYear)
		}
		m := c.Amount.money(t)
		if got := fin.MulRat(m, num, den).Amount(); got != c.Annual {
			t.Errorf("%s: annual %s want %s", c.Rrule, got, c.Annual)
		}
		if got := fin.MulRat(m, num, den*12).Amount(); got != c.Monthly {
			t.Errorf("%s: monthly %s want %s", c.Rrule, got, c.Monthly)
		}
	}
}

type fxFixture struct {
	Rates []struct {
		BaseCurrency  string `json:"baseCurrency"`
		QuoteCurrency string `json:"quoteCurrency"`
		Rate          string `json:"rate"`
		RateDate      string `json:"rateDate"`
		Source        string `json:"source"`
	} `json:"rates"`
	Cases []struct {
		Name     string `json:"name"`
		From     string `json:"from"`
		To       string `json:"to"`
		Date     string `json:"date"`
		Amount   wire   `json:"amount"`
		Expected *struct {
			Amount   wire   `json:"amount"`
			Rate     string `json:"rate"`
			RateDate string `json:"rateDate"`
			Source   string `json:"source"`
			Inverse  bool   `json:"inverse"`
		} `json:"expected"`
	} `json:"cases"`
}

// Cases where analytics/fin.Converter is known to disagree with the fixture (and with
// exchangerates.Lookup). Remove an entry once fin is fixed; the case must then pass.
var finConverterDivergence = map[string]string{}

// TestFXLookup loads the fixture rates into a throwaway database (manual rates belong to the test
// profile) and checks both Go valuation paths: exchangerates.Lookup (converter API) and
// fin.Converter (analytics). The seeded fixed EUR/BAM row comes from the core migration.
func TestFXLookup(t *testing.T) {
	var fx fxFixture
	load(t, "fx_lookup", &fx)
	pool := testdb.New(t)
	_, profileID := testdb.SeedUserProfile(t, pool)
	ctx := context.Background()
	for _, r := range fx.Rates {
		var pid any
		if r.Source == "manual" {
			pid = profileID
		}
		if _, err := pool.Exec(ctx, `INSERT INTO exchange_rates (profile_id, base_currency, quote_currency, rate, rate_date, source)
			VALUES ($1, $2, $3, $4::numeric, $5::date, $6)`, pid, r.BaseCurrency, r.QuoteCurrency, r.Rate, r.RateDate, r.Source); err != nil {
			t.Fatalf("insert rate: %v", err)
		}
	}
	for _, c := range fx.Cases {
		m := c.Amount.money(t)
		t.Run("exchangerates.Lookup/"+c.Name, func(t *testing.T) {
			r, err := exchangerates.Lookup(ctx, pool, profileID, c.From, c.To, c.Date)
			if c.Expected == nil {
				if err == nil {
					t.Errorf("expected no rate, got %+v", r)
				}
				return
			}
			if err != nil {
				t.Fatalf("lookup: %v", err)
			}
			got, err := r.Convert(m, money.HalfUp)
			if err != nil {
				t.Fatalf("convert: %v", err)
			}
			if got.Amount() != c.Expected.Amount.Amount || r.RateDate != c.Expected.RateDate || r.Source != c.Expected.Source {
				t.Errorf("got %s rateDate=%s source=%s; want %s %s %s", got.Amount(), r.RateDate, r.Source,
					c.Expected.Amount.Amount, c.Expected.RateDate, c.Expected.Source)
			}
		})
		t.Run("fin.Converter/"+c.Name, func(t *testing.T) {
			if reason, ok := finConverterDivergence[c.Name]; ok {
				t.Skipf("KNOWN DIVERGENCE (docs/known-issues.md): %s", reason)
			}
			conv := fin.NewConverter(pool, profileID)
			got, ok, err := conv.Convert(ctx, m, c.To, day(t, c.Date))
			if err != nil {
				t.Fatalf("convert: %v", err)
			}
			if c.Expected == nil {
				if ok {
					t.Errorf("expected no rate, got %s", got.Amount())
				}
				return
			}
			if !ok || got.Amount() != c.Expected.Amount.Amount {
				t.Errorf("got %s ok=%v want %s", got.Amount(), ok, c.Expected.Amount.Amount)
			}
			rate, _, _ := conv.Rate(ctx, c.From, c.To, day(t, c.Date))
			want, _ := new(big.Rat).SetString(c.Expected.Rate)
			// expected rate is rounded to 18 places; compare at that precision
			if rate != nil && rate.FloatString(18) != want.FloatString(18) {
				t.Errorf("rate %s want %s", rate.FloatString(18), c.Expected.Rate)
			}
		})
	}
}

// budgets.json "periods" cases against budgets.PeriodFor (the REST/MCP period logic): walk the
// periods from the start until the one containing `until`.
func TestBudgetPeriods(t *testing.T) {
	var f struct {
		Cases []struct {
			Name   string `json:"name"`
			Op     string `json:"op"`
			Budget struct {
				PeriodType      string  `json:"periodType"`
				PeriodAnchorDay int     `json:"periodAnchorDay"`
				StartDate       string  `json:"startDate"`
				EndDate         *string `json:"endDate"`
			} `json:"budget"`
			Until    string          `json:"until"`
			Expected json.RawMessage `json:"expected"` // status cases have another shape
		} `json:"cases"`
	}
	load(t, "budgets", &f)
	n := 0
	for _, c := range f.Cases {
		if c.Op != "periods" {
			continue
		}
		n++
		b := budgets.Budget{PeriodType: c.Budget.PeriodType, PeriodAnchorDay: c.Budget.PeriodAnchorDay, StartDate: c.Budget.StartDate, EndDate: c.Budget.EndDate}
		t.Run(c.Name, func(t *testing.T) {
			var got []string
			until := day(t, c.Until)
			for d := day(t, b.StartDate); !d.After(until); {
				ps, pe, ok := budgets.PeriodFor(b, d)
				if !ok {
					break // past the end date
				}
				if pe.Before(d) || len(got) > 100 {
					got = append(got, "invalid period for "+fin.Fmt(d)+": "+fin.Fmt(ps)+".."+fin.Fmt(pe))
					break
				}
				got = append(got, fin.Fmt(ps)+".."+fin.Fmt(pe))
				d = pe.AddDate(0, 0, 1)
			}
			var exp []struct{ Start, End string }
			if err := json.Unmarshal(c.Expected, &exp); err != nil {
				t.Fatal(err)
			}
			var want []string
			for _, p := range exp {
				want = append(want, p.Start+".."+p.End)
			}
			if strings.Join(got, " ") != strings.Join(want, " ") {
				t.Errorf("got %v want %v", got, want)
			}
		})
	}
	if n == 0 {
		t.Fatal("no periods cases")
	}
}

// Families (or ops) whose Go side has no pure function over in-memory data yet: the Go code is
// DB-bound (analytics, budget status) or its forecast semantics differ (see docs/known-issues.md).
// The fixtures are the contract; these are listed, not hidden.
func TestPendingFamilies(t *testing.T) {
	for name, waitsFor := range map[string]string{
		"aggregation": "an exported pure aggregation over in-memory transactions (analytics: byCategory/byMerchant/cashflow/netWorth/savingsRate)",
		"budgets":     "status cases: budgets.ComputeStatus over in-memory transactions (periods cases run in TestBudgetPeriods)",
		"forecast":    "forecasting.Project with the TS account semantics (credit limits, native-currency account shortfalls, safe accounts) and EventsFromPlans",
	} {
		t.Run(name, func(t *testing.T) {
			var v any
			load(t, name, &v)
			t.Skipf("Go runner pending: needs %s", waitsFor)
		})
	}
}
