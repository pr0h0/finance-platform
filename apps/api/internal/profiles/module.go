// Package profiles: Financial profiles (Feature 92) and profile membership.
//
// Owned routes under /api/v1: /profiles, /profiles/{id}/members
// See docs/api/openapi.yaml for the contract.
//
// Sharing model: a profile is shared by adding members (owner/editor/viewer). A user can only be
// added if they are an active member of the profile's household (Feature 93), so owners cannot
// probe or attach arbitrary accounts.
package profiles

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	_ "time/tzdata" // IANA zones for validation regardless of the container image

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/users"
)

// Profile is the OpenAPI Profile shape.
type Profile struct {
	ID           uuid.UUID  `json:"id"`
	Name         string     `json:"name"`
	OwnerUserID  uuid.UUID  `json:"ownerUserId"`
	HouseholdID  *uuid.UUID `json:"householdId"`
	BaseCurrency string     `json:"baseCurrency"`
	Timezone     string     `json:"timezone"`
	Locale       string     `json:"locale"`
	WeekStart    int        `json:"weekStart"`
	PrivacyMode  string     `json:"privacyMode"`
	Role         authz.Role `json:"role,omitempty"`
	SyncVersion  int64      `json:"syncVersion"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
}

const columns = `p.id, p.name, p.owner_user_id, p.household_id, trim(p.base_currency), p.timezone, p.locale, p.week_start,
	p.privacy_mode, p.sync_version, p.created_at, p.updated_at, p.deleted_at, pm.role`

func scan(row pgx.Row) (Profile, error) {
	var p Profile
	var role *string
	err := row.Scan(&p.ID, &p.Name, &p.OwnerUserID, &p.HouseholdID, &p.BaseCurrency, &p.Timezone, &p.Locale, &p.WeekStart,
		&p.PrivacyMode, &p.SyncVersion, &p.CreatedAt, &p.UpdatedAt, &p.DeletedAt, &role)
	if role != nil {
		p.Role = authz.Role(*role)
	}
	return p, err
}

// Get loads a profile with the caller's role (caller must already have passed RequireProfile).
func Get(ctx context.Context, q authz.Querier, id, userID uuid.UUID) (Profile, error) {
	return scan(q.QueryRow(ctx, `SELECT `+columns+` FROM profiles p
		LEFT JOIN profile_members pm ON pm.profile_id = p.id AND pm.user_id = $2 WHERE p.id = $1`, id, userID))
}

// Input is OpenAPI ProfileInput; pointer fields are optional (PATCH = partial).
type Input struct {
	ID           *uuid.UUID `json:"id,omitempty"`
	Name         string     `json:"name"`
	HouseholdID  *uuid.UUID `json:"householdId,omitempty"`
	BaseCurrency *string    `json:"baseCurrency,omitempty"`
	Timezone     *string    `json:"timezone,omitempty"`
	Locale       *string    `json:"locale,omitempty"`
	WeekStart    *int       `json:"weekStart,omitempty"`
	PrivacyMode  *string    `json:"privacyMode,omitempty"`
}

func (in *Input) validate(requireName bool) error {
	f := map[string]string{}
	in.Name = strings.TrimSpace(in.Name)
	if (requireName || in.Name != "") && (in.Name == "" || len(in.Name) > 100) {
		f["name"] = "1-100 characters"
	}
	if in.BaseCurrency != nil {
		if _, ok := money.Scale(*in.BaseCurrency); !ok {
			f["baseCurrency"] = "unknown ISO 4217 currency"
		}
	}
	if in.Timezone != nil {
		if _, err := time.LoadLocation(*in.Timezone); err != nil || *in.Timezone == "" || *in.Timezone == "Local" {
			f["timezone"] = "unknown IANA time zone"
		}
	}
	if in.Locale != nil && (len(*in.Locale) < 2 || len(*in.Locale) > 35) {
		f["locale"] = "invalid locale"
	}
	if in.WeekStart != nil && (*in.WeekStart < 0 || *in.WeekStart > 6) {
		f["weekStart"] = "0 (Sunday) to 6"
	}
	if in.PrivacyMode != nil && *in.PrivacyMode != "server_readable" && *in.PrivacyMode != "e2ee" {
		f["privacyMode"] = "server_readable or e2ee"
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	return nil
}

// checkHousehold: attaching a profile to a household needs owner/admin rights in it.
func checkHousehold(ctx context.Context, q authz.Querier, householdID *uuid.UUID, userID uuid.UUID) error {
	if householdID == nil {
		return nil
	}
	var role string
	err := q.QueryRow(ctx, `SELECT m.role FROM household_members m JOIN households h ON h.id = m.household_id
		WHERE m.household_id = $1 AND m.user_id = $2 AND m.status = 'active' AND h.deleted_at IS NULL`, *householdID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && role != "owner" && role != "admin") {
		return httpx.Validation(map[string]string{"householdId": "not a household you administer"})
	}
	return err
}

// Create inserts a profile owned by userID (owner membership) inside tx.
func Create(ctx context.Context, tx pgx.Tx, userID uuid.UUID, in Input) (Profile, error) {
	if err := in.validate(true); err != nil {
		return Profile{}, err
	}
	if err := checkHousehold(ctx, tx, in.HouseholdID, userID); err != nil {
		return Profile{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID // client-generated (offline-created profile being activated for sync)
	}
	_, err := tx.Exec(ctx, `INSERT INTO profiles (id, name, owner_user_id, household_id, base_currency, timezone, locale, week_start, privacy_mode)
		VALUES ($1,$2,$3,$4,COALESCE($5,'BAM'),COALESCE($6,'Europe/Sarajevo'),COALESCE($7,'en'),COALESCE($8,1),COALESCE($9,'server_readable'))`,
		id, in.Name, userID, in.HouseholdID, in.BaseCurrency, in.Timezone, in.Locale, in.WeekStart, in.PrivacyMode)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return Profile{}, httpx.NewError(http.StatusConflict, "id_conflict", "a profile with this id already exists")
	}
	if err != nil {
		return Profile{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO profile_members (profile_id, user_id, role) VALUES ($1, $2, 'owner')`, id, userID); err != nil {
		return Profile{}, err
	}
	p, err := Get(ctx, tx, id, userID)
	if err != nil {
		return p, err
	}
	actx := ctx
	if _, ok := authz.FromContext(ctx); !ok {
		actx = authz.WithPrincipal(ctx, authz.Principal{UserID: userID, ActorType: authz.ActorUser})
	}
	return p, changes.Audit(actx, tx, changes.Entry{ProfileID: &id, Action: "profile.create", EntityType: "profiles", EntityID: &id, After: p})
}

