// Package automation: Categorization rules, suggestions, duplicate & recurring detection.
//
// Owned routes under /api/v1: /rules, /suggestions, /duplicates, /recurring-candidates
// See docs/api/openapi.yaml for the contract. Bulk edit and per-transaction undo are owned by the
// transactions module (/transactions/bulk, /transactions/{id}/undo); rule applications are
// undone here (POST /rules/applications/{id}/undo).
package automation

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	syncEntity.Register()
	db := deps.DB
	idem := httpx.Idempotent(db)
	profile := func(r *http.Request, role authz.Role) (fin.Profile, error) {
		pid, _, err := authz.ProfileFromRequest(r, db, role)
		if err != nil {
			return fin.Profile{}, err
		}
		return fin.LoadProfile(r.Context(), db, pid)
	}
	load := func(r *http.Request, role authz.Role) (fin.Profile, Rule, error) {
		p, err := profile(r, role)
		if err != nil {
			return p, Rule{}, err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return p, Rule{}, httpx.NotFound("rule")
		}
		rule, err := GetRule(r.Context(), db, p.ID, id)
		return p, rule, err
	}

	r.Get("/rules", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		rules, err := ListRules(r.Context(), db, p.ID, false)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Rule]{Items: rules})
		return nil
	}))
	r.With(idem).Post("/rules", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in RuleInput
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var out Rule
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			out, err = CreateRule(r.Context(), tx, p.ID, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, out)
		return nil
	}))
	r.Get("/rules/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		_, rule, err := load(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, rule)
		return nil
	}))
	r.Patch("/rules/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in RuleInput
		if err := fin.DecodePatch(r, cur, &in); err != nil {
			return err
		}
		var out Rule
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			out, err = UpdateRule(r.Context(), tx, p.ID, cur, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.Delete("/rules/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, cur, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		if err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error { return DeleteRule(r.Context(), tx, p.ID, cur) }); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	r.With(idem).Post("/rules/{id}/apply", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, rule, err := load(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in struct {
			DryRun    bool   `json:"dryRun"`
			From      string `json:"from"`
			To        string `json:"to"`
			Overwrite bool   `json:"overwrite"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		from, to := fin.Date(1900, 1, 1), p.Today.AddDate(5, 0, 0)
		if in.From != "" {
			if from, err = fin.ParseDate(in.From); err != nil {
				return httpx.Validation(map[string]string{"from": err.Error()})
			}
		}
		if in.To != "" {
			if to, err = fin.ParseDate(in.To); err != nil {
				return httpx.Validation(map[string]string{"to": err.Error()})
			}
		}
		var res ApplyResult
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			res, err = ApplyRule(r.Context(), tx, p.ID, rule, from, to, in.DryRun, in.Overwrite)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))
	r.With(idem).Post("/rules/applications/{applicationId}/undo", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := uuid.Parse(chi.URLParam(r, "applicationId"))
		if err != nil {
			return httpx.NotFound("rule application")
		}
		var res any
		err = pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
			out, err := UndoApplication(r.Context(), tx, p.ID, id)
			res = out
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))
	r.Get("/suggestions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		var txs []*ledger.Transaction
		if s := r.URL.Query().Get("transactionId"); s != "" {
			id, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation(map[string]string{"transactionId": "uuid"})
			}
			t, err := ledger.Get(r.Context(), db, p.ID, id, false)
			if err != nil {
				return err
			}
			txs = []*ledger.Transaction{t}
		} else {
			// The uncategorized inbox: recent uncategorized income/expense transactions.
			txs, err = ledger.Query(r.Context(), db, `SELECT `+ledger.TxCols+` FROM transactions t WHERE t.profile_id = $1 AND t.deleted_at IS NULL
				AND t.kind IN ('income','expense','refund') AND t.booking_date > $2
				AND EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IS NULL)
				ORDER BY t.booking_date DESC, t.id LIMIT 100`, p.ID, p.Today.AddDate(0, 0, -180))
			if err != nil {
				return err
			}
		}
		out, err := Suggest(r.Context(), db, p.ID, txs)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Suggestion]{Items: out})
		return nil
	}))
	r.Get("/duplicates", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		from, to, err := fin.Range(r, p.Today.AddDate(0, 0, -90), p.Today, 3660)
		if err != nil {
			return err
		}
		out, err := Duplicates(r.Context(), db, p.ID, from, to)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[DuplicateGroup]{Items: out})
		return nil
	}))
	r.Get("/recurring-candidates", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := profile(r, authz.RoleViewer)
		if err != nil {
			return err
		}
		out, err := RecurringCandidates(r.Context(), db, p)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[RecurringCandidate]{Items: out})
		return nil
	}))
}
