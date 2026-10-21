package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

type Proposal struct {
	ID          uuid.UUID       `json:"id"`
	ProfileID   uuid.UUID       `json:"profileId"`
	MCPClientID uuid.UUID       `json:"mcpClientId"`
	BatchID     *uuid.UUID      `json:"batchId"`
	Tool        string          `json:"tool"`
	Input       json.RawMessage `json:"input"`
	Preview     json.RawMessage `json:"preview"`
	Status      string          `json:"status"`
	DecidedBy   *uuid.UUID      `json:"decidedBy"`
	DecidedAt   *time.Time      `json:"decidedAt"`
	AppliedAt   *time.Time      `json:"appliedAt"`
	Result      json.RawMessage `json:"result"`
	Error       *string         `json:"error"`
	ExpiresAt   *time.Time      `json:"expiresAt"`
	CreatedAt   time.Time       `json:"createdAt"`
}

const proposalCols = `id, profile_id, mcp_client_id, batch_id, tool, input, preview, status, decided_by, decided_at, applied_at, result, error, expires_at, created_at`

func scanProposal(row pgx.Row) (Proposal, error) {
	var p Proposal
	var result []byte
	err := row.Scan(&p.ID, &p.ProfileID, &p.MCPClientID, &p.BatchID, &p.Tool, &p.Input, &p.Preview, &p.Status, &p.DecidedBy, &p.DecidedAt,
		&p.AppliedAt, &result, &p.Error, &p.ExpiresAt, &p.CreatedAt)
	if result != nil {
		p.Result = result
	}
	return p, err
}

// expire marks overdue pending/approved proposals (lazy; no background job needed).
func expire(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, `UPDATE mcp_proposed_changes SET status = 'expired' WHERE status IN ('pending','approved') AND expires_at < now()`)
	return err
}

// applyProposal applies an approved proposal under the MCP client's identity: the client must still
// be enabled with the needed grants; the input is re-validated, targets must be unchanged, and the
// change + proposal status commit atomically. clientID (MCP path) restricts to the caller's proposals.
func applyProposal(ctx context.Context, db *pgxpool.Pool, maxRows int, id uuid.UUID, clientID *uuid.UUID) (Proposal, error) {
	if err := expire(ctx, db); err != nil {
		return Proposal{}, err
	}
	p, err := scanProposal(db.QueryRow(ctx, `SELECT `+proposalCols+` FROM mcp_proposed_changes WHERE id = $1 AND ($2::uuid IS NULL OR mcp_client_id = $2)`, id, clientID))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpx.NotFound("proposal")
	}
	if err != nil || p.Status != "approved" {
		return p, err
	}
	var userID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT user_id FROM mcp_clients WHERE id = $1`, p.MCPClientID).Scan(&userID); err != nil {
		return p, err
	}
	principal := authz.Principal{UserID: userID, ActorType: authz.ActorMCP, MCPClientID: &p.MCPClientID}
	ctx = authz.WithPrincipal(ctx, principal)
	fail := func(cause error) (Proposal, error) {
		msg := errorPayload(cause)["error"].(map[string]any)["message"].(string)
		_, _ = db.Exec(ctx, `UPDATE mcp_proposed_changes SET status = 'failed', error = $2 WHERE id = $1 AND status = 'approved'`, p.ID, msg)
		_ = changes.Audit(ctx, db, changes.Entry{ProfileID: &p.ProfileID, Action: "mcp.change.failed", EntityType: "mcp_proposed_changes", EntityID: &p.ID,
			Metadata: map[string]any{"tool": p.Tool, "error": msg}})
		p.Status, p.Error = "failed", &msg
		return p, nil
	}
	s, err := newSession(ctx, db, maxRows, principal)
	if err != nil {
		return fail(err)
	}
	prep, ok := writeTools[p.Tool]
	def := findTool(p.Tool)
	if !ok || def == nil {
		return fail(fmt.Errorf("unknown tool %s", p.Tool))
	}
	pr, err := prep(ctx, s, def, p.Input)
	if err != nil {
		return fail(err)
	}
	if pr.view.P.ID != p.ProfileID {
		return fail(httpx.Conflict("proposal profile changed"))
	}
	var stored struct {
		Targets []target `json:"targets"`
	}
	_ = json.Unmarshal(p.Preview, &stored)
	tx, err := db.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM mcp_proposed_changes WHERE id = $1 FOR UPDATE`, p.ID).Scan(&status); err != nil {
		return p, err
	}
	if status != "approved" {
		p.Status = status
		return p, nil // concurrently applied/rejected
	}
	if err := checkTargets(ctx, tx, p.ProfileID, stored.Targets); err != nil {
		tx.Rollback(ctx)
		return fail(err)
	}
	res, err := pr.apply(ctx, tx)
	if err != nil {
		tx.Rollback(ctx)
		return fail(err)
	}
	resJSON, _ := json.Marshal(res)
	p, err = scanProposal(tx.QueryRow(ctx, `UPDATE mcp_proposed_changes SET status = 'applied', applied_at = now(), result = $2 WHERE id = $1 RETURNING `+proposalCols, p.ID, resJSON))
	if err != nil {
		return p, err
	}
	if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &p.ProfileID, Action: "mcp.change.apply", EntityType: "mcp_proposed_changes", EntityID: &p.ID,
		Metadata: map[string]any{"tool": p.Tool, "approved_by": p.DecidedBy}}); err != nil {
		return p, err
	}
	return p, tx.Commit(ctx)
}

