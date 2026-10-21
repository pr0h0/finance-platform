// Package planning: Planned transactions, occurrences, matching, subscriptions, bill calendar, installments.
//
// Owned routes under /api/v1: /plans, /subscriptions, /bill-calendar
// See docs/api/openapi.yaml for the contract.
//
// Exported service functions (CreatePlan, UpdatePlan, SetOccurrence, Expand, ...) take a pgx.Tx or
// fin.DB so other modules (sync push, MCP, budgets, forecasting) reuse the same validation.
package planning

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	syncPlans.Register()
	syncSubscriptions.Register()
	syncOccurrences.Register()
	h := handlers{deps}
	idem := httpx.Idempotent(deps.DB)
	r.Get("/plans", httpx.H(h.listPlans))
	r.With(idem).Post("/plans", httpx.H(h.createPlan))
	r.Get("/plans/occurrences", httpx.H(h.occurrences))
	r.Get("/plans/match-suggestions", httpx.H(h.matchSuggestions))
	r.Get("/plans/planned-vs-actual", httpx.H(h.plannedVsActual))
	r.Get("/plans/annual", httpx.H(h.annual))
	r.Get("/plans/{id}", httpx.H(h.getPlan))
	r.Patch("/plans/{id}", httpx.H(h.patchPlan))
	r.Delete("/plans/{id}", httpx.H(h.deletePlan))
	r.With(idem).Put("/plans/{id}/occurrences/{date}", httpx.H(h.putOccurrence))
	r.Get("/bill-calendar", httpx.H(h.billCalendar))
	r.Get("/subscriptions", httpx.H(h.listSubs))
	r.With(idem).Post("/subscriptions", httpx.H(h.createSub))
	r.Get("/subscriptions/{id}", httpx.H(h.getSub))
	r.Patch("/subscriptions/{id}", httpx.H(h.patchSub))
	r.Delete("/subscriptions/{id}", httpx.H(h.deleteSub))
}

type handlers struct{ deps *app.Deps }

func (h handlers) profile(r *http.Request, role authz.Role) (fin.Profile, error) {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, role)
	if err != nil {
		return fin.Profile{}, err
	}
	return fin.LoadProfile(r.Context(), h.deps.DB, pid)
}

func pathID(r *http.Request, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return id, httpx.NotFound(what)
	}
	return id, nil
}

func (h handlers) loadPlan(r *http.Request, role authz.Role) (fin.Profile, Plan, error) {
	p, err := h.profile(r, role)
	if err != nil {
		return p, Plan{}, err
	}
	id, err := pathID(r, "plan")
	if err != nil {
		return p, Plan{}, err
	}
	pl, err := GetPlan(r.Context(), h.deps.DB, p.ID, id)
	if err == nil {
		pl.Installments, err = InstallmentProgress(r.Context(), h.deps.DB, p.ID, pl, p.Today)
	}
	return p, pl, err
}

func (h handlers) listPlans(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 50, 500)
	if err != nil {
		return err
	}
	var after uuid.UUID
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	var statuses []string
	if s := r.URL.Query().Get("status"); s != "" {
		statuses = []string{s}
	}
	items, err := ListPlans(r.Context(), h.deps.DB, p.ID, after, page.Limit+1, statuses)
	if err != nil {
		return err
	}
	out := httpx.List[Plan]{Items: items}
	if len(items) > page.Limit {
		out.Items = items[:page.Limit]
		out.NextCursor = httpx.EncodeCursor(out.Items[page.Limit-1].ID)
	}
	for i := range out.Items {
		if out.Items[i].Installments, err = InstallmentProgress(r.Context(), h.deps.DB, p.ID, out.Items[i], p.Today); err != nil {
			return err
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h handlers) createPlan(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in PlanInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	var out Plan
	err = pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error {
		out, err = CreatePlan(r.Context(), tx, p.ID, in)
		return err
	})
	if err != nil {
		return err
	}
	out.Installments, _ = InstallmentProgress(r.Context(), h.deps.DB, p.ID, out, p.Today)
	httpx.WriteJSON(w, http.StatusCreated, out)
	return nil
}

func (h handlers) getPlan(w http.ResponseWriter, r *http.Request) error {
	_, pl, err := h.loadPlan(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, pl)
	return nil
}

func (h handlers) patchPlan(w http.ResponseWriter, r *http.Request) error {
	p, cur, err := h.loadPlan(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in PlanInput
	if err := fin.DecodePatch(r, cur, &in); err != nil {
		return err
	}
	var out Plan
	err = pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error {
		out, err = UpdatePlan(r.Context(), tx, p.ID, cur, in)
		return err
	})
	if err != nil {
		return err
	}
	out.Installments, _ = InstallmentProgress(r.Context(), h.deps.DB, p.ID, out, p.Today)
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h handlers) deletePlan(w http.ResponseWriter, r *http.Request) error {
	p, cur, err := h.loadPlan(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	if err := pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error { return DeletePlan(r.Context(), tx, p.ID, cur) }); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h handlers) putOccurrence(w http.ResponseWriter, r *http.Request) error {
	p, pl, err := h.loadPlan(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	nominal, err := fin.ParseDate(chi.URLParam(r, "date"))
	if err != nil {
		return httpx.Validation(map[string]string{"date": err.Error()})
	}
	var u OccurrenceUpdate
	if err := httpx.DecodeJSON(r, &u); err != nil {
		return err
	}
	err = pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error {
		_, err := SetOccurrence(r.Context(), tx, p.ID, pl, nominal, u)
		return err
	})
	if err != nil {
		return err
	}
	occ, err := ExpandPlans(r.Context(), h.deps.DB, p.ID, []Plan{pl}, nominal.AddDate(0, 0, -400), nominal.AddDate(0, 0, 400), p.Today)
	if err != nil {
		return err
	}
	for _, o := range occ {
		if o.NominalDate == fin.Fmt(nominal) {
			httpx.WriteJSON(w, http.StatusOK, o)
			return nil
		}
	}
	return httpx.Unprocessable("date override moved the occurrence more than 400 days")
}

