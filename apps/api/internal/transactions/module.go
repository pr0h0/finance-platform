// Package transactions: Transactions, postings, splits, tags, refunds, transfers, templates, bulk edit.
//
// Owned routes under /api/v1: /transactions, /transactions/{id}/splits, /tags, /transaction-templates, /split-templates
// See docs/api/openapi.yaml for the contract.
package transactions

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB
	tags.Mount(r, db)
	templates.Mount(r, db)
	splitTemplates.Mount(r, db)

	r.Get("/transactions", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 50, 500)
		if err != nil {
			return err
		}
		f, err := parseFilter(r.URL.Query(), profileID)
		if err != nil {
			return err
		}
		out, err := search(r.Context(), db, f, page)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Get("/transactions/export", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		f, err := parseFilter(r.URL.Query(), profileID)
		if err != nil {
			return err
		}
		return export(r.Context(), w, db, profileID, f, r.URL.Query().Get("format"))
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions", mutate(db, http.StatusCreated, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return nil, err
		}
		return Create(r.Context(), tx, profileID, in, sourceOf(r))
	}))

	r.Get("/transactions/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "transaction")
		if err != nil {
			return err
		}
		t, err := ledger.Get(r.Context(), db, profileID, id, false)
		if err != nil {
			return err
		}
		if t.DeletedAt != nil {
			return httpx.NotFound("transaction")
		}
		src, err := loadSource(r.Context(), db, t)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, withSource{t, src})
		return nil
	}))

	r.Patch("/transactions/{id}", mutate(db, http.StatusOK, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		cur, err := load(r, tx, profileID)
		if err != nil {
			return nil, err
		}
		p := PatchFrom(cur)
		keys, err := ledger.DecodePatch(r, &p)
		if err != nil {
			return nil, err
		}
		if err := checkVersion(keys, p.Version, cur.Version); err != nil {
			return nil, err
		}
		after, err := ApplyPatch(r.Context(), tx, cur, p, keys)
		if err != nil {
			return nil, err
		}
		return ledger.Update(r.Context(), tx, cur, after, "transaction.update", nil)
	}))

	r.Delete("/transactions/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		err = ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			cur, err := load(r, tx, profileID)
			if err != nil {
				return err
			}
			return Delete(r, tx, cur)
		})
		if err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Put("/transactions/{id}/splits", mutate(db, http.StatusOK, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		cur, err := load(r, tx, profileID)
		if err != nil {
			return nil, err
		}
		var in struct {
			Version         int          `json:"version"`
			Splits          []SplitInput `json:"splits"`
			SplitTemplateID *uuid.UUID   `json:"splitTemplateId"`
		}
		keys, err := ledger.DecodePatch(r, &in)
		if err != nil {
			return nil, err
		}
		if err := checkVersion(keys, in.Version, cur.Version); err != nil {
			return nil, err
		}
		if !ledger.SplitKinds(cur.Kind) {
			return nil, httpx.Validation(map[string]string{"splits": cur.Kind + " transactions are not categorized"})
		}
		after := cur.Clone()
		if in.SplitTemplateID != nil {
			st, err := splitTemplates.Get(r.Context(), tx, profileID, *in.SplitTemplateID, false)
			if err != nil {
				return nil, err
			}
			if after.Splits, err = ApplySplitTemplate(st, cur.Amount()); err != nil {
				return nil, err
			}
		} else {
			if len(in.Splits) == 0 {
				return nil, httpx.Validation(map[string]string{"splits": "at least one split (use categoryId null for uncategorized)"})
			}
			if after.Splits, err = buildSplits(in.Splits, nil, cur.Amount()); err != nil {
				return nil, err
			}
		}
		after.CategorizationSource = "user"
		return ledger.Update(r.Context(), tx, cur, after, "transaction.splits_replace", nil)
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions/{id}/adjustments", mutate(db, http.StatusCreated, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		cur, err := load(r, tx, profileID)
		if err != nil {
			return nil, err
		}
		var in struct {
			Amount      *money.Money `json:"amount"`
			BookingDate string       `json:"bookingDate"`
			Reason      string       `json:"reason"`
			AccountID   *uuid.UUID   `json:"accountId"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return nil, err
		}
		if in.Amount == nil || in.Amount.IsZero() {
			return nil, httpx.Validation(map[string]string{"amount": "required, signed, non-zero"})
		}
		return Adjust(r.Context(), tx, cur, in.AccountID, *in.Amount, in.BookingDate, in.Reason)
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions/{id}/refunds", mutate(db, http.StatusCreated, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		cur, err := load(r, tx, profileID)
		if err != nil {
			return nil, err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return nil, err
		}
		in.Kind, in.RelatedTransactionID = "refund", &cur.ID
		if in.AccountID == uuid.Nil {
			in.AccountID = cur.Postings[0].AccountID
		}
		if in.Description == "" {
			in.Description = "Refund: " + cur.Description
		}
		if in.MerchantID == nil {
			in.MerchantID = cur.MerchantID
		}
		return Create(r.Context(), tx, profileID, in, sourceOf(r))
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions/{id}/duplicate", mutate(db, http.StatusCreated, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		cur, err := load(r, tx, profileID)
		if err != nil {
			return nil, err
		}
		var in struct {
			BookingDate string `json:"bookingDate"`
		}
		if r.ContentLength != 0 {
			if err := httpx.DecodeJSON(r, &in); err != nil {
				return nil, err
			}
		}
		if in.BookingDate == "" {
			in.BookingDate = cur.BookingDate
		}
		dup, err := InputFrom(cur, in.BookingDate)
		if err != nil {
			return nil, err
		}
		return Create(r.Context(), tx, profileID, dup, sourceOf(r))
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions/bulk", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in BulkEdit
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var res *BulkResult
		err = ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			res, err = Bulk(r.Context(), tx, profileID, in)
			if err == nil && len(res.Failed) > 0 {
				return errRollback
			}
			return err
		})
		if err != nil && !errors.Is(err, errRollback) {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))

	r.Get("/transactions/{id}/history", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "transaction")
		if err != nil {
			return err
		}
		if _, err := ledger.Get(r.Context(), db, profileID, id, false); err != nil {
			return err
		}
		items, err := History(r.Context(), db, profileID, id)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[AuditEntry]{Items: items})
		return nil
	}))

	r.With(httpx.Idempotent(db)).Post("/transactions/{id}/undo", mutate(db, http.StatusOK, func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error) {
		id, err := ledger.IDParam(r, "id", "transaction")
		if err != nil {
			return nil, err
		}
		cur, err := ledger.Get(r.Context(), tx, profileID, id, true)
		if err != nil {
			return nil, err
		}
		return Undo(r.Context(), tx, cur)
	}))
}

var errRollback = errors.New("rollback")

// mutate runs fn in a transaction with editor rights and writes its result after commit.
func mutate(db *pgxpool.Pool, status int, fn func(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (any, error)) http.HandlerFunc {
	return httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		var out any
		if err := ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			out, err = fn(r, tx, profileID)
			return err
		}); err != nil {
			return err
		}
		httpx.WriteJSON(w, status, out)
		return nil
	})
}

// load fetches the {id} transaction FOR UPDATE; tombstoned ones are 404.
func load(r *http.Request, tx pgx.Tx, profileID uuid.UUID) (*ledger.Transaction, error) {
	id, err := ledger.IDParam(r, "id", "transaction")
	if err != nil {
		return nil, err
	}
	t, err := ledger.Get(r.Context(), tx, profileID, id, true)
	if err == nil && t.DeletedAt != nil {
		return nil, httpx.NotFound("transaction")
	}
	return t, err
}

func checkVersion(keys map[string]bool, sent, current int) error {
	if !keys["version"] {
		return httpx.Validation(map[string]string{"version": "required"})
	}
	if sent != current {
		return ledger.VersionConflict(current)
	}
	return nil
}

func sourceOf(r *http.Request) string {
	if p, ok := authz.FromContext(r.Context()); ok && p.ActorType == authz.ActorMCP {
		return "mcp"
	}
	return "manual"
}

// Delete tombstones a manual transaction. Imported transactions are evidence: they are excluded from
// reports instead (a batch rollback in the imports module removes them).
func Delete(r *http.Request, tx pgx.Tx, cur *ledger.Transaction) error {
	if cur.IsImported() {
		after := cur.Clone()
		after.ExcludeFromReports = true
		_, err := ledger.Update(r.Context(), tx, cur, after, "transaction.exclude", nil)
		return err
	}
	return ledger.Delete(r.Context(), tx, cur, "transaction.delete")
}

// AuditEntry is the API shape of an audit_log row.
type AuditEntry struct {
	ID         int64           `json:"id"`
	OccurredAt time.Time       `json:"occurredAt"`
	ActorType  string          `json:"actorType"`
	ActorID    *uuid.UUID      `json:"actorId"`
	ProfileID  *uuid.UUID      `json:"profileId"`
	Action     string          `json:"action"`
	EntityType *string         `json:"entityType"`
	EntityID   *uuid.UUID      `json:"entityId"`
	Before     json.RawMessage `json:"before"`
	After      json.RawMessage `json:"after"`
	RequestID  *string         `json:"requestId"`
}
