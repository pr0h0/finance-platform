package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Scopes (PLAN §29 "Default permissions"). A client without grants can do nothing; read scopes
// never mutate; write scopes produce proposals unless the grant is approval=auto, which is only
// allowed for the low-risk scopes.
var (
	readScopes  = []string{"read_aggregates", "read_transactions", "read_merchants", "read_attachments"}
	writeScopes = []string{"edit_categories", "edit_splits", "edit_metadata", "create_planned", "edit_budgets", "edit_goals", "edit_rules"}
	// Pre-authorizable without per-change approval: classification only, never amounts or plans.
	lowRiskScopes = []string{"edit_categories", "edit_metadata"}
)

type Grant struct {
	ID         uuid.UUID   `json:"id"`
	ProfileID  uuid.UUID   `json:"profileId"`
	Scope      string      `json:"scope"`
	AccountIDs []uuid.UUID `json:"accountIds"`
	DateFrom   *string     `json:"dateFrom"`
	DateTo     *string     `json:"dateTo"`
	Approval   string      `json:"approval"`
}

func loadGrants(ctx context.Context, q fin.DB, clientID uuid.UUID) ([]Grant, error) {
	rows, err := q.Query(ctx, `SELECT id, profile_id, scope, account_ids, date_from::text, date_to::text, approval
		FROM mcp_permission_grants WHERE mcp_client_id = $1 AND revoked_at IS NULL ORDER BY profile_id, scope`, clientID)
	if err != nil {
		return nil, fmt.Errorf("load grants: %w", err)
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Grant, error) {
		var g Grant
		err := r.Scan(&g.ID, &g.ProfileID, &g.Scope, &g.AccountIDs, &g.DateFrom, &g.DateTo, &g.Approval)
		return g, err
	})
}

// session is one authenticated MCP request: the client, its owner and its live grants.
type session struct {
	db          *pgxpool.Pool
	maxRows     int
	cfg         *config.Config // attachment storage (get_attachments)
	clientID    uuid.UUID
	userID      uuid.UUID
	grants      []Grant
	principal   authz.Principal
	batchID     uuid.UUID  // groups the proposals created by one MCP request
	lastProfile *uuid.UUID // profile of the current call, for the audit entry
}

var errClientGone = httpx.NewError(http.StatusUnauthorized, "invalid_token", "MCP client disabled, expired or revoked")

func newSession(ctx context.Context, db *pgxpool.Pool, maxRows int, p authz.Principal) (*session, error) {
	if p.ActorType != authz.ActorMCP || p.MCPClientID == nil {
		return nil, httpx.Unauthorized()
	}
	var n int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM mcp_clients WHERE id = $1 AND user_id = $2 AND enabled AND revoked_at IS NULL
		AND (expires_at IS NULL OR expires_at > now())`, *p.MCPClientID, p.UserID).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errClientGone
	}
	g, err := loadGrants(ctx, db, *p.MCPClientID)
	if err != nil {
		return nil, err
	}
	if maxRows <= 0 {
		maxRows = 500
	}
	return &session{db: db, maxRows: maxRows, clientID: *p.MCPClientID, userID: p.UserID, grants: g, principal: p, batchID: uuid.New()}, nil
}

// view is the effective data scope of one tool call on one profile: the intersection of every
// grant the tool needs (accounts, dates) — PLAN §144.
type view struct {
	P          fin.Profile
	AccountIDs []uuid.UUID // nil = all accounts of the profile
	From, To   *time.Time  // nil = unbounded
	Auto       bool        // every required grant is approval=auto
	Role       authz.Role
}

func toolErr(code, msg string) *httpx.Error { return httpx.NewError(http.StatusForbidden, code, msg) }

func (s *session) profiles() []uuid.UUID {
	var out []uuid.UUID
	for _, g := range s.grants {
		if !slices.Contains(out, g.ProfileID) {
			out = append(out, g.ProfileID)
		}
	}
	return out
}

// view resolves the profile (explicit, or the only granted one) and checks every scope.
func (s *session) view(ctx context.Context, profileID *uuid.UUID, scopes []string) (view, error) {
	var v view
	ps := s.profiles()
	var pid uuid.UUID
	switch {
	case profileID != nil:
		pid = *profileID
		if !slices.Contains(ps, pid) {
			return v, toolErr("profile_not_granted", "this client has no grant on that profile")
		}
	case len(ps) == 1:
		pid = ps[0]
	case len(ps) == 0:
		return v, toolErr("no_grants", "this MCP client has no grants yet; the user must grant access in Settings → AI agents")
	default:
		return v, httpx.Validation(map[string]string{"profileId": fmt.Sprintf("required: the client has grants on %d profiles", len(ps))})
	}
	v.Auto = len(scopes) > 0
	for _, sc := range scopes {
		var g *Grant
		for i := range s.grants {
			if s.grants[i].ProfileID == pid && s.grants[i].Scope == sc {
				g = &s.grants[i]
			}
		}
		if g == nil {
			return v, toolErr("scope_missing", "this client lacks the "+sc+" grant on this profile")
		}
		if g.AccountIDs != nil {
			if v.AccountIDs == nil {
				v.AccountIDs = append([]uuid.UUID{}, g.AccountIDs...)
			} else {
				v.AccountIDs = slices.DeleteFunc(v.AccountIDs, func(id uuid.UUID) bool { return !slices.Contains(g.AccountIDs, id) })
			}
		}
		if g.DateFrom != nil {
			if t, err := fin.ParseDate(*g.DateFrom); err == nil && (v.From == nil || t.After(*v.From)) {
				v.From = &t
			}
		}
		if g.DateTo != nil {
			if t, err := fin.ParseDate(*g.DateTo); err == nil && (v.To == nil || t.Before(*v.To)) {
				v.To = &t
			}
		}
		v.Auto = v.Auto && g.Approval == "auto"
	}
	s.lastProfile = &pid
	// The owning user must still be a member: grants never outlive profile access.
	authCtx := authz.WithPrincipal(ctx, s.principal)
	_, role, err := authz.RequireProfile(authCtx, s.db, pid, authz.RoleViewer)
	if err != nil {
		return v, toolErr("profile_not_granted", "the client's user no longer has access to this profile")
	}
	v.Role = role
	if v.P, err = fin.LoadProfile(ctx, s.db, pid); err != nil {
		return v, err
	}
	return v, nil
}

// entityProfile finds which granted profile owns a row (no existence oracle for other profiles).
func (s *session) entityProfile(ctx context.Context, table string, id uuid.UUID) (uuid.UUID, error) {
	var pid uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT profile_id FROM `+pgx.Identifier{table}.Sanitize()+` WHERE id = $1 AND deleted_at IS NULL AND profile_id = ANY($2)`,
		id, s.profiles()).Scan(&pid)
	if errors.Is(err, pgx.ErrNoRows) {
		return pid, httpx.NotFound(table[:len(table)-1])
	}
	return pid, err
}

