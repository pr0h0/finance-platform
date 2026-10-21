// Package savings: Savings goals, contributions, completion estimates and emergency-fund coverage.
//
// Owned routes under /api/v1: /goals
// See docs/api/openapi.yaml for the contract.
package savings

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
	syncGoals.Register()
	syncContributions.Register()
	db := deps.DB
	idem := httpx.Idempotent(db)
	profile := func(r *http.Request, role authz.Role) (fin.Profile, error) {
		pid, _, err := authz.ProfileFromRequest(r, db, role)
		if err != nil {
			return fin.Profile{}, err
		}
		return fin.LoadProfile(r.Context(), db, pid)
	}
	load := func(r *http.Request, role authz.Role) (fin.Profile, Goal, error) {
		p, err := profile(r, role)
		if err != nil {
			return p, Goal{}, err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return p, Goal{}, httpx.NotFound("goal")
		}
		g, err := Get(r.Context(), db, p, id)
		return p, g, err
	}

	r.Get("/goals", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
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
		items, err := List(r.Context(), db, p, after, page.Limit+1)
		if err != nil {
			return err
		}
		out := httpx.List[Goal]{Items: items}
		if len(items) > page.Limit {
			out.Items = items[:page.Limit]
			out.NextCursor = httpx.EncodeCursor(out.Items[page.Limit-1].ID)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.With(idem).Post("/goals", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var g Goal
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			g, err = Create(r.Context(), tx, p, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, g)
		return nil
	}))
	r.Get("/goals/emergency-fund", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		cur, err := fin.Currency(r, p)
		if err != nil {
			return err
		}
		ef, err := Emergency(r.Context(), db, p, cur)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, ef)
		return nil
	}))
	r.Get("/goals/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		_, g, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, g)
		return nil
	}))
	r.Get("/goals/{id}/projection", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		_, g, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"estimatedCompletion": g.EstimatedCompletion, "requiredMonthly": g.RequiredMonthly,
			"onTrack": g.OnTrack, "basis": g.Basis, "saved": g.Saved, "progress": g.Progress})
		return nil
	}))
	r.Patch("/goals/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in Input
		if err := fin.DecodePatch(r, cur, &in); err != nil {
			return err
		}
		var g Goal
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			g, err = Update(r.Context(), tx, p, cur, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, g)
		return nil
	}))
	r.Delete("/goals/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		if err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error { return Delete(r.Context(), tx, p, cur) }); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	r.Get("/goals/{id}/contributions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, g, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		items, err := Contributions(r.Context(), db, p.ID, g.ID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Contribution]{Items: items})
		return nil
	}))
	r.With(idem).Post("/goals/{id}/contributions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, g, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in ContributionInput
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var c Contribution
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			c, err = AddContribution(r.Context(), tx, p, g, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, c)
		return nil
	}))
	r.Delete("/goals/{id}/contributions/{contributionId}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, g, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		cid, err := uuid.Parse(chi.URLParam(r, "contributionId"))
		if err != nil {
			return httpx.NotFound("contribution")
		}
		if err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error { return DeleteContribution(r.Context(), tx, p, g.ID, cid) }); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}