// ---------- REST (humans only) ----------

func requireHuman(r *http.Request) (authz.Principal, error) {
	p, err := authz.Require(r.Context())
	if err == nil && p.ActorType != authz.ActorUser {
		err = httpx.NewError(http.StatusForbidden, "human_required", "only a signed-in user can manage MCP clients and approve changes")
	}
	return p, err
}

func (h *handlers) listProposals(w http.ResponseWriter, r *http.Request) error {
	if _, err := requireHuman(r); err != nil {
		return err
	}
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	if err := expire(r.Context(), h.deps.DB); err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 50, 200)
	if err != nil {
		return err
	}
	after := struct {
		At time.Time
		ID uuid.UUID
	}{At: time.Now().Add(time.Hour)}
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	var status *string
	if s := r.URL.Query().Get("status"); s != "" {
		status = &s
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT `+proposalCols+` FROM mcp_proposed_changes WHERE profile_id = $1 AND ($2::text IS NULL OR status = $2)
		AND (created_at, id) < ($3, $4) ORDER BY created_at DESC, id DESC LIMIT $5`, pid, status, after.At, after.ID, page.Limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := httpx.List[Proposal]{Items: []Proposal{}}
	for rows.Next() {
		p, err := scanProposal(rows)
		if err != nil {
			return err
		}
		out.Items = append(out.Items, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(out.Items) > page.Limit {
		out.Items = out.Items[:page.Limit]
		l := out.Items[page.Limit-1]
		out.NextCursor = httpx.EncodeCursor(struct {
			At time.Time
			ID uuid.UUID
		}{l.CreatedAt, l.ID})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

// decide approves or rejects a pending proposal; approve with ?apply=true also applies it.
func (h *handlers) decide(ctx context.Context, r *http.Request, profileID, id uuid.UUID, approve bool) (Proposal, error) {
	p, err := requireHuman(r)
	if err != nil {
		return Proposal{}, err
	}
	if err := expire(ctx, h.deps.DB); err != nil {
		return Proposal{}, err
	}
	status := "rejected"
	if approve {
		status = "approved"
	}
	pr, err := scanProposal(h.deps.DB.QueryRow(ctx, `UPDATE mcp_proposed_changes SET status = $3, decided_by = $4, decided_at = now()
		WHERE id = $1 AND profile_id = $2 AND status = 'pending' RETURNING `+proposalCols, id, profileID, status, p.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		var cur string
		if h.deps.DB.QueryRow(ctx, `SELECT status FROM mcp_proposed_changes WHERE id = $1 AND profile_id = $2`, id, profileID).Scan(&cur) != nil {
			return pr, httpx.NotFound("proposal")
		}
		return pr, httpx.Conflict("proposal is " + cur)
	}
	if err != nil {
		return pr, err
	}
	if err := changes.Audit(ctx, h.deps.DB, changes.Entry{ProfileID: &profileID, Action: "mcp.proposal." + map[bool]string{true: "approve", false: "reject"}[approve],
		EntityType: "mcp_proposed_changes", EntityID: &id, Metadata: map[string]any{"tool": pr.Tool, "mcp_client_id": pr.MCPClientID.String()}}); err != nil {
		return pr, err
	}
	if approve && r.URL.Query().Get("apply") == "true" {
		return applyProposal(ctx, h.deps.DB, h.deps.Config.MCPMaxResults, id, nil)
	}
	return pr, nil
}

func (h *handlers) approve(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	p, err := h.decide(r.Context(), r, pid, id, true)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, p)
	return nil
}

func (h *handlers) reject(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	p, err := h.decide(r.Context(), r, pid, id, false)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, p)
	return nil
}

func (h *handlers) approveBatch(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if len(in.IDs) == 0 || len(in.IDs) > 200 {
		return httpx.Validation(map[string]string{"ids": "1-200 proposal ids"})
	}
	out := httpx.List[Proposal]{Items: []Proposal{}}
	for _, id := range in.IDs {
		p, err := h.decide(r.Context(), r, pid, id, true)
		if err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
		out.Items = append(out.Items, p)
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}