func (v view) restricted() bool { return v.AccountIDs != nil }

// accounts intersects requested account ids with the grant (nil = all allowed).
func (v view) accounts(req []uuid.UUID) ([]uuid.UUID, error) {
	if v.AccountIDs == nil {
		if len(req) == 0 {
			return nil, nil
		}
		return req, nil
	}
	if len(req) == 0 {
		if len(v.AccountIDs) == 0 {
			return []uuid.UUID{uuid.Nil}, nil // grant lists no account: matches nothing
		}
		return v.AccountIDs, nil
	}
	for _, id := range req {
		if !slices.Contains(v.AccountIDs, id) {
			return nil, toolErr("account_not_granted", "account "+id.String()+" is outside this client's grant")
		}
	}
	return req, nil
}

func (v view) allowsAccount(id *uuid.UUID) bool {
	if v.AccountIDs == nil {
		return true
	}
	return id != nil && slices.Contains(v.AccountIDs, *id)
}

// clamp narrows [from, to] to the grant's period; defaults apply when the input is empty.
func (v view) clamp(from, to *string, defFrom, defTo time.Time, m *meta) (time.Time, time.Time, error) {
	f, t := defFrom, defTo
	var err error
	if from != nil {
		if f, err = fin.ParseDate(*from); err != nil {
			return f, t, httpx.Validation(map[string]string{"dateFrom": err.Error()})
		}
	}
	if to != nil {
		if t, err = fin.ParseDate(*to); err != nil {
			return f, t, httpx.Validation(map[string]string{"dateTo": err.Error()})
		}
	}
	if v.From != nil && f.Before(*v.From) {
		f = *v.From
		m.warn("dateFrom raised to the start of this client's granted period (" + fin.Fmt(f) + ")")
	}
	if v.To != nil && t.After(*v.To) {
		t = *v.To
		m.warn("dateTo lowered to the end of this client's granted period (" + fin.Fmt(t) + ")")
	}
	if t.Before(f) {
		return f, t, httpx.Validation(map[string]string{"dateTo": "must not be before dateFrom (after applying the granted period)"})
	}
	return f, t, nil
}

// current refuses current-state data (balances, forecasts, budgets) to clients whose grant period
// does not include today.
func (v view) current() error {
	today := v.P.Today
	if (v.From != nil && today.Before(*v.From)) || (v.To != nil && today.After(*v.To)) {
		return toolErr("period_not_granted", "this client's granted period does not include today; current balances and forecasts are not available")
	}
	return nil
}

// unrestricted refuses tools whose results cannot be limited to the granted accounts.
func (v view) unrestricted(what string) error {
	if v.restricted() {
		return toolErr("account_restricted", what+" spans all accounts and is not available to account-restricted clients")
	}
	return nil
}

// meta is resultMeta of packages/mcp-contracts: completeness is always explicit.
type meta struct {
	Complete     bool              `json:"complete"`
	Warnings     []string          `json:"warnings"`
	MissingRates []fin.MissingRate `json:"missingRates"`
	NextCursor   string            `json:"nextCursor,omitempty"`
}

func newMeta() *meta {
	return &meta{Complete: true, Warnings: []string{}, MissingRates: []fin.MissingRate{}}
}

func (m *meta) warn(s string) { m.Warnings = append(m.Warnings, s) }

func (m *meta) merge(complete bool, warnings []string, missing []fin.MissingRate) {
	m.Complete = m.Complete && complete
	m.Warnings = append(m.Warnings, warnings...)
	for _, x := range missing {
		if !slices.Contains(m.MissingRates, x) {
			m.MissingRates = append(m.MissingRates, x)
		}
	}
}
