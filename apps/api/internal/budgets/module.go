// Package budgets: Budgets, periods, allocations, rollover, templates.
//
// Owned routes under /api/v1: /budgets
// See docs/api/openapi.yaml for the contract.
package budgets

import (
	"net/http"

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
	syncBudgets.Register()
	syncAllocations.Register()
	idem := httpx.Idempotent(deps.DB)
	db := deps.DB
	profile := func(r *http.Request, role authz.Role) (fin.Profile, error) {
		pid, _, err := authz.ProfileFromRequest(r, db, role)
		if err != nil {
			return fin.Profile{}, err
		}
		return fin.LoadProfile(r.Context(), db, pid)
	}
	load := func(r *http.Request, role authz.Role) (fin.Profile, Budget, error) {
		p, err := profile(r, role)
		if err != nil {
			return p, Budget{}, err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return p, Budget{}, httpx.NotFound("budget")
		}
		b, err := Get(r.Context(), db, p.ID, id)
		return p, b, err
	}

	r.Get("/budgets", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
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
		items, err := List(r.Context(), db, p.ID, after, page.Limit+1)
		if err != nil {
			return err
		}
		out := httpx.List[Budget]{Items: items}
		if len(items) > page.Limit {
			out.Items = items[:page.Limit]
			out.NextCursor = httpx.EncodeCursor(out.Items[page.Limit-1].ID)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.With(idem).Post("/budgets", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var b Budget
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			b, err = Create(r.Context(), tx, p.ID, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, b)
		return nil
	}))
	r.Get("/budgets/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		_, b, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, b)
		return nil
	}))
	r.Patch("/budgets/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in Input
		if err := fin.DecodePatch(r, cur, &in); err != nil {
			return err
		}
		var b Budget
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			b, err = Update(r.Context(), tx, p.ID, cur, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, b)
		return nil
	}))
	r.Delete("/budgets/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		if err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error { return Delete(r.Context(), tx, p.ID, cur) }); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	r.Get("/budgets/{id}/status", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, b, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		d, err := fin.QueryDate(r, "date", p.Today)
		if err != nil {
			return err
		}
		st, err := ComputeStatus(r.Context(), db, b, d, p.Today)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, st)
		return nil
	}))
	r.With(idem).Post("/budgets/{id}/periods/close", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, b, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		d, err := fin.QueryDate(r, "date", p.Today)
		if err != nil {
			return err
		}
		var st Status
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			st, err = ClosePeriod(r.Context(), tx, b, d, p.Today)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, st)
		return nil
	}))
	r.With(idem).Post("/budgets/{id}/instantiate", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, tpl, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in struct {
			Name      string `json:"name"`
			StartDate string `json:"startDate"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var b Budget
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			b, err = Instantiate(r.Context(), tx, p.ID, tpl, in.Name, in.StartDate)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, b)
		return nil
	}))
}
