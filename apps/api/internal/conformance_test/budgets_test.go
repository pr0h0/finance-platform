package conformance_test

import (
	"context"
	"encoding/json"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

func insertRates(t *testing.T, pool *pgxpool.Pool, profileID uuid.UUID, rates []fxRate) {
	t.Helper()
	for _, r := range rates {
		var pid any
		if r.Source == "manual" {
			pid = profileID
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO exchange_rates (profile_id, base_currency, quote_currency, rate, rate_date, source)
			VALUES ($1, $2, $3, $4::numeric, $5::date, $6) ON CONFLICT DO NOTHING`, pid, r.BaseCurrency, r.QuoteCurrency, r.Rate, r.RateDate, r.Source); err != nil {
			t.Fatalf("insert rate: %v", err)
		}
	}
}

// budgets.json "status" cases against budgets.Compute fed by budgets.LoadSpent (the REST/MCP loader):
// the fixture ledger is seeded into a fresh profile, planned spending comes from the fixture.
func TestBudgetStatus(t *testing.T) {
	var f struct {
		Categories []struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parentId"`
			Name     string  `json:"name"`
		} `json:"categories"`
		Transactions []aggTxn `json:"transactions"`
		Planned      []struct {
			Date       string  `json:"date"`
			CategoryID *string `json:"categoryId"`
			Amount     wire    `json:"amount"`
		} `json:"planned"`
		Rates []fxRate `json:"rates"`
		Cases []struct {
			Name   string `json:"name"`
			Op     string `json:"op"`
			Budget struct {
				ID              string   `json:"id"`
				PeriodType      string   `json:"periodType"`
				PeriodAnchorDay int      `json:"periodAnchorDay"`
				StartDate       string   `json:"startDate"`
				EndDate         *string  `json:"endDate"`
				Currency        string   `json:"currency"`
				RolloverPolicy  string   `json:"rolloverPolicy"`
				IncludePlanned  bool     `json:"includePlanned"`
				AlertThresholds []string `json:"alertThresholds"`
			} `json:"budget"`
			Allocations []struct {
				BudgetPeriodID *string `json:"budgetPeriodId"`
				PeriodStart    *string `json:"periodStart"`
				CategoryID     *string `json:"categoryId"`
				Amount         wire    `json:"amount"`
				RolloverAmount *wire   `json:"rolloverAmount"`
				RolloverPolicy *string `json:"rolloverPolicy"`
			} `json:"allocations"`
			Date     string          `json:"date"`
			Expected json.RawMessage `json:"expected"`
		} `json:"cases"`
	}
	load(t, "budgets", &f)
	pool := testdb.New(t)
	ctx := context.Background()
	var af aggFixture
	for _, c := range f.Categories {
		af.Categories = append(af.Categories, struct {
			ID       string  `json:"id"`
			ParentID *string `json:"parentId"`
			Name     string  `json:"name"`
		}{c.ID, c.ParentID, c.Name})
	}
	n := 0
	for _, c := range f.Cases {
		if c.Op != "status" {
			continue
		}
		n++
		t.Run(c.Name, func(t *testing.T) {
			profile, keyOf, id := seedAggregation(t, pool, af, f.Transactions)
			insertRates(t, pool, profile, f.Rates)
			ptr := func(s *string) *uuid.UUID {
				if s == nil {
					return nil
				}
				u := id(*s)
				return &u
			}
			bb := c.Budget
			b := budgets.Budget{ID: id(bb.ID), ProfileID: profile, PeriodType: bb.PeriodType, PeriodAnchorDay: bb.PeriodAnchorDay, StartDate: bb.StartDate,
				EndDate: bb.EndDate, Currency: bb.Currency, RolloverPolicy: bb.RolloverPolicy, IncludePlanned: bb.IncludePlanned, AlertThresholds: bb.AlertThresholds}
			in := budgets.StatusInput{PeriodAllocations: map[string][]budgets.Allocation{}, Date: day(t, c.Date)}
			for _, a := range c.Allocations {
				al := budgets.Allocation{CategoryID: ptr(a.CategoryID), Amount: a.Amount.money(t), RolloverAmount: fin.Zero(bb.Currency), RolloverPolicy: a.RolloverPolicy}
				if a.RolloverAmount != nil {
					al.RolloverAmount = a.RolloverAmount.money(t)
				}
				if a.BudgetPeriodID == nil {
					b.Allocations = append(b.Allocations, al)
				} else if a.PeriodStart != nil {
					in.PeriodAllocations[*a.PeriodStart] = append(in.PeriodAllocations[*a.PeriodStart], al)
				}
			}
			in.Budget = b
			_, pe, ok := budgets.PeriodFor(b, in.Date)
			if !ok {
				t.Fatal("date outside budget")
			}
			var err error
			if in.Categories, err = fin.Categories(ctx, pool, profile); err != nil {
				t.Fatal(err)
			}
			conv := fin.NewConverter(pool, profile)
			if in.Spent, err = budgets.LoadSpent(ctx, pool, profile, day(t, bb.StartDate), pe, bb.Currency, conv); err != nil {
				t.Fatal(err)
			}
			for _, p := range f.Planned {
				v, ok, err := conv.Convert(ctx, p.Amount.money(t), bb.Currency, day(t, p.Date))
				if err != nil || !ok {
					t.Fatalf("planned %v: %v", p, err)
				}
				in.Planned = append(in.Planned, budgets.Spend{Date: day(t, p.Date), CategoryID: ptr(p.CategoryID), Amount: v})
			}
			st, ok := budgets.Compute(in)
			if !ok || !conv.Complete() {
				t.Fatalf("compute ok=%v complete=%v", ok, conv.Complete())
			}
			type line struct {
				CategoryID  *string `json:"categoryId"`
				Limit       wire    `json:"limit"`
				RolloverIn  wire    `json:"rolloverIn"`
				Actual      wire    `json:"actual"`
				Planned     wire    `json:"planned"`
				Remaining   wire    `json:"remaining"`
				Utilization *string `json:"utilization"`
				Alert       *string `json:"alert"`
			}
			type totals struct {
				Limit     wire `json:"limit"`
				Actual    wire `json:"actual"`
				Planned   wire `json:"planned"`
				Remaining wire `json:"remaining"`
			}
			type status struct {
				BudgetID    string `json:"budgetId"`
				PeriodStart string `json:"periodStart"`
				PeriodEnd   string `json:"periodEnd"`
				Lines       []line `json:"lines"`
				Totals      totals `json:"totals"`
			}
			w := func(m money.Money) wire { return wire{m.Amount(), m.Currency()} }
			got := status{BudgetID: keyOf(st.BudgetID.String()), PeriodStart: st.PeriodStart, PeriodEnd: st.PeriodEnd,
				Totals: totals{w(st.Totals.Limit), w(st.Totals.Actual), w(st.Totals.Planned), w(st.Totals.Remaining)}}
			for _, l := range st.Lines {
				var cat *string
				if l.CategoryID != nil {
					k := keyOf(l.CategoryID.String())
					cat = &k
				}
				got.Lines = append(got.Lines, line{cat, w(l.Limit), w(l.RolloverIn), w(l.Actual), w(l.Planned), w(l.Remaining), l.Utilization, l.Alert})
			}
			var want status
			if err := json.Unmarshal(c.Expected, &want); err != nil {
				t.Fatal(err)
			}
			byCat := func(ls []line) {
				sort.SliceStable(ls, func(i, j int) bool { return deref(ls[i].CategoryID) < deref(ls[j].CategoryID) })
			}
			byCat(got.Lines)
			byCat(want.Lines)
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(want)
			if string(gj) != string(wj) {
				t.Errorf("got  %s\nwant %s", gj, wj)
			}
		})
	}
	if n == 0 {
		t.Fatal("no status cases")
	}
}
