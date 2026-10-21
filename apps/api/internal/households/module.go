// Package households: Households, membership and invitations (Feature 93).
//
// Owned routes under /api/v1: /households, /households/{id}/members, /household-invitations
// See docs/api/openapi.yaml for the contract.
//
// Roles: owner (everything), admin (invite/remove members, rename), member, viewer. Household
// membership makes a user eligible to be added to the household's profiles; the actual access
// to financial data is granted per profile (profile_members). Invitations are single-use tokens
// (only the sha256 is stored) bound to the invited email, valid for 7 days; no SMTP is needed —
// the inviter passes the token/link on.
package households

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

const inviteTTL = 7 * 24 * time.Hour

type Member struct {
	ID           uuid.UUID  `json:"id"`
	HouseholdID  uuid.UUID  `json:"householdId"`
	UserID       *uuid.UUID `json:"userId"`
	InvitedEmail *string    `json:"invitedEmail"`
	Role         string     `json:"role"`
	Status       string     `json:"status"`
	JoinedAt     *time.Time `json:"joinedAt"`
}

type Household struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	CreatedBy uuid.UUID `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	Members   []Member  `json:"members"`
}

const memberCols = `id, household_id, user_id, invited_email, role, status, joined_at`

func scanMember(row pgx.Row) (Member, error) {
	var m Member
	err := row.Scan(&m.ID, &m.HouseholdID, &m.UserID, &m.InvitedEmail, &m.Role, &m.Status, &m.JoinedAt)
	return m, err
}

func load(ctx context.Context, q interface {
	authz.Querier
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}, id uuid.UUID) (Household, error) {
	var h Household
	if err := q.QueryRow(ctx, `SELECT id, name, created_by, created_at FROM households WHERE id = $1`, id).
		Scan(&h.ID, &h.Name, &h.CreatedBy, &h.CreatedAt); err != nil {
		return h, err
	}
	rows, err := q.Query(ctx, `SELECT `+memberCols+` FROM household_members WHERE household_id = $1 AND status <> 'removed'
		ORDER BY created_at, id`, id)
	if err != nil {
		return h, err
	}
	h.Members, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) { return scanMember(row) })
	return h, err
}

var roleRank = map[string]int{"owner": 4, "admin": 3, "member": 2, "viewer": 1}

// requireRole returns the caller's active role in the household or 404 (no existence oracle).
func requireRole(ctx context.Context, q authz.Querier, id uuid.UUID, min string) (authz.Principal, string, error) {
	p, err := authz.Require(ctx)
	if err != nil {
		return p, "", err
	}
	if p.ActorType != authz.ActorUser {
		return p, "", authz.ErrForbidden
	}
	var role string
	err = q.QueryRow(ctx, `SELECT m.role FROM household_members m JOIN households h ON h.id = m.household_id
		WHERE m.household_id = $1 AND m.user_id = $2 AND m.status = 'active' AND h.deleted_at IS NULL`, id, p.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, "", httpx.NotFound("household")
	}
	if err == nil && roleRank[role] < roleRank[min] {
		return p, role, httpx.Forbidden()
	}
	return p, role, err
}

func parseID(r *http.Request, name, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		return id, httpx.NotFound(what)
	}
	return id, nil
}

func validName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 100 {
		return s, httpx.Validation(map[string]string{"name": "1-100 characters"})
	}
	return s, nil
}

func withTx(ctx context.Context, db *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB

	r.Get("/households", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT h.id FROM households h JOIN household_members m ON m.household_id = h.id
			WHERE m.user_id = $1 AND m.status = 'active' AND h.deleted_at IS NULL ORDER BY h.created_at, h.id`, p.UserID)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return err
		}
		items := make([]Household, 0, len(ids))
		for _, id := range ids {
			h, err := load(r.Context(), db, id)
			if err != nil {
				return err
			}
			items = append(items, h)
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Household]{Items: items})
		return nil
	}))

	r.Post("/households", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		if p.ActorType != authz.ActorUser {
			return authz.ErrForbidden
		}
		var in struct {
			Name string `json:"name"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		name, err := validName(in.Name)
		if err != nil {
			return err
		}
		var h Household
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			var id uuid.UUID
			if err := tx.QueryRow(r.Context(), `INSERT INTO households (name, created_by) VALUES ($1, $2) RETURNING id`, name, p.UserID).Scan(&id); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `INSERT INTO household_members (household_id, user_id, role, status, joined_at)
				VALUES ($1, $2, 'owner', 'active', now())`, id, p.UserID); err != nil {
				return err
			}
			if h, err = load(r.Context(), tx, id); err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.create", EntityType: "households", EntityID: &id, After: h})
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, h)
		return nil
	}))

	r.Get("/households/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		if _, _, err := requireRole(r.Context(), db, id, "viewer"); err != nil {
			return err
		}
		h, err := load(r.Context(), db, id)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, h)
		return nil
	}))

	r.Patch("/households/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		if _, _, err := requireRole(r.Context(), db, id, "admin"); err != nil {
			return err
		}
		var in struct {
			Name *string `json:"name"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var h Household
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			if in.Name != nil {
				name, err := validName(*in.Name)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(r.Context(), `UPDATE households SET name = $2 WHERE id = $1`, id, name); err != nil {
					return err
				}
			}
			if h, err = load(r.Context(), tx, id); err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.update", EntityType: "households", EntityID: &id, After: map[string]any{"name": h.Name}})
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, h)
		return nil
	}))

	r.Delete("/households/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		if _, _, err := requireRole(r.Context(), db, id, "owner"); err != nil {
			return err
		}
		// Profiles stay with their owners (detached); profile memberships are not touched.
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(), `UPDATE households SET deleted_at = now() WHERE id = $1`, id); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `UPDATE profiles SET household_id = NULL WHERE household_id = $1`, id); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `UPDATE household_members SET invite_token_hash = NULL WHERE household_id = $1`, id); err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.delete", EntityType: "households", EntityID: &id})
		})
		if err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Post("/households/{id}/invitations", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		_, myRole, err := requireRole(r.Context(), db, id, "admin")
		if err != nil {
			return err
		}
		var in struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		in.Email = strings.TrimSpace(in.Email)
		if in.Role == "" {
			in.Role = "member"
		}
		f := map[string]string{}
		if a, err := mail.ParseAddress(in.Email); err != nil || a.Address != in.Email {
			f["email"] = "invalid email address"
		}
		if _, ok := roleRank[in.Role]; !ok {
			f["role"] = "owner, admin, member or viewer"
		} else if roleRank[in.Role] > roleRank[myRole] {
			f["role"] = "cannot grant a role above your own"
		}
		if len(f) > 0 {
			return httpx.Validation(f)
		}
		token, hash := auth.NewToken()
		var m Member
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM household_members m LEFT JOIN users u ON u.id = m.user_id
				WHERE m.household_id = $1 AND m.status = 'active' AND lower(u.email) = lower($2))`, id, in.Email).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return httpx.NewError(http.StatusConflict, "already_member", "this person is already a member")
			}
			// Re-inviting the same email replaces the previous pending invitation.
			if _, err := tx.Exec(r.Context(), `UPDATE household_members SET status = 'removed', invite_token_hash = NULL
				WHERE household_id = $1 AND status = 'invited' AND lower(invited_email) = lower($2)`, id, in.Email); err != nil {
				return err
			}
			var err error
			m, err = scanMember(tx.QueryRow(r.Context(), `INSERT INTO household_members
				(household_id, invited_email, role, status, invited_by, invite_token_hash, invite_expires_at)
				VALUES ($1, $2, $3, 'invited', $4, $5, $6) RETURNING `+memberCols,
				id, in.Email, in.Role, mustUser(r.Context()), hash, time.Now().Add(inviteTTL)))
			if err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.invite", EntityType: "household_members", EntityID: &m.ID,
				Metadata: map[string]any{"household_id": id.String(), "role": in.Role}})
		})
		if err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSON(w, http.StatusCreated, map[string]any{"member": m, "inviteToken": token})
		return nil
	}))

	r.Post("/household-invitations/accept", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		if p.ActorType != authz.ActorUser {
			return authz.ErrForbidden
		}
		var in struct {
			Token string `json:"token"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		invalid := httpx.NewError(http.StatusNotFound, "invitation_invalid", "invitation not found, expired or for another account")
		var h Household
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			var memberID, householdID uuid.UUID
			err := tx.QueryRow(r.Context(), `SELECT m.id, m.household_id FROM household_members m
				JOIN households h ON h.id = m.household_id JOIN users u ON u.id = $2
				WHERE m.invite_token_hash = $1 AND m.status = 'invited' AND m.invite_expires_at > now()
				  AND h.deleted_at IS NULL AND lower(m.invited_email) = lower(u.email) FOR UPDATE OF m`,
				auth.HashToken(in.Token), p.UserID).Scan(&memberID, &householdID)
			if errors.Is(err, pgx.ErrNoRows) {
				return invalid
			}
			if err != nil {
				return err
			}
			// The user may have an older (removed) membership row: reactivate it with the invited role
			// and retire the invite row, because (household_id, user_id) is unique.
			tag, err := tx.Exec(r.Context(), `UPDATE household_members o SET status = 'active', role = inv.role, joined_at = now()
				FROM household_members inv WHERE inv.id = $1 AND o.household_id = $2 AND o.user_id = $3`,
				memberID, householdID, p.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() > 0 {
				_, err = tx.Exec(r.Context(), `UPDATE household_members SET status = 'removed', invite_token_hash = NULL WHERE id = $1`, memberID)
			} else {
				_, err = tx.Exec(r.Context(), `UPDATE household_members SET user_id = $2, status = 'active', joined_at = now(),
					invite_token_hash = NULL WHERE id = $1`, memberID, p.UserID)
			}
			if err != nil {
				return err
			}
			if h, err = load(r.Context(), tx, householdID); err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.join", EntityType: "household_members", EntityID: &memberID,
				Metadata: map[string]any{"household_id": householdID.String()}})
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, h)
		return nil
	}))

	r.Patch("/households/{id}/members/{memberId}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		memberID, err := parseID(r, "memberId", "member")
		if err != nil {
			return err
		}
		_, myRole, err := requireRole(r.Context(), db, id, "admin")
		if err != nil {
			return err
		}
		var in struct {
			Role string `json:"role"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if _, ok := roleRank[in.Role]; !ok {
			return httpx.Validation(map[string]string{"role": "owner, admin, member or viewer"})
		}
		var m Member
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			var err error
			m, err = lockMember(r.Context(), tx, id, memberID)
			if err != nil {
				return err
			}
			if roleRank[in.Role] > roleRank[myRole] || roleRank[m.Role] > roleRank[myRole] {
				return httpx.Forbidden()
			}
			if m.Role == "owner" && in.Role != "owner" {
				if err := ensureOwnerRemains(r.Context(), tx, id, memberID); err != nil {
					return err
				}
			}
			if m, err = scanMember(tx.QueryRow(r.Context(), `UPDATE household_members SET role = $2 WHERE id = $1 RETURNING `+memberCols, memberID, in.Role)); err != nil {
				return err
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.member_role", EntityType: "household_members", EntityID: &memberID,
				After: map[string]any{"role": in.Role}, Metadata: map[string]any{"household_id": id.String()}})
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, m)
		return nil
	}))

	r.Delete("/households/{id}/members/{memberId}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		id, err := parseID(r, "id", "household")
		if err != nil {
			return err
		}
		memberID, err := parseID(r, "memberId", "member")
		if err != nil {
			return err
		}
		p, myRole, err := requireRole(r.Context(), db, id, "viewer")
		if err != nil {
			return err
		}
		err = withTx(r.Context(), db, func(tx pgx.Tx) error {
			m, err := lockMember(r.Context(), tx, id, memberID)
			if err != nil {
				return err
			}
			self := m.UserID != nil && *m.UserID == p.UserID
			if !self && (roleRank[myRole] < roleRank["admin"] || roleRank[m.Role] > roleRank[myRole]) {
				return httpx.Forbidden()
			}
			if m.Role == "owner" {
				if err := ensureOwnerRemains(r.Context(), tx, id, memberID); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(r.Context(), `UPDATE household_members SET status = 'removed', invite_token_hash = NULL WHERE id = $1`, memberID); err != nil {
				return err
			}
			// Leaving the household ends access to its shared profiles (profiles they own are kept).
			if m.UserID != nil {
				if _, err := tx.Exec(r.Context(), `DELETE FROM profile_members pm USING profiles p
					WHERE pm.profile_id = p.id AND p.household_id = $1 AND pm.user_id = $2 AND p.owner_user_id <> $2`, id, *m.UserID); err != nil {
					return err
				}
			}
			return changes.Audit(r.Context(), tx, changes.Entry{Action: "household.member_remove", EntityType: "household_members", EntityID: &memberID,
				Metadata: map[string]any{"household_id": id.String()}})
		})
		if err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}

func mustUser(ctx context.Context) uuid.UUID {
	p, _ := authz.FromContext(ctx)
	return p.UserID
}

func lockMember(ctx context.Context, tx pgx.Tx, householdID, memberID uuid.UUID) (Member, error) {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM households WHERE id = $1 FOR UPDATE`, householdID); err != nil {
		return Member{}, err
	}
	m, err := scanMember(tx.QueryRow(ctx, `SELECT `+memberCols+` FROM household_members
		WHERE id = $1 AND household_id = $2 AND status <> 'removed'`, memberID, householdID))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, httpx.NotFound("member")
	}
	return m, err
}

func ensureOwnerRemains(ctx context.Context, tx pgx.Tx, householdID, memberID uuid.UUID) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM household_members WHERE household_id = $1 AND id <> $2
		AND role = 'owner' AND status = 'active'`, householdID, memberID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return httpx.NewError(http.StatusConflict, "last_owner", "a household needs at least one owner")
	}
	return nil
}
