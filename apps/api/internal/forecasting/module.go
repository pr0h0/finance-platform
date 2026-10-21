// Package forecasting: Cash-flow forecasts, safe-to-spend, what-if scenarios.
//
// Owned routes under /api/v1: /forecasts
// See docs/api/openapi.yaml for the contract. Projection rules: engine.go and
// docs/architecture/planning-analytics.md. Nothing in this package writes to the database.
package forecasting

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// Adjustment is a what-if change (OpenAPI Scenario.adjustments): a signed amount (negative =
// outflow) on a date, optionally repeating (rrule), or the removal of a plan's future events.
type Adjustment struct {
	Description                string       `json:"description"`
	Amount                     *money.Money `json:"amount"`
	Date                       string       `json:"date"`
	RRule                      string       `json:"rrule"`
	AccountID                  *uuid.UUID   `json:"accountId"`
	RemovePlannedTransactionID *uuid.UUID   `json:"removePlannedTransactionId"`
}

// Options selects what to project.
type Options struct {
	Days        int
	Currency    string
	AccountIDs  []uuid.UUID
	Reserve     *money.Money
	Adjustments []Adjustment
	MonthsOnly  bool // long-term: list month-end days only
}

// overdueLookback: pending occurrences this many days past due are assumed to still happen today.
const overdueLookback = 60

