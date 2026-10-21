package mcp

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// TokenPrefix marks MCP client tokens so they are recognizable in config files and secret scanners.
const TokenPrefix = "fpm_"

type Client struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	TokenPrefix string     `json:"tokenPrefix"`
	Enabled     bool       `json:"enabled"`
	LastUsedAt  *time.Time `json:"lastUsedAt"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	RevokedAt   *time.Time `json:"revokedAt"`
	CreatedAt   time.Time  `json:"createdAt"`
	Grants      []Grant    `json:"grants"`
}

type ClientCreated struct {
	Client
	Token string `json:"token"`
}

const clientCols = `id, name, description, token_prefix, enabled, last_used_at, expires_at, revoked_at, created_at`

func (h *handlers) getClient(ctx context.Context, userID, id uuid.UUID) (Client, error) {
	var c Client
	err := h.deps.DB.QueryRow(ctx, `SELECT `+clientCols+` FROM mcp_clients WHERE id = $1 AND user_id = $2`, id, userID).Scan(
		&c.ID, &c.Name, &c.Description, &c.TokenPrefix, &c.Enabled, &c.LastUsedAt, &c.ExpiresAt, &c.RevokedAt, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, httpx.NotFound("MCP client")
	}
	if err != nil {
		return c, err
	}
	c.Grants, err = loadGrants(ctx, h.deps.DB, c.ID)
	if c.Grants == nil {
		c.Grants = []Grant{}
	}
	return c, err
}

func pathID(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return id, httpx.NotFound("resource")
	}
	return id, nil
}

func (h *handlers) listClients(w http.ResponseWriter, r *http.Request) error {
	p, err := requireHuman(r)
	if err != nil {
		return err
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT id FROM mcp_clients WHERE user_id = $1 ORDER BY created_at DESC, id`, p.UserID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	out := httpx.List[Client]{Items: []Client{}}
	for _, id := range ids {
		c, err := h.getClient(r.Context(), p.UserID, id)
		if err != nil {
			return err
		}
		out.Items = append(out.Items, c)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h *handlers) createClient(w http.ResponseWriter, r *http.Request) error {
	p, err := requireHuman(r)
	if err != nil {
		return err
	}
	var in struct {
		Name        string     `json:"name"`
		Description string     `json:"description"`
		ExpiresAt   *time.Time `json:"expiresAt"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	fe := map[string]string{}
	if in.Name == "" || len(in.Name) > 100 {
		fe["name"] = "required, at most 100 characters"
	}
	if len(in.Description) > 1000 {
		fe["description"] = "at most 1000 characters"
	}
	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		fe["expiresAt"] = "must be in the future"
	}
	if len(fe) > 0 {
		return httpx.Validation(fe)
	}
	raw, _ := auth.NewToken()
	tok := TokenPrefix + raw
	id := uuid.New()
	// A new client is read-nothing: it has no grants until the user adds them (MCP disabled by default).
	if _, err := h.deps.DB.Exec(r.Context(), `INSERT INTO mcp_clients (id, user_id, name, description, token_hash, token_prefix, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, p.UserID, in.Name, in.Description, auth.HashToken(tok), tok[:len(TokenPrefix)+6], in.ExpiresAt); err != nil {
		return err
	}
	if err := changes.Audit(r.Context(), h.deps.DB, changes.Entry{Action: "mcp.client.create", EntityType: "mcp_clients", EntityID: &id,
		Metadata: map[string]any{"name": in.Name}}); err != nil {
		return err
	}
	c, err := h.getClient(r.Context(), p.UserID, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, ClientCreated{Client: c, Token: tok})
	return nil
}

func (h *handlers) patchClient(w http.ResponseWriter, r *http.Request) error {
	p, err := requireHuman(r)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	var in struct {
		Name        *string `json:"name"`
		Enabled     *bool   `json:"enabled"`
		Description *string `json:"description"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if in.Name != nil && (strings.TrimSpace(*in.Name) == "" || len(*in.Name) > 100) {
		return httpx.Validation(map[string]string{"name": "1-100 characters"})
	}
	if in.Description != nil && len(*in.Description) > 1000 {
		return httpx.Validation(map[string]string{"description": "at most 1000 characters"})
	}
	tag, err := h.deps.DB.Exec(r.Context(), `UPDATE mcp_clients SET name = coalesce($3, name), enabled = coalesce($4, enabled),
		description = coalesce($5, description) WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, id, p.UserID, in.Name, in.Enabled, in.Description)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("MCP client")
	}
	if err := changes.Audit(r.Context(), h.deps.DB, changes.Entry{Action: "mcp.client.update", EntityType: "mcp_clients", EntityID: &id,
		Metadata: map[string]any{"enabled": in.Enabled, "renamed": in.Name != nil}}); err != nil {
		return err
	}
	c, err := h.getClient(r.Context(), p.UserID, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, c)
	return nil
}

