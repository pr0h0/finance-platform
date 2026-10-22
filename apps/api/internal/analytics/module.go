// Package analytics: Aggregations, reports, insights, anomalies.
//
// Owned routes under /api/v1: /analytics, /reports
// See docs/api/openapi.yaml for the contract and docs/architecture/planning-analytics.md for definitions.
package analytics

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

func principalUser(ctx context.Context) (*uuid.UUID, bool) {
	p, ok := authz.FromContext(ctx)
	if !ok || p.UserID == uuid.Nil {
		return nil, false
	}
	return &p.UserID, true
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB
	// query parses the shared parameters; defRange gives the default [from, to] from today.
	query := func(r *http.Request, defRange func(today fin.Profile) (string, string)) (Query, error) {
		pid, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return Query{}, err
		}
		p, err := fin.LoadProfile(r.Context(), db, pid)
		if err != nil {
			return Query{}, err
		}
		q := Query{P: p, Interval: r.URL.Query().Get("interval"), GroupBy: r.URL.Query().Get("groupBy")}
		if !fin.OneOf(q.Interval, validIntervals...) {
			return q, httpx.Validation(map[string]string{"interval": "none, day, week, month, quarter or year"})
		}
		f, t := defRange(p)
		if q.From, q.To, err = fin.Range(r, fin.MustDate(f), fin.MustDate(t), 3660*2); err != nil {
			return q, err
		}
		if q.Interval == "day" && fin.DaysBetween(q.From, q.To) > 1000 {
			return q, httpx.Validation(map[string]string{"interval": "daily rows are limited to 1000 days"})
		}
		if q.Currency, err = fin.Currency(r, p); err != nil {
			return q, err
		}
		q.AccountIDs, err = fin.AccountIDs(r)
		return q, err
	}
	thisMonth := func(p fin.Profile) (string, string) { return fin.Fmt(fin.MonthStart(p.Today)), fin.Fmt(p.Today) }
	lastYear := func(p fin.Profile) (string, string) {
		return fin.Fmt(fin.MonthStart(p.Today).AddDate(0, -11, 0)), fin.Fmt(p.Today)
	}
	today := func(p fin.Profile) (string, string) { return fin.Fmt(p.Today), fin.Fmt(p.Today) }
	rowsRoute := func(path string, def func(fin.Profile) (string, string), fn func(context.Context, fin.DB, Query) (fin.Rows, error)) {
		r.Get(path, httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			q, err := query(r, def)
			if err != nil {
				return err
			}
			res, err := fn(r.Context(), db, q)
			if err != nil {
				return err
			}
			httpx.WriteJSON(w, http.StatusOK, res)
			return nil
		}))
	}
	rowsRoute("/analytics/spending-by-category", thisMonth, SpendingByCategory)
	rowsRoute("/analytics/spending-by-merchant", thisMonth, SpendingByMerchant)
	rowsRoute("/analytics/income-vs-expenses", lastYear, IncomeVsExpenses)
	rowsRoute("/analytics/trends", lastYear, Trends)
	rowsRoute("/analytics/savings-rate", lastYear, SavingsRate)
	rowsRoute("/analytics/recurring-costs", today, RecurringCosts)
	rowsRoute("/analytics/net-worth", lastYear, NetWorth)
	rowsRoute("/analytics/currency-exposure", today, CurrencyExposure)
	rowsRoute("/analytics/monthly-summary", thisMonth, MonthlySummary)
	rowsRoute("/analytics/conversion-fees", lastYear, ConversionFees)
	rowsRoute("/analytics/import-coverage", today, ImportCoverage)

	r.Get("/analytics/compare", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		q, err := query(r, thisMonth)
		if err != nil {
			return err
		}
		length := fin.DaysBetween(q.From, q.To)
		defFrom, defTo := q.From.AddDate(0, 0, -length-1), q.From.AddDate(0, 0, -1)
		if r.URL.Query().Get("mode") == "year_ago" {
			defFrom, defTo = q.From.AddDate(-1, 0, 0), q.To.AddDate(-1, 0, 0)
		}
		pf, err := fin.QueryDate(r, "compareFrom", defFrom)
		if err != nil {
			return err
		}
		pt, err := fin.QueryDate(r, "compareTo", defTo)
		if err != nil {
			return err
		}
		if pt.Before(pf) {
			return httpx.Validation(map[string]string{"compareTo": "must not be before compareFrom"})
		}
		res, err := Compare(r.Context(), db, q, pf, pt)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))
	r.Get("/analytics/insights", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		q, err := query(r, today)
		if err != nil {
			return err
		}
		items, err := Insights(r.Context(), db, q.P, q.Currency)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Insight]{Items: items})
		return nil
	}))
	r.Get("/analytics/anomalies", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		q, err := query(r, func(p fin.Profile) (string, string) { return fin.Fmt(p.Today.AddDate(0, 0, -90)), fin.Fmt(p.Today) })
		if err != nil {
			return err
		}
		items, err := Anomalies(r.Context(), db, q, r.URL.Query().Get("includeDismissed") == "true")
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Anomaly]{Items: items})
		return nil
	}))
	dismiss := func(undo bool) http.HandlerFunc {
		return httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			pid, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
			if err != nil {
				return err
			}
			id, err := uuid.Parse(chi.URLParam(r, "transactionId"))
			if err != nil {
				return httpx.NotFound("transaction")
			}
			rule := r.URL.Query().Get("rule")
			if err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error { return DismissAnomaly(r.Context(), tx, pid, id, rule, undo) }); err != nil {
				return err
			}
			w.WriteHeader(http.StatusNoContent)
			return nil
		})
	}
	r.Post("/analytics/anomalies/{transactionId}/dismiss", dismiss(false))
	r.Delete("/analytics/anomalies/{transactionId}/dismiss", dismiss(true))

	r.Get("/reports/{kind}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		q, err := query(r, thisMonth)
		if err != nil {
			return err
		}
		kind := chi.URLParam(r, "kind")
		var from, to *time.Time
		if r.URL.Query().Get("from") != "" {
			from = &q.From
		}
		if r.URL.Query().Get("to") != "" {
			to = &q.To
		}
		if q.From, q.To, err = ReportRange(kind, from, to, q.P.Today); err != nil {
			return httpx.Validation(map[string]string{"kind": err.Error()})
		}
		rep, err := BuildReport(r.Context(), db, q, kind)
		if err != nil {
			return err
		}
		name := "report-" + kind + "-" + rep.From + "_" + rep.To
		switch strings.ToLower(r.URL.Query().Get("format")) {
		case "", "json":
			httpx.WriteJSON(w, http.StatusOK, rep)
		case "csv":
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
			if r.URL.Query().Get("bom") == "true" {
				_, _ = w.Write([]byte("\ufeff"))
			}
			_, _ = w.Write(rep.CSV())
		case "pdf":
			w.Header().Set("Content-Type", "application/pdf")
			w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.pdf"`)
			_, _ = w.Write(rep.PDF())
		default:
			return httpx.Validation(map[string]string{"format": "json, csv or pdf"})
		}
		return nil
	}))
}