// Build loads balances, future ledger postings and planned occurrences and projects them daily.
// Matched/skipped/paid occurrences are resolved and never counted (financial invariant 19).
func Build(ctx context.Context, db fin.DB, p fin.Profile, o Options) (Forecast, error) {
	today := p.Today
	to := today.AddDate(0, 0, o.Days)
	cur := o.Currency
	conv := fin.NewConverter(db, p.ID)
	var warnings []string
	assumptions := []string{
		"Balances start from all transactions booked up to today (" + fin.Fmt(today) + ").",
		"Foreign-currency balances and future amounts are valued at today's exchange rate; rates are assumed constant.",
		"Expected: income certain/expected, expenses certain/expected/possible. Conservative: only certain income (at its minimum), every expense (at its maximum). Optimistic: income up to possible (at its maximum), expenses certain/expected (at their minimum).",
		"Planned occurrences already matched to a transaction, paid manually or skipped are not counted again.",
		fmt.Sprintf("Pending occurrences up to %d days overdue are assumed to happen today.", overdueLookback),
		"Uncertain forecasts are estimates, not guaranteed outcomes.",
	}

	accounts, err := fin.Accounts(ctx, db, p.ID)
	if err != nil {
		return Forecast{}, err
	}
	included := map[uuid.UUID]fin.Account{}
	if o.AccountIDs != nil {
		byID := map[uuid.UUID]fin.Account{}
		for _, a := range accounts {
			byID[a.ID] = a
		}
		for _, id := range o.AccountIDs {
			a, ok := byID[id]
			if !ok {
				return Forecast{}, httpx.Validation(map[string]string{"accountId": "account not found in this profile"})
			}
			included[id] = a
		}
	} else {
		for _, a := range accounts {
			if !a.Archived && a.IncludeSafe && a.Classification == "asset" {
				included[a.ID] = a
			}
		}
		assumptions = append(assumptions, "Accounts: non-archived asset accounts marked for safe-to-spend.")
	}
	start := map[uuid.UUID]money.Money{}
	for id := range included {
		start[id] = fin.Zero(cur)
	}
	bals, err := fin.Balances(ctx, db, p.ID, today)
	if err != nil {
		return Forecast{}, err
	}
	for _, b := range bals {
		if _, ok := included[b.AccountID]; !ok {
			continue
		}
		v, _, err := conv.Convert(ctx, b.Amount, cur, today)
		if err != nil {
			return Forecast{}, err
		}
		s, _ := start[b.AccountID].Add(v)
		start[b.AccountID] = s
	}

	var events []Event
	conv1 := func(m money.Money) (money.Money, error) {
		v, _, err := conv.Convert(ctx, m, cur, today)
		return v, err
	}
	future, err := fin.FuturePostings(ctx, db, p.ID, today, to)
	if err != nil {
		return Forecast{}, err
	}
	for _, fp := range future {
		if _, ok := included[fp.AccountID]; !ok {
			continue
		}
		v, err := conv1(fp.Amount)
		if err != nil {
			return Forecast{}, err
		}
		acc := fp.AccountID
		e, c, op := Certain(v)
		events = append(events, Event{Date: fp.Date, AccountID: &acc, Expected: e, Conservative: c, Optimistic: op, Description: fp.Description,
			Confidence: "certain", SourceID: fp.TransactionID, Kind: "posted"})
	}

	occ, err := planning.Expand(ctx, db, p.ID, today.AddDate(0, 0, -overdueLookback), to, today, nil)
	if err != nil {
		return Forecast{}, err
	}
	overdue, unassigned := 0, 0
	removed := map[uuid.UUID]bool{}
	for _, a := range o.Adjustments {
		if a.RemovePlannedTransactionID != nil {
			removed[*a.RemovePlannedTransactionID] = true
		}
	}
	for _, oc := range occ {
		if oc.Resolved() || removed[oc.PlannedTransactionID] {
			continue
		}
		day := oc.Day
		if day.Before(today) {
			day = today
			overdue++
		}
		amt, err := conv1(oc.Amount)
		if err != nil {
			return Forecast{}, err
		}
		var amin, amax *money.Money
		if oc.AmountMin != nil {
			v, err := conv1(*oc.AmountMin)
			if err != nil {
				return Forecast{}, err
			}
			amin = &v
		}
		if oc.AmountMax != nil {
			v, err := conv1(*oc.AmountMax)
			if err != nil {
				return Forecast{}, err
			}
			amax = &v
		}
		add := func(acc *uuid.UUID, sign int, kind string) {
			e, c, op := Scenarios(sign, kind, oc.Confidence, amt, amin, amax)
			events = append(events, Event{Date: day, AccountID: acc, Expected: e, Conservative: c, Optimistic: op, Description: oc.Description,
				Confidence: oc.Confidence, SourceID: oc.PlannedTransactionID, Kind: oc.Kind})
		}
		inc := func(id *uuid.UUID) bool {
			if id == nil {
				return false
			}
			_, ok := included[*id]
			return ok
		}
		switch oc.Kind {
		case "income", "expense":
			sign := -1
			if oc.Kind == "income" {
				sign = 1
			}
			switch {
			case oc.AccountID == nil:
				unassigned++
				add(nil, sign, oc.Kind)
			case inc(oc.AccountID):
				add(oc.AccountID, sign, oc.Kind)
			}
		case "transfer":
			if inc(oc.AccountID) {
				add(oc.AccountID, -1, "expense")
			}
			if inc(oc.ToAccountID) {
				add(oc.ToAccountID, 1, "expense") // same inclusion rule as the outgoing leg
			}
		}
	}
	if overdue > 0 {
		warnings = append(warnings, fmt.Sprintf("%d overdue planned item(s) are assumed to happen today; match or skip them to refine the forecast.", overdue))
	}
	if unassigned > 0 {
		warnings = append(warnings, fmt.Sprintf("%d planned item(s) have no account; they change the total only.", unassigned))
	}

	for i, a := range o.Adjustments {
		if a.RemovePlannedTransactionID != nil && a.Amount == nil {
			continue
		}
		if a.Amount == nil {
			return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].amount", i): "required"})
		}
		if a.AccountID != nil {
			if _, ok := included[*a.AccountID]; !ok {
				return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].accountId", i): "account is not part of this forecast"})
			}
		}
		d := today
		if a.Date != "" {
			if d, err = fin.ParseDate(a.Date); err != nil {
				return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].date", i): err.Error()})
			}
		}
		v, err := conv1(*a.Amount)
		if err != nil {
			return Forecast{}, err
		}
		dates := []time.Time{d}
		if a.RRule != "" {
			occ, err := recurrence.Expand(recurrence.Spec{RRule: a.RRule, Start: d}, today, to, 0)
			if err != nil {
				return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].rrule", i): err.Error()})
			}
			dates = dates[:0]
			for _, x := range occ {
				dates = append(dates, x.Due)
			}
		}
		desc := a.Description
		if desc == "" {
			desc = "What-if adjustment"
		}
		for _, x := range dates {
			if x.Before(today) || x.After(to) {
				continue
			}
			e, c, op := Certain(v)
			events = append(events, Event{Date: x, AccountID: a.AccountID, Expected: e, Conservative: c, Optimistic: op, Description: desc,
				Confidence: "certain", Kind: "adjustment"})
		}
	}
	if len(o.Adjustments) > 0 {
		assumptions = append(assumptions, "Simulation: what-if adjustments are applied as certain; no records were changed.")
	}

	reserve := fin.Zero(cur)
	if o.Reserve != nil {
		if reserve, err = conv1(*o.Reserve); err != nil {
			return Forecast{}, err
		}
	} else {
		var setting money.Money
		if ok, err := fin.Setting(ctx, db, p.ID, "forecast.minimumReserve", &setting); err == nil && ok {
			if reserve, err = conv1(setting); err != nil {
				return Forecast{}, err
			}
		}
	}
	assumptions = append(assumptions, "Safe-to-spend keeps a minimum reserve of "+reserve.String()+" (profile setting forecast.minimumReserve or ?reserve=).")

	in := Input{From: today, To: to, Currency: cur, Start: start, Events: events, Reserve: reserve, MonthEnd: fin.MonthEnd(today)}
	if o.MonthsOnly {
		in.DailyOnly = func(d time.Time) bool { return d.Equal(fin.MonthEnd(d)) || d.Equal(to) }
	}
	f := Project(in)
	until := to
	if lim := today.AddDate(0, 0, 31); lim.Before(until) {
		until = lim
	}
	for _, e := range events {
		if e.Kind == "income" && e.Expected != nil && e.Expected.Sign() > 0 && e.Date.After(today) {
			if d := e.Date.AddDate(0, 0, -1); d.Before(until) {
				until = d
			}
		}
	}
	if !o.MonthsOnly {
		f.SafeToSpend = SafeToSpend(f, until)
	} else {
		f.SafeToSpend = fin.Zero(cur)
	}
	f.SafeToSpendUntil = fin.Fmt(until)
	f.Assumptions = assumptions
	f.Warnings = append(warnings, missingWarning(conv)...)
	f.MissingRates = conv.Missing()
	f.Complete = conv.Complete()
	if len(included) == 0 {
		f.Warnings = append(f.Warnings, "no accounts are included in this forecast")
	}
	return f, nil
}

