// Package users: Current user and user settings.
//
// Owned routes under /api/v1: /users/me, /users/me/settings
// See docs/api/openapi.yaml for the contract.
package users

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// User is the API shape (OpenAPI User). Never contains the password hash.
type User struct {
	ID          uuid.UUID `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	IsAdmin     bool      `json:"isAdmin"`
	Status      string    `json:"status"`
	Locale      string    `json:"locale"`
	Timezone    string    `json:"timezone"`
	CreatedAt   time.Time `json:"createdAt"`
}

// Columns selects the fields Scan expects, in order.
const Columns = `id, email, display_name, is_admin, status, locale, timezone, created_at`

func Scan(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.DisplayName, &u.IsAdmin, &u.Status, &u.Locale, &u.Timezone, &u.CreatedAt)
	return u, err
}

// Get loads a non-deleted user.
func Get(ctx context.Context, q authz.Querier, id uuid.UUID) (User, error) {
	u, err := Scan(q.QueryRow(ctx, `SELECT `+Columns+` FROM users WHERE id = $1 AND deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return u, httpx.NotFound("user")
	}
	return u, err
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	r.Get("/users/me", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		u, err := Get(r.Context(), deps.DB, p.UserID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, u)
		return nil
	}))

	r.Patch("/users/me", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		var in struct {
			DisplayName *string `json:"displayName"`
			Locale      *string `json:"locale"`
			Timezone    *string `json:"timezone"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		fields := map[string]string{}
		if in.DisplayName != nil && len(*in.DisplayName) > 200 {
			fields["displayName"] = "at most 200 characters"
		}
		if in.Locale != nil && (len(*in.Locale) < 2 || len(*in.Locale) > 35) {
			fields["locale"] = "invalid locale"
		}
		if in.Timezone != nil {
			if _, err := time.LoadLocation(*in.Timezone); err != nil || *in.Timezone == "" {
				fields["timezone"] = "unknown IANA time zone"
			}
		}
		if len(fields) > 0 {
			return httpx.Validation(fields)
		}
		u, err := Scan(deps.DB.QueryRow(r.Context(), `UPDATE users SET display_name = COALESCE($2, display_name),
			locale = COALESCE($3, locale), timezone = COALESCE($4, timezone)
			WHERE id = $1 AND deleted_at IS NULL RETURNING `+Columns, p.UserID, trim(in.DisplayName), in.Locale, in.Timezone))
		if err != nil {
			return err
		}
		if err := changes.Audit(r.Context(), deps.DB, changes.Entry{Action: "user.update", EntityType: "users", EntityID: &u.ID}); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, u)
		return nil
	}))

	r.Get("/users/me/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		v, err := GetSettings(r.Context(), deps.DB, "user", &p.UserID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, v)
		return nil
	}))

	r.Put("/users/me/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		v, err := PutSettings(r, deps.DB, "user", &p.UserID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, v)
		return nil
	}))
}

func trim(s *string) *string {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	return &t
}

// settingsKey: user and profile settings are stored as one JSON object per owner.
const settingsKey = "settings"

// GetSettings returns the settings object for (scope, owner) or {}.
func GetSettings(ctx context.Context, q authz.Querier, scope string, owner *uuid.UUID) (map[string]any, error) {
	var raw []byte
	err := q.QueryRow(ctx, `SELECT value FROM settings WHERE scope = $1 AND owner_id IS NOT DISTINCT FROM $2 AND key = $3`,
		scope, owner, settingsKey).Scan(&raw)
	out := map[string]any{}
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(raw, &out)
}

// PutSettings replaces the settings object from the request body (any JSON object; size bounded by MaxBody).
func PutSettings(r *http.Request, db changes.Execer, scope string, owner *uuid.UUID) (map[string]any, error) {
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/json") {
		return nil, httpx.NewError(http.StatusUnsupportedMediaType, "unsupported_media_type", "expected application/json")
	}
	v := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil || v == nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "request body too large")
		}
		return nil, httpx.BadRequest("settings must be a JSON object")
	}
	_, err := db.Exec(r.Context(), `INSERT INTO settings (scope, owner_id, key, value, updated_at) VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (scope, owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, scope, owner, settingsKey, v)
	return v, err
}
