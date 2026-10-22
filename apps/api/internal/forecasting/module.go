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

// Build loads balances, booked future postings and plan occurrences and projects them daily with
// the shared engine rules (Project). The inputs mirror the web (apps/web/src/features/planning/
// forecast.ts): every non-archived account (or the requested ones), each account's balance in its
// own currency at the end of yesterday, today's and later postings as certain events, pending plan
// occurrences (planning.Pending: matched/skipped/paid never counted, financial invariant 19; stored
// pending occurrences in the past are moved to today).
func Build(ctx context.Context, db fin.DB, p fin.Profile, o Options) (Forecast, error) {
	today := p.Today
	to := today.AddDate(0, 0, o.Days)
	cur := o.Currency
	conv := fin.NewConverter(db, p.ID)
	var warnings []string
	assumptions := []string{
		"Starting balances are ledger balances in each account's own currency before any event today (" + fin.Fmt(today) + ").",
		"Expected: certain and expected events at their planned amounts.",
		"Conservative: only certain income (at its minimum); every expense, including possible and speculative ones, at its maximum.",
		"Optimistic: all income at its maximum; only certain and expected expenses at their minimum.",
		"Foreign-currency balances are converted to " + cur + " at today's rate for the whole period; rates are assumed constant.",
		"Planned occurrences already matched to a transaction, paid manually or skipped are not counted again; stored pending occurrences in the past are assumed to happen today.",
		"Shortfalls are per account in its own currency: below zero, or below minus the credit limit for liability accounts with a limit.",
		"Uncertain forecasts are estimates, not guaranteed outcomes.",
	}

	all, err := fin.Accounts(ctx, db, p.ID)
	if err != nil {
		return Forecast{}, err
	}
	var accs []fin.Account
	if o.AccountIDs != nil {
		byID := map[uuid.UUID]fin.Account{}
		for _, a := range all {
			byID[a.ID] = a
		}
		for _, id := range o.AccountIDs {
			a, ok := byID[id]
			if !ok {
				return Forecast{}, httpx.Validation(map[string]string{"accountId": "account not found in this profile"})
			}
			if !a.Archived {
				accs = append(accs, a)
			}
		}
	} else {
		for _, a := range all {
			if !a.Archived {
				accs = append(accs, a)
			}
		}
		assumptions = append(assumptions, "Accounts: every non-archived account; safe-to-spend uses the accounts marked for it.")
	}
	included := map[uuid.UUID]bool{}
	accounts := make([]Account, 0, len(accs))
	bals, err := fin.Balances(ctx, db, p.ID, today.AddDate(0, 0, -1))
	if err != nil {
		return Forecast{}, err
	}
	for _, a := range accs {
		included[a.ID] = true
		fa := Account{ID: a.ID, Currency: a.Currency, Balance: fin.Zero(a.Currency), AccountType: a.Type, CreditLimit: a.CreditLimit, IncludeInSafeToSpend: a.IncludeSafe}
		for _, b := range bals {
			if b.AccountID == a.ID && b.Amount.Currency() == a.Currency {
				fa.Balance = b.Amount
			}
		}
		accounts = append(accounts, fa)
	}

	var events []Event
	future, err := fin.FuturePostings(ctx, db, p.ID, today.AddDate(0, 0, -1), to)
	if err != nil {
		return Forecast{}, err
	}
	for _, fp := range future {
		if !included[fp.AccountID] {
			continue
		}
		src := "posted"
		if fp.Kind == "transfer" || fp.Kind == "fx" {
			src = "transfer"
		}
		desc := fp.Description
		if desc == "" {
			desc = "Booked transaction"
		}
		events = append(events, Event{Date: fp.Date, AccountID: fp.AccountID, Amount: fp.Amount, Confidence: "certain", Source: src,
			SourceID: fp.TransactionID, Description: desc})
	}

	plans, err := planning.ListPlans(ctx, db, p.ID, uuid.Nil, 100_000, []string{"active"})
	if err != nil {
		return Forecast{}, err
	}
	removed := map[uuid.UUID]bool{}
	for _, a := range o.Adjustments {
		if a.RemovePlannedTransactionID != nil {
			removed[*a.RemovePlannedTransactionID] = true
		}
	}
	kept := plans[:0]
	for _, pl := range plans {
		if !removed[pl.ID] && (pl.AccountID == nil || included[*pl.AccountID]) {
			kept = append(kept, pl)
		}
	}
	stored, err := planning.LoadStored(ctx, db, p.ID, kept)
	if err != nil {
		return Forecast{}, err
	}
	occ, err := planning.Pending(kept, stored, today, to, true)
	if err != nil {
		return Forecast{}, err
	}
	planEvents, planWarnings := EventsFromPlans(kept, occ)
	warnings = append(warnings, planWarnings...)
	overdue := 0
	for _, oc := range occ {
		if oc.Overdue {
			overdue++
		}
	}
	for _, e := range planEvents {
		if included[e.AccountID] {
			events = append(events, e)
		}
	}
	if overdue > 0 {
		warnings = append(warnings, fmt.Sprintf("%d overdue planned item(s) are assumed to happen today; match or skip them to refine the forecast.", overdue))
	}

	// What-if additions (removals were applied above). An adjustment without an account goes to the
	// first included safe-to-spend account.
	var defaultAcc *uuid.UUID
	for _, a := range accounts {
		if a.IncludeInSafeToSpend {
			id := a.ID
			defaultAcc = &id
			break
		}
	}
	for i, a := range o.Adjustments {
		if a.RemovePlannedTransactionID != nil && a.Amount == nil {
			continue
		}
		if a.Amount == nil {
			return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].amount", i): "required"})
		}
		acc := a.AccountID
		if acc == nil {
			acc = defaultAcc
		}
		if acc == nil || !included[*acc] {
			return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].accountId", i): "account is not part of this forecast"})
		}
		d := today
		if a.Date != "" {
			if d, err = fin.ParseDate(a.Date); err != nil {
				return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].date", i): err.Error()})
			}
		}
		amt := *a.Amount
		for _, x := range accounts {
			if x.ID == *acc && x.Currency != amt.Currency() {
				v, ok, err := conv.Convert(ctx, amt, x.Currency, today)
				if err != nil {
					return Forecast{}, err
				}
				if !ok {
					return Forecast{}, httpx.Validation(map[string]string{fmt.Sprintf("adjustments[%d].amount", i): "no exchange rate to the account currency"})
				}
				amt = v
			}
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
			events = append(events, Event{Date: x, AccountID: *acc, Amount: amt, Confidence: "certain", Source: "scenario", Description: desc})
		}
	}
	if len(o.Adjustments) > 0 {
		assumptions = append(assumptions, "Simulation: what-if adjustments are applied as certain; no records were changed.")
	}

	var reserve *money.Money
	if o.Reserve != nil {
		reserve = o.Reserve
	} else {
		var setting money.Money
		if ok, err := fin.Setting(ctx, db, p.ID, "forecast.minimumReserve", &setting); err == nil && ok {
			reserve = &setting
		}
	}

	var convErr error
	in := Input{From: today, To: to, Currency: cur, Accounts: accounts, Events: events, Reserve: reserve,
		Convert: func(m money.Money) (money.Money, bool) {
			v, ok, err := conv.Convert(ctx, m, cur, today)
			if err != nil && convErr == nil {
				convErr = err
			}
			return v, ok && err == nil
		}}
	if o.MonthsOnly {
		in.DailyOnly = func(d time.Time) bool { return d.Equal(fin.MonthEnd(d)) || d.Equal(to) }
	}
	f := Project(in)
	if convErr != nil {
		return Forecast{}, convErr
	}
	f.Assumptions = append(assumptions,
		"Safe-to-spend = lowest conservative balance of the safe-to-spend accounts through "+f.SafeToSpendUntil+
			" (the day before the next expected income, at most 31 days) minus the reserve of "+f.Reserve.String()+
			" (profile setting forecast.minimumReserve or ?reserve=).")
	f.Warnings = append(f.Warnings, warnings...)
	f.MissingRates = conv.Missing()
	f.Complete = f.Complete && conv.Complete()
	if len(accounts) == 0 {
		f.Warnings = append(f.Warnings, "no accounts are included in this forecast")
	}
	return f, nil
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
		lang, err := fin.Lang(r, db)
		if err != nil {
			return err
		}
		Localize(lang, &f)
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
		lang, err := fin.Lang(r, db)
		if err != nil {
			return err
		}
		Localize(lang, &f)
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
		lang, err := fin.Lang(r, db)
		if err != nil {
			return err
		}
		Localize(lang, &f)
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
		lang, err := fin.Lang(r, db)
		if err != nil {
			return err
		}
		Localize(lang, &f)
		httpx.WriteJSON(w, http.StatusOK, f)
		return nil
	}))
}