func missingWarning(c *fin.Converter) []string {
	if c.Complete() {
		return nil
	}
	return []string{"some amounts have no exchange rate and are excluded; add rates to complete the forecast"}
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB
	setup := func(r *http.Request) (fin.Profile, Options, error) {
		pid, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return fin.Profile{}, Options{}, err
		}
		p, err := fin.LoadProfile(r.Context(), db, pid)
		if err != nil {
			return p, Options{}, err
		}
		o := Options{Days: 30}
		if o.Currency, err = fin.Currency(r, p); err != nil {
			return p, o, err
		}
		if o.AccountIDs, err = fin.AccountIDs(r); err != nil {
			return p, o, err
		}
		if s := r.URL.Query().Get("reserve"); s != "" {
			m, err := money.Parse(s, o.Currency)
			if err != nil || m.Sign() < 0 {
				return p, o, httpx.Validation(map[string]string{"reserve": "a non-negative decimal in the forecast currency"})
			}
			o.Reserve = &m
		}
		return p, o, nil
	}
	intParam := func(r *http.Request, name string, def, lo, hi int) (int, error) {
		s := r.URL.Query().Get(name)
		if s == "" {
			return def, nil
		}
		n, err := strconv.Atoi(s)
		if err != nil || n < lo || n > hi {
			return 0, httpx.Validation(map[string]string{name: fmt.Sprintf("must be an integer %d..%d", lo, hi)})
		}
		return n, nil
	}
	r.Get("/forecasts/cash-flow", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, o, err := setup(r)
		if err != nil {
			return err
		}
		if o.Days, err = intParam(r, "days", 30, 1, 3660); err != nil {
			return err
		}
		f, err := Build(r.Context(), db, p, o)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, f)
		return nil
	}))
	r.Get("/forecasts/safe-to-spend", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, o, err := setup(r)
		if err != nil {
			return err
		}
		o.Days = 62
		f, err := Build(r.Context(), db, p, o)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"amount": f.SafeToSpend, "until": f.SafeToSpendUntil, "reserve": f.Reserve,
			"lowest": f.LowestConservative, "assumptions": f.Assumptions, "warnings": f.Warnings, "complete": f.Complete})
		return nil
	}))
	r.Get("/forecasts/long-term", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, o, err := setup(r)
		if err != nil {
			return err
		}
		months, err := intParam(r, "months", 12, 1, 360)
		if err != nil {
			return err
		}
		o.Days = fin.DaysBetween(p.Today, p.Today.AddDate(0, months, 0))
		o.MonthsOnly = true
		f, err := Build(r.Context(), db, p, o)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, f)
		return nil
	}))
	r.Post("/forecasts/scenarios", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, o, err := setup(r)
		if err != nil {
			return err
		}
		var in struct {
			Days        *int         `json:"days"`
			AccountIDs  []uuid.UUID  `json:"accountIds"`
			Currency    string       `json:"currency"`
			Reserve     *money.Money `json:"reserve"`
			Adjustments []Adjustment `json:"adjustments"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.Days != nil {
			if *in.Days < 1 || *in.Days > 3660 {
				return httpx.Validation(map[string]string{"days": "must be 1..3660"})
			}
			o.Days = *in.Days
		}
		if in.AccountIDs != nil {
			o.AccountIDs = in.AccountIDs
		}
		if in.Currency != "" {
			if _, ok := money.Scale(in.Currency); !ok {
				return httpx.Validation(map[string]string{"currency": "unknown currency"})
			}
			o.Currency = in.Currency
		}
		if in.Reserve != nil {
			o.Reserve = in.Reserve
		}
		if len(in.Adjustments) > 200 {
			return httpx.Validation(map[string]string{"adjustments": "at most 200"})
		}
		o.Adjustments = in.Adjustments
		f, err := Build(r.Context(), db, p, o)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, f)
		return nil
	}))
}