func pathID(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		return id, authz.ErrForbidden // same answer as an unknown profile
	}
	return id, nil
}

// requireUser rejects MCP principals: profile management is for people.
func requireUser(ctx context.Context) (authz.Principal, error) {
	p, err := authz.Require(ctx)
	if err == nil && p.ActorType != authz.ActorUser {
		err = authz.ErrForbidden
	}
	return p, err
}

type member struct {
	UserID uuid.UUID  `json:"userId"`
	Email  string     `json:"email"`
	Role   authz.Role `json:"role"`
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB

	r.Get("/profiles", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT `+columns+` FROM profiles p JOIN profile_members pm ON pm.profile_id = p.id
			WHERE pm.user_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at, p.id`, p.UserID)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Profile, error) { return scan(row) })
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Profile]{Items: items})
		return nil
	}))

	r.With(httpx.Idempotent(db)).Post("/profiles", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := requireUser(r.Context())
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		tx, err := db.Begin(r.Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(r.Context())
		out, err := Create(r.Context(), tx, p.UserID, in)
		if err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, out)
		return nil
	}))

	r.Get("/profiles/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		p, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleViewer)
		if err != nil {
			return err
		}
		out, err := Get(r.Context(), db, id, p.UserID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Patch("/profiles/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, err := requireUser(r.Context()); err != nil {
			return err
		}
		p, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleOwner)
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.ID != nil && *in.ID != id {
			return httpx.Validation(map[string]string{"id": "cannot change profile id"})
		}
		if err := in.validate(false); err != nil {
			return err
		}
		ctx := r.Context()
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		before, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM profiles p
			LEFT JOIN profile_members pm ON pm.profile_id = p.id AND pm.user_id = $2 WHERE p.id = $1 FOR UPDATE OF p`, id, p.UserID))
		if err != nil {
			return err
		}
		if in.PrivacyMode != nil && *in.PrivacyMode != before.PrivacyMode && before.SyncVersion > 0 {
			// Converting existing data needs the client-driven re-encryption flow of ADR 0005.
			return httpx.NewError(http.StatusConflict, "privacy_mode_locked",
				"privacy mode can only be chosen before the profile has data; create a new profile and migrate")
		}
		if in.HouseholdID != nil {
			if err := checkHousehold(ctx, tx, in.HouseholdID, p.UserID); err != nil {
				return err
			}
		}
		var name *string
		if in.Name != "" {
			name = &in.Name
		}
		if _, err := tx.Exec(ctx, `UPDATE profiles SET name = COALESCE($2, name), household_id = COALESCE($3, household_id),
			base_currency = COALESCE($4, base_currency), timezone = COALESCE($5, timezone), locale = COALESCE($6, locale),
			week_start = COALESCE($7, week_start), privacy_mode = COALESCE($8, privacy_mode) WHERE id = $1`,
			id, name, in.HouseholdID, in.BaseCurrency, in.Timezone, in.Locale, in.WeekStart, in.PrivacyMode); err != nil {
			return err
		}
		after, err := Get(ctx, tx, id, p.UserID)
		if err != nil {
			return err
		}
		if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &id, Action: "profile.update", EntityType: "profiles", EntityID: &id, Before: before, After: after}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, after)
		return nil
	}))

	r.Delete("/profiles/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, err := requireUser(r.Context()); err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleOwner); err != nil {
			return err
		}
		// Soft delete: data stays for backups/restore; access ends immediately (RequireProfile checks deleted_at).
		if _, err := db.Exec(r.Context(), `UPDATE profiles SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id); err != nil {
			return err
		}
		if err := changes.Audit(r.Context(), db, changes.Entry{ProfileID: &id, Action: "profile.delete", EntityType: "profiles", EntityID: &id}); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Get("/profiles/{id}/members", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleViewer); err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT u.id, u.email, pm.role FROM profile_members pm JOIN users u ON u.id = pm.user_id
			WHERE pm.profile_id = $1 ORDER BY pm.created_at, u.id`, id)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[member])
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[member]{Items: items})
		return nil
	}))

	r.Put("/profiles/{id}/members/{userId}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, err := requireUser(r.Context()); err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleOwner); err != nil {
			return err
		}
		target, err := uuid.Parse(chi.URLParam(r, "userId"))
		if err != nil {
			return httpx.NotFound("user")
		}
		var in struct {
			Role authz.Role `json:"role"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.Role != authz.RoleOwner && in.Role != authz.RoleEditor && in.Role != authz.RoleViewer {
			return httpx.Validation(map[string]string{"role": "owner, editor or viewer"})
		}
		ctx := r.Context()
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE`, id); err != nil {
			return err
		}
		var current *string
		var eligible bool
		if err := tx.QueryRow(ctx, `SELECT (SELECT role FROM profile_members WHERE profile_id = $1 AND user_id = $2),
			EXISTS (SELECT 1 FROM profiles p JOIN household_members m ON m.household_id = p.household_id
				JOIN users u ON u.id = m.user_id
				WHERE p.id = $1 AND m.user_id = $2 AND m.status = 'active' AND u.deleted_at IS NULL)`, id, target).Scan(&current, &eligible); err != nil {
			return err
		}
		if current == nil && !eligible {
			return httpx.NotFound("household member") // only household members can be added
		}
		if current != nil && *current == "owner" && in.Role != authz.RoleOwner {
			if err := ensureAnotherOwner(ctx, tx, id, target); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO profile_members (profile_id, user_id, role) VALUES ($1,$2,$3)
			ON CONFLICT (profile_id, user_id) DO UPDATE SET role = EXCLUDED.role`, id, target, in.Role); err != nil {
			return err
		}
		var m member
		if err := tx.QueryRow(ctx, `SELECT u.id, u.email, pm.role FROM profile_members pm JOIN users u ON u.id = pm.user_id
			WHERE pm.profile_id = $1 AND pm.user_id = $2`, id, target).Scan(&m.UserID, &m.Email, &m.Role); err != nil {
			return err
		}
		if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &id, Action: "profile.member_set", EntityType: "profile_members",
			EntityID: &target, Before: current, After: map[string]any{"role": in.Role}}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, m)
		return nil
	}))

	r.Delete("/profiles/{id}/members/{userId}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		target, err := uuid.Parse(chi.URLParam(r, "userId"))
		if err != nil {
			return httpx.NotFound("member")
		}
		p, err := requireUser(r.Context())
		if err != nil {
			return err
		}
		min := authz.RoleOwner
		if target == p.UserID {
			min = authz.RoleViewer // anyone may leave
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, min); err != nil {
			return err
		}
		ctx := r.Context()
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE`, id); err != nil {
			return err
		}
		if err := ensureAnotherOwner(ctx, tx, id, target); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM profile_members WHERE profile_id = $1 AND user_id = $2`, id, target)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.NotFound("member")
		}
		if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &id, Action: "profile.member_remove", EntityType: "profile_members", EntityID: &target}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Get("/profiles/{id}/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleViewer); err != nil {
			return err
		}
		v, err := users.GetSettings(r.Context(), db, "profile", &id)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, v)
		return nil
	}))

	r.Put("/profiles/{id}/settings", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := pathID(r, "id")
		if err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, id, authz.RoleEditor); err != nil {
			return err
		}
		v, err := users.PutSettings(r, db, "profile", &id)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, v)
		return nil
	}))
}

// ensureAnotherOwner fails when removing/demoting userID would leave the profile without an owner.
func ensureAnotherOwner(ctx context.Context, tx pgx.Tx, profileID, userID uuid.UUID) error {
	var others int
	var isOwner bool
	if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE user_id <> $2 AND role = 'owner'),
		bool_or(user_id = $2 AND role = 'owner') IS TRUE FROM profile_members WHERE profile_id = $1`, profileID, userID).Scan(&others, &isOwner); err != nil {
		return err
	}
	if isOwner && others == 0 {
		return httpx.NewError(http.StatusConflict, "last_owner", "a profile needs at least one owner")
	}
	return nil
}
