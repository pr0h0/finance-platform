package conformance_test

import (
	"context"
	"encoding/json"
	"sort"
	"testing"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/forecasting"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// forecast.json against forecasting.Project / planning.Pending + forecasting.EventsFromPlans (the
// code behind REST /forecasts and MCP). Fixture ids are mapped to uuids and back; conversions use
// fin.Converter on a throwaway database holding the fixture rates (EUR/BAM fixed parity comes from
// the core migration).

type ids struct{ back map[string]string }

func (m *ids) id(s string) uuid.UUID {
	u := uuid.NewSHA1(uuid.NameSpaceOID, []byte(s))
	m.back[u.String()] = s
	return u
}

func (m *ids) ptr(s *string) *uuid.UUID {
	if s == nil {
		return nil
	}
	u := m.id(*s)
	return &u
}

func (m *ids) key(u uuid.UUID) string {
	if k, ok := m.back[u.String()]; ok {
		return k
	}
	return u.String()
}

type fxEvent struct {
	Date        string `json:"date"`
	AccountID   string `json:"accountId"`
	Amount      wire   `json:"amount"`
	AmountMin   *wire  `json:"amountMin"`
	AmountMax   *wire  `json:"amountMax"`
	Confidence  string `json:"confidence"`
	Source      string `json:"source"`
	SourceID    string `json:"sourceId"`
	Description string `json:"description"`
}

type fxRate struct {
	BaseCurrency  string `json:"baseCurrency"`
	QuoteCurrency string `json:"quoteCurrency"`
	Rate          string `json:"rate"`
	RateDate      string `json:"rateDate"`
	Source        string `json:"source"`
}

func seedRates(t *testing.T, rates []fxRate) (*fin.Converter, uuid.UUID) {
	t.Helper()
	pool := testdb.New(t)
	_, profileID := testdb.SeedUserProfile(t, pool)
	for _, r := range rates {
		var pid any
		if r.Source == "manual" {
			pid = profileID
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO exchange_rates (profile_id, base_currency, quote_currency, rate, rate_date, source)
			VALUES ($1, $2, $3, $4::numeric, $5::date, $6)`, pid, r.BaseCurrency, r.QuoteCurrency, r.Rate, r.RateDate, r.Source); err != nil {
			t.Fatalf("insert rate: %v", err)
		}
	}
	return fin.NewConverter(pool, profileID), profileID
}

func optMoney(t *testing.T, w *wire) *money.Money {
	if w == nil {
		return nil
	}
	m := w.money(t)
	return &m
}

func wireOf(m *money.Money) *wire {
	if m == nil {
		return nil
	}
	return &wire{m.Amount(), m.Currency()}
}

func TestForecast(t *testing.T) {
	var f struct {
		Rates []fxRate `json:"rates"`
		Cases []struct {
			Name     string          `json:"name"`
			Op       string          `json:"op"`
			Input    json.RawMessage `json:"input"`
			Expected json.RawMessage `json:"expected"`
		} `json:"cases"`
	}
	load(t, "forecast", &f)
	conv, _ := seedRates(t, f.Rates)
	ctx := context.Background()
	for _, c := range f.Cases {
		t.Run(c.Op+"/"+c.Name, func(t *testing.T) {
			m := &ids{back: map[string]string{}}
			switch c.Op {
			case "forecast":
				runForecast(t, ctx, conv, m, c.Input, c.Expected)
			case "planEvents":
				runPlanEvents(t, m, c.Input, c.Expected)
			default:
				t.Fatalf("unknown op %s", c.Op)
			}
		})
	}
}

func runForecast(t *testing.T, ctx context.Context, conv *fin.Converter, m *ids, raw, rawExp json.RawMessage) {
	var in struct {
		From     string `json:"from"`
		To       string `json:"to"`
		Currency string `json:"currency"`
		Reserve  *wire  `json:"reserve"`
		Accounts []struct {
			ID                   string `json:"id"`
			Currency             string `json:"currency"`
			Balance              wire   `json:"balance"`
			AccountType          string `json:"accountType"`
			CreditLimit          *wire  `json:"creditLimit"`
			IncludeInSafeToSpend *bool  `json:"includeInSafeToSpend"`
		} `json:"accounts"`
		Events []fxEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	from := day(t, in.From)
	fi := forecasting.Input{From: from, To: day(t, in.To), Currency: in.Currency, Reserve: optMoney(t, in.Reserve),
		Convert: func(x money.Money) (money.Money, bool) {
			v, ok, err := conv.Convert(ctx, x, in.Currency, from)
			if err != nil {
				t.Fatal(err)
			}
			return v, ok
		}}
	for _, a := range in.Accounts {
		fi.Accounts = append(fi.Accounts, forecasting.Account{ID: m.id(a.ID), Currency: a.Currency, Balance: a.Balance.money(t), AccountType: a.AccountType,
			CreditLimit: optMoney(t, a.CreditLimit), IncludeInSafeToSpend: a.IncludeInSafeToSpend == nil || *a.IncludeInSafeToSpend})
	}
	for _, e := range in.Events {
		fi.Events = append(fi.Events, forecasting.Event{Date: day(t, e.Date), AccountID: m.id(e.AccountID), Amount: e.Amount.money(t),
			AmountMin: optMoney(t, e.AmountMin), AmountMax: optMoney(t, e.AmountMax), Confidence: e.Confidence, Source: e.Source,
			SourceID: m.id(e.SourceID), Description: e.Description})
	}
	got := forecasting.Project(fi)

	type point struct {
		Date   string `json:"date"`
		Amount wire   `json:"amount"`
	}
	type short struct {
		Date      string `json:"date"`
		Amount    wire   `json:"amount"`
		AccountID string `json:"accountId"`
	}
	type dayRow struct {
		Date         string `json:"date"`
		Expected     wire   `json:"expected"`
		Conservative wire   `json:"conservative"`
		Optimistic   wire   `json:"optimistic"`
	}
	type result struct {
		Lowest           point    `json:"lowest"`
		Shortfalls       []short  `json:"shortfalls"`
		MonthEnd         wire     `json:"monthEnd"`
		SafeToSpend      wire     `json:"safeToSpend"`
		SafeToSpendUntil string   `json:"safeToSpendUntil,omitempty"`
		Complete         bool     `json:"complete"`
		Days             []dayRow `json:"days"`
	}
	var want result
	if err := json.Unmarshal(rawExp, &want); err != nil {
		t.Fatal(err)
	}
	have := result{Lowest: point{got.Lowest.Date, wire{got.Lowest.Amount.Amount(), got.Lowest.Amount.Currency()}}, Shortfalls: []short{},
		MonthEnd: wire{got.MonthEnd.Amount(), got.MonthEnd.Currency()}, SafeToSpend: wire{got.SafeToSpend.Amount(), got.SafeToSpend.Currency()},
		Complete: got.Complete}
	if want.SafeToSpendUntil != "" {
		have.SafeToSpendUntil = got.SafeToSpendUntil
	}
	for _, s := range got.Shortfalls {
		have.Shortfalls = append(have.Shortfalls, short{s.Date, wire{s.Amount.Amount(), s.Amount.Currency()}, m.key(*s.AccountID)})
	}
	// same-date shortfalls: TS orders by fixture id, Go by uuid
	sort.SliceStable(have.Shortfalls, func(i, j int) bool {
		a, b := have.Shortfalls[i], have.Shortfalls[j]
		return a.Date < b.Date || (a.Date == b.Date && a.AccountID < b.AccountID)
	})
	byDate := map[string]forecasting.Day{}
	for _, d := range got.Days {
		byDate[d.Date] = d
	}
	for _, w := range want.Days {
		d, ok := byDate[w.Date]
		if !ok {
			t.Errorf("day %s missing", w.Date)
			continue
		}
		have.Days = append(have.Days, dayRow{d.Date, wire{d.Expected.Amount(), d.Expected.Currency()},
			wire{d.Conservative.Amount(), d.Conservative.Currency()}, wire{d.Optimistic.Amount(), d.Optimistic.Currency()}})
	}
	if want.Shortfalls == nil {
		want.Shortfalls = []short{}
	}
	gj, _ := json.Marshal(have)
	wj, _ := json.Marshal(want)
	if string(gj) != string(wj) {
		t.Errorf("got  %s\nwant %s\nwarnings %v", gj, wj, got.Warnings)
	}
}

func runPlanEvents(t *testing.T, m *ids, raw, rawExp json.RawMessage) {
	var in struct {
		Plans []struct {
			ID               string  `json:"id"`
			Kind             string  `json:"kind"`
			AccountID        *string `json:"accountId"`
			ToAccountID      *string `json:"toAccountId"`
			CategoryID       *string `json:"categoryId"`
			Description      string  `json:"description"`
			Amount           wire    `json:"amount"`
			AmountMin        *wire   `json:"amountMin"`
			AmountMax        *wire   `json:"amountMax"`
			DueDate          string  `json:"dueDate"`
			RecurrenceID     *string `json:"recurrenceId"`
			Priority         string  `json:"priority"`
			Confidence       string  `json:"confidence"`
			Status           string  `json:"status"`
			InstallmentTotal *int    `json:"installmentTotal"`
			InstallmentStart *int    `json:"installmentStart"`
		} `json:"plans"`
		Schedules []struct {
			ID                    string  `json:"id"`
			RRule                 string  `json:"rrule"`
			StartDate             string  `json:"startDate"`
			EndDate               *string `json:"endDate"`
			OccurrenceCount       *int    `json:"occurrenceCount"`
			BusinessDayAdjustment string  `json:"businessDayAdjustment"`
		} `json:"schedules"`
		Stored []struct {
			PlannedTransactionID string  `json:"plannedTransactionId"`
			OccurrenceDate       string  `json:"occurrenceDate"`
			Status               string  `json:"status"`
			AmountOverride       *wire   `json:"amountOverride"`
			DateOverride         *string `json:"dateOverride"`
			MatchedTransactionID *string `json:"matchedTransactionId"`
		} `json:"stored"`
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatal(err)
	}
	scheds := map[string]*recurrence.Schedule{}
	for _, s := range in.Schedules {
		adj := s.BusinessDayAdjustment
		if adj == "" {
			adj = "none"
		}
		scheds[s.ID] = &recurrence.Schedule{ID: m.id(s.ID), RRule: s.RRule, StartDate: s.StartDate, EndDate: s.EndDate, OccurrenceCount: s.OccurrenceCount,
			BusinessDayAdjustment: adj}
	}
	var plans []planning.Plan
	for _, p := range in.Plans {
		pl := planning.Plan{ID: m.id(p.ID), Kind: p.Kind, AccountID: m.ptr(p.AccountID), ToAccountID: m.ptr(p.ToAccountID), CategoryID: m.ptr(p.CategoryID),
			Description: p.Description, Amount: p.Amount.money(t), AmountMin: optMoney(t, p.AmountMin), AmountMax: optMoney(t, p.AmountMax),
			DueDate: p.DueDate, RecurrenceID: m.ptr(p.RecurrenceID), Priority: p.Priority, Confidence: p.Confidence, Status: p.Status,
			InstallmentTotal: p.InstallmentTotal, InstallmentStart: p.InstallmentStart}
		if p.InstallmentTotal != nil && p.InstallmentStart == nil {
			one := 1
			pl.InstallmentStart = &one
		}
		if p.RecurrenceID != nil {
			pl.Recurrence = scheds[*p.RecurrenceID]
		}
		plans = append(plans, pl)
	}
	var stored []planning.Stored
	for _, s := range in.Stored {
		r := planning.Stored{PlanID: m.id(s.PlannedTransactionID), Date: day(t, s.OccurrenceDate), Status: s.Status,
			Amount: optMoney(t, s.AmountOverride), Matched: m.ptr(s.MatchedTransactionID)}
		if s.DateOverride != nil {
			d := day(t, *s.DateOverride)
			r.DateOver = &d
		}
		stored = append(stored, r)
	}
	occ, err := planning.Pending(plans, stored, day(t, in.From), day(t, in.To), true)
	if err != nil {
		t.Fatal(err)
	}
	events, warnings := forecasting.EventsFromPlans(plans, occ)
	if len(warnings) > 0 {
		t.Errorf("warnings: %v", warnings)
	}
	type ev struct {
		Date        string `json:"date"`
		AccountID   string `json:"accountId"`
		Amount      wire   `json:"amount"`
		AmountMin   *wire  `json:"amountMin"`
		AmountMax   *wire  `json:"amountMax"`
		Confidence  string `json:"confidence"`
		Source      string `json:"source"`
		SourceID    string `json:"sourceId"`
		Description string `json:"description"`
	}
	var got, want []ev
	for _, e := range events {
		got = append(got, ev{fin.Fmt(e.Date), m.key(e.AccountID), wire{e.Amount.Amount(), e.Amount.Currency()}, wireOf(e.AmountMin), wireOf(e.AmountMax),
			e.Confidence, e.Source, m.key(e.SourceID), e.Description})
	}
	if err := json.Unmarshal(rawExp, &want); err != nil {
		t.Fatal(err)
	}
	// same-date events: TS orders by fixture plan id, Go by uuid
	canonEv := func(x []ev) string {
		sort.SliceStable(x, func(i, j int) bool {
			a, b := x[i], x[j]
			if a.Date != b.Date {
				return a.Date < b.Date
			}
			if a.SourceID != b.SourceID {
				return a.SourceID < b.SourceID
			}
			return a.AccountID < b.AccountID
		})
		j, _ := json.Marshal(x)
		return string(j)
	}
	if g, w := canonEv(got), canonEv(want); g != w {
		t.Errorf("got  %s\nwant %s", g, w)
	}
}