func (h handlers) occurrences(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	from, to, err := fin.Range(r, p.Today, p.Today.AddDate(0, 0, 30), 366*5)
	if err != nil {
		return err
	}
	occ, err := Expand(r.Context(), h.deps.DB, p.ID, from, to, p.Today, nil)
	if err != nil {
		return err
	}
	return writePaged(w, r, occ)
}

// writePaged pages an in-memory ordered list with an offset cursor.
func writePaged[T any](w http.ResponseWriter, r *http.Request, all []T) error {
	page, err := httpx.ParsePage(r, 500, 5000)
	if err != nil {
		return err
	}
	off := 0
	if err := httpx.DecodeCursor(page.Cursor, &off); err != nil {
		return err
	}
	if off < 0 || off > len(all) {
		return httpx.BadRequest("invalid cursor")
	}
	end := min(off+page.Limit, len(all))
	out := httpx.List[T]{Items: all[off:end]}
	if out.Items == nil {
		out.Items = []T{}
	}
	if end < len(all) {
		out.NextCursor = httpx.EncodeCursor(end)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h handlers) matchSuggestions(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	from, to, err := fin.Range(r, p.Today.AddDate(0, 0, -30), p.Today.AddDate(0, 0, 7), 366)
	if err != nil {
		return err
	}
	s, err := Suggestions(r.Context(), h.deps.DB, p.ID, from, to, p.Today)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.List[MatchSuggestion]{Items: s})
	return nil
}

func (h handlers) plannedVsActual(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	from, to, err := fin.Range(r, fin.MonthStart(p.Today), fin.MonthEnd(p.Today), 366*2)
	if err != nil {
		return err
	}
	cur, err := fin.Currency(r, p)
	if err != nil {
		return err
	}
	res, err := PlannedVsActual(r.Context(), h.deps.DB, p, from, to, cur)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, res)
	return nil
}

func (h handlers) annual(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	year := p.Today.Year()
	if s := r.URL.Query().Get("year"); s != "" {
		if year, err = strconv.Atoi(s); err != nil || year < 1900 || year > 2200 {
			return httpx.Validation(map[string]string{"year": "must be a year"})
		}
	}
	cur, err := fin.Currency(r, p)
	if err != nil {
		return err
	}
	res, err := Annual(r.Context(), h.deps.DB, p, year, cur)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, res)
	return nil
}

func (h handlers) billCalendar(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	from, to, err := fin.Range(r, fin.MonthStart(p.Today), fin.MonthEnd(p.Today), 366)
	if err != nil {
		return err
	}
	occ, err := Expand(r.Context(), h.deps.DB, p.ID, from, to, p.Today, nil)
	if err != nil {
		return err
	}
	bills := []Occurrence{}
	for _, o := range occ {
		if o.Kind != "income" && o.Status != "skipped" {
			bills = append(bills, o)
		}
	}
	return writePaged(w, r, bills)
}

func (h handlers) listSubs(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 50, 500)
	if err != nil {
		return err
	}
	var after uuid.UUID
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	items, err := ListSubscriptions(r.Context(), h.deps.DB, p.ID, after, page.Limit+1, p.Today)
	if err != nil {
		return err
	}
	out := httpx.List[Subscription]{Items: items}
	if len(items) > page.Limit {
		out.Items = items[:page.Limit]
		out.NextCursor = httpx.EncodeCursor(out.Items[page.Limit-1].ID)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h handlers) loadSub(r *http.Request, role authz.Role) (fin.Profile, Subscription, error) {
	p, err := h.profile(r, role)
	if err != nil {
		return p, Subscription{}, err
	}
	id, err := pathID(r, "subscription")
	if err != nil {
		return p, Subscription{}, err
	}
	s, err := GetSubscription(r.Context(), h.deps.DB, p.ID, id, p.Today)
	return p, s, err
}

func (h handlers) createSub(w http.ResponseWriter, r *http.Request) error {
	p, err := h.profile(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in SubscriptionInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	var out Subscription
	err = pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error {
		out, err = CreateSubscription(r.Context(), tx, p.ID, in, p.Today)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, out)
	return nil
}

func (h handlers) getSub(w http.ResponseWriter, r *http.Request) error {
	_, s, err := h.loadSub(r, authz.RoleViewer)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, s)
	return nil
}

func (h handlers) patchSub(w http.ResponseWriter, r *http.Request) error {
	p, cur, err := h.loadSub(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in SubscriptionInput
	if err := fin.DecodePatch(r, cur, &in); err != nil {
		return err
	}
	var out Subscription
	err = pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error {
		out, err = UpdateSubscription(r.Context(), tx, p.ID, cur, in, p.Today)
		return err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h handlers) deleteSub(w http.ResponseWriter, r *http.Request) error {
	p, cur, err := h.loadSub(r, authz.RoleEditor)
	if err != nil {
		return err
	}
	if err := pgx.BeginFunc(r.Context(), h.deps.DB, func(tx pgx.Tx) error { return DeleteSubscription(r.Context(), tx, p.ID, cur) }); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
