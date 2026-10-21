// Package authz carries the authenticated principal in the request context and enforces
// object-level (profile) authorization. The auth module populates the principal; every
// financial handler must call RequireProfile (or ProfileFromRequest) before touching data
// and must still filter every query by profile_id.
package authz

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ActorType string

const (
	ActorUser   ActorType = "user"
	ActorMCP    ActorType = "mcp"
	ActorSystem ActorType = "system"
)

// Principal is who is making the request.
type Principal struct {
	UserID      uuid.UUID
	ActorType   ActorType
	SessionID   uuid.UUID  // zero for MCP/system
	DeviceID    *uuid.UUID // set when the client identified its device
	MCPClientID *uuid.UUID // set for ActorMCP
	IsAdmin     bool
}

// ActorID is the id recorded in audit_log.actor_id.
func (p Principal) ActorID() uuid.UUID {
	if p.MCPClientID != nil {
		return *p.MCPClientID
	}
	return p.UserID
}

type ctxKey struct{}

func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

var (
	ErrUnauthenticated = errors.New("authentication required")
	ErrForbidden       = errors.New("forbidden")
	ErrProfileHeader   = errors.New("missing or invalid X-Profile-ID header")
)

// Require returns the principal or ErrUnauthenticated.
func Require(ctx context.Context) (Principal, error) {
	p, ok := FromContext(ctx)
	if !ok {
		return Principal{}, ErrUnauthenticated
	}
	return p, nil
}

// RequireAdmin returns the principal if it is a server administrator.
func RequireAdmin(ctx context.Context) (Principal, error) {
	p, err := Require(ctx)
	if err == nil && (!p.IsAdmin || p.ActorType != ActorUser) {
		err = ErrForbidden
	}
	return p, err
}

// Role on a profile, ordered owner > editor > viewer.
type Role string

const (
	RoleViewer Role = "viewer"
	RoleEditor Role = "editor"
	RoleOwner  Role = "owner"
)

func (r Role) rank() int {
	switch r {
	case RoleOwner:
		return 3
	case RoleEditor:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

// Querier is satisfied by *pgxpool.Pool, *pgxpool.Conn and pgx.Tx.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// RequireProfile checks the principal's membership of profileID with at least role `min`.
// Unknown profiles and non-membership both return ErrForbidden (no existence oracle).
// MCP principals additionally need grants; the mcp module checks scopes on top of this.
func RequireProfile(ctx context.Context, q Querier, profileID uuid.UUID, min Role) (Principal, Role, error) {
	p, err := Require(ctx)
	if err != nil {
		return p, "", err
	}
	var role Role
	err = q.QueryRow(ctx, `SELECT pm.role FROM profile_members pm JOIN profiles pr ON pr.id = pm.profile_id
		WHERE pm.profile_id = $1 AND pm.user_id = $2 AND pr.deleted_at IS NULL`, profileID, p.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && role.rank() < min.rank()) {
		return p, "", ErrForbidden
	}
	return p, role, err
}

// ProfileHeader is the request header that selects the active financial profile.
const ProfileHeader = "X-Profile-ID"

// ProfileFromRequest reads X-Profile-ID and runs RequireProfile.
func ProfileFromRequest(r *http.Request, q Querier, min Role) (uuid.UUID, Principal, error) {
	id, err := uuid.Parse(r.Header.Get(ProfileHeader))
	if err != nil {
		if _, aerr := Require(r.Context()); aerr != nil {
			return uuid.Nil, Principal{}, aerr
		}
		return uuid.Nil, Principal{}, ErrProfileHeader
	}
	p, _, err := RequireProfile(r.Context(), q, id, min)
	return id, p, err
}

// RequireUser is middleware rejecting unauthenticated requests with 401.
func RequireUser(onErr func(http.ResponseWriter, *http.Request, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, err := Require(r.Context()); err != nil {
				onErr(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
