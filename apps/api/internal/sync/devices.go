package sync

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Device management (Feature 119). Revoking a device revokes its sessions and its E2EE key
// envelopes; it stops future access but cannot recall data already on the device (ADR 0005).
func registerDevices(r chi.Router, db *pgxpool.Pool) {
	userOnly := func(r *http.Request) (authz.Principal, error) {
		p, err := authz.Require(r.Context())
		if err == nil && p.ActorType != authz.ActorUser {
			err = authz.ErrForbidden
		}
		return p, err
	}

	r.Get("/devices", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT `+auth.DeviceColumns+` FROM devices WHERE user_id = $1
			ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 500`, p.UserID)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (auth.Device, error) { return auth.ScanDevice(row) })
		if err != nil {
			return err
		}
		if items == nil {
			items = []auth.Device{}
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[auth.Device]{Items: items})
		return nil
	}))

	r.Post("/devices", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		var in auth.DeviceInput
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		ctx := r.Context()
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		d, err := auth.CreateDevice(ctx, tx, p.UserID, in)
		if err != nil {
			return err
		}
		// Enrolling from a session without a device binds that session to it (revoking the device ends it).
		if _, err := tx.Exec(ctx, `UPDATE sessions SET device_id = $2 WHERE id = $1 AND device_id IS NULL`, p.SessionID, d.ID); err != nil {
			return err
		}
		if err := changes.Audit(ctx, tx, changes.Entry{Action: "device.enroll", EntityType: "devices", EntityID: &d.ID,
			Metadata: map[string]any{"platform": d.Platform}}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, d)
		return nil
	}))

	r.Patch("/devices/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return httpx.NotFound("device")
		}
		var in struct {
			Name *string `json:"name"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.Name != nil {
			n := strings.TrimSpace(*in.Name)
			if n == "" || len(n) > 100 {
				return httpx.Validation(map[string]string{"name": "1-100 characters"})
			}
			in.Name = &n
		}
		d, err := auth.ScanDevice(db.QueryRow(r.Context(), `UPDATE devices SET name = COALESCE($3, name) WHERE id = $1 AND user_id = $2
			RETURNING `+auth.DeviceColumns, id, p.UserID, in.Name))
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound("device")
		}
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, d)
		return nil
	}))

	r.Delete("/devices/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return httpx.NotFound("device")
		}
		ctx := r.Context()
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		tag, err := tx.Exec(ctx, `UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2`, id, p.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.NotFound("device")
		}
		if _, err := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE key_envelopes SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, id); err != nil {
			return err
		}
		if err := changes.Audit(ctx, tx, changes.Entry{Action: "device.revoke", EntityType: "devices", EntityID: &id}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}