// deleteClient revokes the token immediately (the auth middleware rejects it on the next request)
// and its grants; pending proposals of the client expire.
func (h *handlers) deleteClient(w http.ResponseWriter, r *http.Request) error {
	p, err := requireHuman(r)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	tx, err := h.deps.DB.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `UPDATE mcp_clients SET revoked_at = now(), enabled = false WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, id, p.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("MCP client")
	}
	if _, err := tx.Exec(r.Context(), `UPDATE mcp_permission_grants SET revoked_at = now() WHERE mcp_client_id = $1 AND revoked_at IS NULL`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `UPDATE mcp_proposed_changes SET status = 'expired' WHERE mcp_client_id = $1 AND status IN ('pending','approved')`, id); err != nil {
		return err
	}
	if err := changes.Audit(r.Context(), tx, changes.Entry{Action: "mcp.client.revoke", EntityType: "mcp_clients", EntityID: &id}); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// putGrants replaces all grants of a client. A user can only grant what they have: read scopes need
// viewer, write scopes editor on the profile. approval=auto is allowed only for low-risk scopes.
func (h *handlers) putGrants(w http.ResponseWriter, r *http.Request) error {
	p, err := requireHuman(r)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	var in struct {
		Grants []Grant `json:"grants"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if len(in.Grants) > 200 {
		return httpx.Validation(map[string]string{"grants": "at most 200 grants"})
	}
	if _, err := h.getClient(r.Context(), p.UserID, id); err != nil {
		return err
	}
	fe := map[string]string{}
	seen := map[string]bool{}
	for i, g := range in.Grants {
		key := func(f string) string { return "grants[" + strconv.Itoa(i) + "]." + f }
		write := slices.Contains(writeScopes, g.Scope)
		if !write && !slices.Contains(readScopes, g.Scope) {
			fe[key("scope")] = "unknown scope"
			continue
		}
		if seen[g.ProfileID.String()+g.Scope] {
			fe[key("scope")] = "duplicate scope for this profile"
		}
		seen[g.ProfileID.String()+g.Scope] = true
		min := authz.RoleViewer
		if write {
			min = authz.RoleEditor
		}
		if _, _, err := authz.RequireProfile(r.Context(), h.deps.DB, g.ProfileID, min); err != nil {
			fe[key("profileId")] = "you need " + string(min) + " access to grant " + g.Scope
			continue
		}
		switch g.Approval {
		case "":
			in.Grants[i].Approval = "required"
		case "required":
		case "auto":
			if !slices.Contains(lowRiskScopes, g.Scope) {
				fe[key("approval")] = "auto approval is only allowed for " + strings.Join(lowRiskScopes, ", ")
			}
		default:
			fe[key("approval")] = "required or auto"
		}
		var from, to time.Time
		if g.DateFrom != nil {
			if from, err = fin.ParseDate(*g.DateFrom); err != nil {
				fe[key("dateFrom")] = "YYYY-MM-DD"
			}
		}
		if g.DateTo != nil {
			if to, err = fin.ParseDate(*g.DateTo); err != nil {
				fe[key("dateTo")] = "YYYY-MM-DD"
			}
		}
		if g.DateFrom != nil && g.DateTo != nil && to.Before(from) {
			fe[key("dateTo")] = "must not be before dateFrom"
		}
		if g.AccountIDs != nil {
			var n int
			if err := h.deps.DB.QueryRow(r.Context(), `SELECT count(*) FROM accounts WHERE profile_id = $1 AND deleted_at IS NULL AND id = ANY($2)`,
				g.ProfileID, g.AccountIDs).Scan(&n); err != nil {
				return err
			}
			if n != len(uniqIDs(g.AccountIDs)) {
				fe[key("accountIds")] = "unknown account"
			}
		}
	}
	if len(fe) > 0 {
		return httpx.Validation(fe)
	}
	tx, err := h.deps.DB.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `UPDATE mcp_permission_grants SET revoked_at = now() WHERE mcp_client_id = $1 AND revoked_at IS NULL`, id); err != nil {
		return err
	}
	for _, g := range in.Grants {
		if _, err := tx.Exec(r.Context(), `INSERT INTO mcp_permission_grants (mcp_client_id, profile_id, scope, account_ids, date_from, date_to, approval)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, g.ProfileID, g.Scope, g.AccountIDs, g.DateFrom, g.DateTo, g.Approval); err != nil {
			return err
		}
	}
	if err := changes.Audit(r.Context(), tx, changes.Entry{Action: "mcp.client.grants", EntityType: "mcp_clients", EntityID: &id, After: in.Grants}); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	c, err := h.getClient(r.Context(), p.UserID, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, c)
	return nil
}

func uniqIDs(ids []uuid.UUID) []uuid.UUID {
	var out []uuid.UUID
	for _, id := range ids {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}
