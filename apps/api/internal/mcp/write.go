package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/automation"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
	"github.com/pr0h0/finance-platform/apps/api/internal/savings"
)

// Write tools (PLAN §29). Every call: validate (shared JSON Schema + typed decode) → check scopes
// and account/period scope → dry-run inside a rolled-back DB transaction (all financial invariants
// of the owning module run) → proposal. Only a human approves (REST, ActorUser); grants with
// approval=auto (low-risk scopes only) apply immediately. Applying re-validates everything under
// the current grants and refuses stale proposals (target version changed).

const proposalTTL = 7 * 24 * time.Hour

// target is an entity a proposal changes; its version at proposal time guards against staleness.
type target struct {
	Table   string    `json:"table"`
	ID      uuid.UUID `json:"id"`
	Version int       `json:"version"`
}

type prepared struct {
	view    view
	targets []target
	summary map[string]any
	idemKey string
	apply   func(ctx context.Context, tx pgx.Tx) (any, error)
}

type prepareFn func(ctx context.Context, s *session, def *toolDef, args json.RawMessage) (*prepared, error)

var writeTools = map[string]prepareFn{
	"update_transaction_category":  prepCategory,
	"split_transaction":            prepSplit,
	"bulk_categorize_transactions": prepBulkCategory,
	"update_transaction_metadata":  prepMetadata,
	"create_planned_expense":       prepCreatePlan,
	"update_planned_expense":       prepUpdatePlan,
	"create_budget":                prepCreateBudget,
	"update_budget":                prepUpdateBudget,
	"create_savings_goal":          prepCreateGoal,
	"create_categorization_rule":   prepCreateRule,
}

func mcpMeta(s *session, extra map[string]any) map[string]any {
	m := map[string]any{"mcp_client_id": s.clientID.String()}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// dryRun applies the change and rolls it back: the preview is exactly what applying would do.
func (s *session) dryRun(ctx context.Context, p *prepared) (any, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return p.apply(ctx, tx)
}

func checkTargets(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, ts []target) error {
	for _, t := range ts {
		var v int
		err := tx.QueryRow(ctx, `SELECT version FROM `+pgx.Identifier{t.Table}.Sanitize()+` WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL FOR UPDATE`,
			t.ID, profileID).Scan(&v)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.Conflict(fmt.Sprintf("stale proposal: %s %s no longer exists", t.Table, t.ID))
		}
		if err != nil {
			return err
		}
		if v != t.Version {
			return httpx.Conflict(fmt.Sprintf("stale proposal: %s %s changed since it was proposed (version %d → %d)", t.Table, t.ID, t.Version, v))
		}
	}
	return nil
}

type proposalOut struct {
	ProposalID uuid.UUID      `json:"proposalId"`
	Status     string         `json:"status"`
	Preview    map[string]any `json:"preview"`
	Result     any            `json:"result,omitempty"`
	Meta       *meta          `json:"meta"`
}

func (s *session) write(ctx context.Context, def *toolDef, prep prepareFn, args json.RawMessage) (any, error) {
	p, err := prep(ctx, s, def, args)
	if err != nil {
		return nil, err
	}
	if p.view.Role != authz.RoleEditor && p.view.Role != authz.RoleOwner {
		return nil, toolErr("read_only_profile", "the client's user has read-only access to this profile")
	}
	after, err := s.dryRun(ctx, p)
	if err != nil {
		return nil, err
	}
	preview := map[string]any{"summary": p.summary, "after": after, "targets": p.targets}
	m := newMeta()
	if p.idemKey != "" {
		var id uuid.UUID
		var tool, status string
		var input []byte
		err := s.db.QueryRow(ctx, `SELECT id, tool, input, status FROM mcp_proposed_changes WHERE mcp_client_id = $1 AND idempotency_key = $2`,
			s.clientID, p.idemKey).Scan(&id, &tool, &input, &status)
		if err == nil {
			if tool != def.Name || !jsonEqual(input, args) {
				return nil, httpx.NewError(http.StatusUnprocessableEntity, "idempotency_key_reused", "idempotencyKey was used with a different change")
			}
			m.warn("idempotent retry: returning the existing proposal")
			return proposalOut{ProposalID: id, Status: status, Preview: preview, Meta: m}, nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	id := uuid.New()
	var idem *string
	if p.idemKey != "" {
		idem = &p.idemKey
	}
	if !p.view.Auto {
		if _, err := s.db.Exec(ctx, `INSERT INTO mcp_proposed_changes (id, profile_id, mcp_client_id, batch_id, tool, input, preview, idempotency_key, status, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`, id, p.view.P.ID, s.clientID, s.batchID, def.Name, args, preview, idem, time.Now().Add(proposalTTL)); err != nil {
			return nil, fmt.Errorf("store proposal: %w", err)
		}
		_ = changes.Audit(ctx, s.db, changes.Entry{ProfileID: &p.view.P.ID, Action: "mcp.proposal.create", EntityType: "mcp_proposed_changes", EntityID: &id,
			After: preview, Metadata: mcpMeta(s, map[string]any{"tool": def.Name})})
		m.warn("awaiting human approval in the app (Settings → AI agents → Proposals); then call apply_approved_changes")
		return proposalOut{ProposalID: id, Status: "pending", Preview: preview, Meta: m}, nil
	}
	// Pre-authorized low-risk change: apply now, keep the proposal row as the audit record.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	res, err := p.apply(ctx, tx)
	if err != nil {
		return nil, err
	}
	resJSON, _ := json.Marshal(res)
	if _, err := tx.Exec(ctx, `INSERT INTO mcp_proposed_changes (id, profile_id, mcp_client_id, batch_id, tool, input, preview, idempotency_key, status, decided_at, applied_at, result)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'applied',now(),now(),$9)`, id, p.view.P.ID, s.clientID, s.batchID, def.Name, args, preview, idem, resJSON); err != nil {
		return nil, fmt.Errorf("store applied change: %w", err)
	}
	if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &p.view.P.ID, Action: "mcp.change.auto_apply", EntityType: "mcp_proposed_changes", EntityID: &id,
		Metadata: mcpMeta(s, map[string]any{"tool": def.Name, "approval": "auto"})}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return proposalOut{ProposalID: id, Status: "applied", Preview: preview, Result: res, Meta: m}, nil
}

func jsonEqual(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ax, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	return bytes.Equal(ax, by)
}

// ---------- transactions ----------

// loadTx loads a transaction the client may see (profile granted, inside account/period scope).
func loadTx(ctx context.Context, s *session, def *toolDef, id uuid.UUID, wantProfile *uuid.UUID) (*ledger.Transaction, view, error) {
	pid, err := s.entityProfile(ctx, "transactions", id)
	if err != nil {
		return nil, view{}, err
	}
	if wantProfile != nil && *wantProfile != pid {
		return nil, view{}, httpx.Validation(map[string]string{"transactionIds": "all transactions must belong to one profile"})
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, v, err
	}
	t, err := ledger.Get(ctx, s.db, pid, id, false)
	if err != nil {
		return nil, v, err
	}
	if !txVisible(v, t) {
		return nil, v, httpx.NotFound("transaction")
	}
	if !ledger.SplitKinds(t.Kind) {
		return nil, v, httpx.Validation(map[string]string{"transactionId": t.Kind + " transactions are not categorized"})
	}
	return t, v, nil
}

// updateTx re-reads the row under lock inside tx, applies edit and stores it through the ledger
// (which validates split sums, ownership of categories/tags/merchants and records the change).
func updateTx(ctx context.Context, tx pgx.Tx, s *session, profileID, id uuid.UUID, action string, edit func(after *ledger.Transaction) error) (*ledger.Transaction, error) {
	cur, err := ledger.Get(ctx, tx, profileID, id, true)
	if err != nil {
		return nil, err
	}
	after := cur.Clone()
	if err := edit(after); err != nil {
		return nil, err
	}
	return ledger.Update(ctx, tx, cur, after, action, mcpMeta(s, nil))
}

func setCategory(after *ledger.Transaction, cat *uuid.UUID) error {
	if len(after.Splits) > 1 {
		return httpx.NewError(http.StatusUnprocessableEntity, "splits_mismatch", "transaction has several splits; use split_transaction")
	}
	sp := ledger.Split{ID: uuid.New(), CategoryID: cat, Amount: after.Amount().Abs()}
	if len(after.Splits) == 1 {
		sp.ID, sp.Description, sp.Notes = after.Splits[0].ID, after.Splits[0].Description, after.Splits[0].Notes
	}
	after.Splits = []ledger.Split{sp}
	after.CategorizationSource = "mcp"
	return nil
}

func splitsSummary(t *ledger.Transaction) []map[string]any {
	out := []map[string]any{}
	for _, sp := range t.Splits {
		out = append(out, map[string]any{"categoryId": sp.CategoryID, "amount": sp.Amount})
	}
	return out
}

func prepCategory(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		TransactionID  uuid.UUID  `json:"transactionId"`
		CategoryID     *uuid.UUID `json:"categoryId"`
		IdempotencyKey string     `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	t, v, err := loadTx(ctx, s, def, in.TransactionID, nil)
	if err != nil {
		return nil, err
	}
	if len(t.Splits) > 1 {
		return nil, httpx.NewError(http.StatusUnprocessableEntity, "splits_mismatch", "transaction has several splits; use split_transaction")
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: []target{{"transactions", t.ID, t.Version}},
		summary: map[string]any{"transactionId": t.ID, "description": t.Description, "bookingDate": t.BookingDate, "amount": t.Amount(),
			"before": splitsSummary(t), "categoryId": in.CategoryID},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			return updateTx(ctx, tx, s, v.P.ID, t.ID, "transaction.categorize", func(a *ledger.Transaction) error { return setCategory(a, in.CategoryID) })
		}}, nil
}

func prepSplit(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		TransactionID uuid.UUID `json:"transactionId"`
		Splits        []struct {
			CategoryID  *uuid.UUID  `json:"categoryId"`
			Amount      money.Money `json:"amount"`
			Description string      `json:"description"`
		} `json:"splits"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	t, v, err := loadTx(ctx, s, def, in.TransactionID, nil)
	if err != nil {
		return nil, err
	}
	splits := make([]ledger.Split, len(in.Splits))
	amts := make([]money.Money, len(in.Splits))
	for i, x := range in.Splits {
		if x.Amount.Sign() <= 0 {
			return nil, httpx.Validation(map[string]string{fmt.Sprintf("splits[%d].amount", i): "must be positive"})
		}
		splits[i] = ledger.Split{ID: uuid.New(), CategoryID: x.CategoryID, Amount: x.Amount, Description: x.Description, SortOrder: i}
		amts[i] = x.Amount
	}
	if !money.SplitsBalance(t.Amount(), amts) {
		return nil, httpx.Validation(map[string]string{"splits": "split amounts must be in " + t.Amount().Currency() + " and sum exactly to " + t.Amount().Abs().Amount()})
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: []target{{"transactions", t.ID, t.Version}},
		summary: map[string]any{"transactionId": t.ID, "description": t.Description, "amount": t.Amount(), "before": splitsSummary(t), "after": in.Splits},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			return updateTx(ctx, tx, s, v.P.ID, t.ID, "transaction.splits_replace", func(a *ledger.Transaction) error {
				a.Splits, a.CategorizationSource = splits, "mcp"
				return nil
			})
		}}, nil
}

func prepBulkCategory(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		TransactionIDs []uuid.UUID `json:"transactionIds"`
		CategoryID     uuid.UUID   `json:"categoryId"`
		IdempotencyKey string      `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	var v view
	var pid *uuid.UUID
	var ts []target
	seen := map[uuid.UUID]bool{}
	for _, id := range in.TransactionIDs {
		if seen[id] {
			return nil, httpx.Validation(map[string]string{"transactionIds": "duplicate id " + id.String()})
		}
		seen[id] = true
		t, tv, err := loadTx(ctx, s, def, id, pid)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", id, err)
		}
		if len(t.Splits) > 1 {
			return nil, httpx.NewError(http.StatusUnprocessableEntity, "splits_mismatch", "transaction "+id.String()+" has several splits; use split_transaction")
		}
		v, pid = tv, &tv.P.ID
		ts = append(ts, target{"transactions", t.ID, t.Version})
	}
	cat := in.CategoryID
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: ts,
		summary: map[string]any{"count": len(ts), "categoryId": cat},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			ids := []uuid.UUID{}
			for _, t := range ts {
				if _, err := updateTx(ctx, tx, s, v.P.ID, t.ID, "transaction.bulk_categorize", func(a *ledger.Transaction) error { return setCategory(a, &cat) }); err != nil {
					return nil, fmt.Errorf("%s: %w", t.ID, err)
				}
				ids = append(ids, t.ID)
			}
			return map[string]any{"updated": ids}, nil
		}}, nil
}

// optUUID distinguishes absent from explicit null.
type optUUID struct {
	Set   bool
	Value *uuid.UUID
}

func (o *optUUID) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		return nil
	}
	var id uuid.UUID
	if err := json.Unmarshal(b, &id); err != nil {
		return err
	}
	o.Value = &id
	return nil
}

func prepMetadata(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		TransactionID  uuid.UUID   `json:"transactionId"`
		Description    *string     `json:"description"`
		Notes          *string     `json:"notes"`
		TagIDs         []uuid.UUID `json:"tagIds"`
		MerchantID     optUUID     `json:"merchantId"`
		IdempotencyKey string      `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	pid, err := s.entityProfile(ctx, "transactions", in.TransactionID)
	if err != nil {
		return nil, err
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	t, err := ledger.Get(ctx, s.db, pid, in.TransactionID, false)
	if err != nil {
		return nil, err
	}
	if !txVisible(v, t) {
		return nil, httpx.NotFound("transaction")
	}
	if in.Description == nil && in.Notes == nil && in.TagIDs == nil && !in.MerchantID.Set {
		return nil, httpx.Validation(map[string]string{"arguments": "nothing to change"})
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: []target{{"transactions", t.ID, t.Version}},
		summary: map[string]any{"transactionId": t.ID, "before": map[string]any{"description": t.Description, "notes": t.Notes, "tagIds": t.TagIDs, "merchantId": t.MerchantID},
			"after": map[string]any{"description": in.Description, "notes": in.Notes, "tagIds": in.TagIDs, "merchantId": in.MerchantID.Value}},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			return updateTx(ctx, tx, s, pid, t.ID, "transaction.update_metadata", func(a *ledger.Transaction) error {
				if in.Description != nil {
					a.Description = strings.TrimSpace(*in.Description)
				}
				if in.Notes != nil {
					a.Notes = *in.Notes
				}
				if in.TagIDs != nil {
					a.TagIDs = in.TagIDs
				}
				if in.MerchantID.Set {
					a.MerchantID = in.MerchantID.Value
				}
				return nil
			})
		}}, nil
}

// ---------- planning ----------

func inPeriod(v view, date string) error {
	if (v.From != nil && date < v.From.Format(time.DateOnly)) || (v.To != nil && date > v.To.Format(time.DateOnly)) {
		return toolErr("period_not_granted", "date "+date+" is outside this client's granted period")
	}
	return nil
}

func prepCreatePlan(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		ProfileID      *uuid.UUID  `json:"profileId"`
		Description    string      `json:"description"`
		Amount         money.Money `json:"amount"`
		DueDate        string      `json:"dueDate"`
		RRule          *string     `json:"rrule"`
		AccountID      *uuid.UUID  `json:"accountId"`
		CategoryID     *uuid.UUID  `json:"categoryId"`
		Priority       string      `json:"priority"`
		Confidence     string      `json:"confidence"`
		IdempotencyKey string      `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if v.restricted() && !v.allowsAccount(in.AccountID) {
		return nil, toolErr("account_not_granted", "account-restricted clients must set an accountId inside their grant")
	}
	if err := inPeriod(v, in.DueDate); err != nil {
		return nil, err
	}
	if in.Amount.Sign() <= 0 {
		return nil, httpx.Validation(map[string]string{"amount": "must be positive"})
	}
	amt := in.Amount
	pin := planning.PlanInput{Kind: "expense", AccountID: in.AccountID, CategoryID: in.CategoryID, Description: in.Description, Amount: &amt,
		DueDate: in.DueDate, Priority: in.Priority, Confidence: in.Confidence, Status: "active", Notes: "Created by an AI agent (MCP)"}
	if in.RRule != nil && *in.RRule != "" {
		pin.Recurrence = &recurrence.Input{RRule: *in.RRule, StartDate: in.DueDate}
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, summary: map[string]any{"create": "planned expense", "description": in.Description, "amount": in.Amount, "dueDate": in.DueDate, "rrule": in.RRule},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			p := pin
			if pin.Recurrence != nil {
				r := *pin.Recurrence
				p.Recurrence = &r
			}
			return planning.CreatePlan(ctx, tx, v.P.ID, p)
		}}, nil
}

func planInputFrom(p planning.Plan) planning.PlanInput {
	in := planning.PlanInput{Kind: p.Kind, AccountID: p.AccountID, ToAccountID: p.ToAccountID, CategoryID: p.CategoryID, MerchantID: p.MerchantID,
		Description: p.Description, AmountMin: p.AmountMin, AmountMax: p.AmountMax, DueDate: p.DueDate, Priority: p.Priority,
		Confidence: p.Confidence, Status: p.Status, InstallmentTotal: p.InstallmentTotal, InstallmentStart: p.InstallmentStart,
		ReminderDaysBefore: p.ReminderDaysBefore, Notes: p.Notes, Version: &p.Version}
	a := p.Amount
	in.Amount = &a
	if r := p.Recurrence; r != nil {
		in.Recurrence = &recurrence.Input{RRule: r.RRule, StartDate: r.StartDate, EndDate: r.EndDate, OccurrenceCount: r.OccurrenceCount,
			Timezone: r.Timezone, BusinessDayAdjustment: r.BusinessDayAdjustment}
	}
	return in
}

func prepUpdatePlan(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		PlannedTransactionID uuid.UUID    `json:"plannedTransactionId"`
		Description          *string      `json:"description"`
		Amount               *money.Money `json:"amount"`
		DueDate              *string      `json:"dueDate"`
		Status               *string      `json:"status"`
		IdempotencyKey       string       `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	pid, err := s.entityProfile(ctx, "planned_transactions", in.PlannedTransactionID)
	if err != nil {
		return nil, err
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	cur, err := planning.GetPlan(ctx, s.db, pid, in.PlannedTransactionID)
	if err != nil {
		return nil, err
	}
	if !v.allowsAccount(cur.AccountID) {
		return nil, httpx.NotFound("planned transaction")
	}
	if in.Amount != nil && in.Amount.Sign() <= 0 {
		return nil, httpx.Validation(map[string]string{"amount": "must be positive"})
	}
	if in.DueDate != nil {
		if err := inPeriod(v, *in.DueDate); err != nil {
			return nil, err
		}
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: []target{{"planned_transactions", cur.ID, cur.Version}},
		summary: map[string]any{"plannedTransactionId": cur.ID, "before": map[string]any{"description": cur.Description, "amount": cur.Amount, "dueDate": cur.DueDate, "status": cur.Status},
			"after": map[string]any{"description": in.Description, "amount": in.Amount, "dueDate": in.DueDate, "status": in.Status}},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			now, err := planning.GetPlan(ctx, tx, pid, cur.ID)
			if err != nil {
				return nil, err
			}
			pin := planInputFrom(now)
			if in.Description != nil {
				pin.Description = *in.Description
			}
			if in.Amount != nil {
				a := *in.Amount
				pin.Amount = &a
			}
			if in.DueDate != nil {
				pin.DueDate = *in.DueDate
			}
			if in.Status != nil {
				pin.Status = *in.Status
			}
			return planning.UpdatePlan(ctx, tx, pid, now, pin)
		}}, nil
}

// ---------- budgets, goals, rules ----------

type allocIn struct {
	CategoryID *uuid.UUID  `json:"categoryId"`
	Amount     money.Money `json:"amount"`
}

func allocations(in []allocIn) []budgets.AllocationInput {
	out := make([]budgets.AllocationInput, len(in))
	for i, a := range in {
		amt := a.Amount
		out[i] = budgets.AllocationInput{CategoryID: a.CategoryID, Amount: &amt}
	}
	return out
}

func prepCreateBudget(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		ProfileID      *uuid.UUID `json:"profileId"`
		Name           string     `json:"name"`
		PeriodType     string     `json:"periodType"`
		StartDate      string     `json:"startDate"`
		Currency       string     `json:"currency"`
		Allocations    []allocIn  `json:"allocations"`
		IdempotencyKey string     `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.unrestricted("a budget"); err != nil {
		return nil, err
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, summary: map[string]any{"create": "budget", "name": in.Name, "periodType": in.PeriodType, "allocations": in.Allocations},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			return budgets.Create(ctx, tx, v.P.ID, budgets.Input{Name: in.Name, PeriodType: in.PeriodType, StartDate: in.StartDate,
				Currency: strings.ToUpper(in.Currency), RolloverPolicy: "none", Allocations: allocations(in.Allocations)})
		}}, nil
}

func budgetInputFrom(b budgets.Budget) budgets.Input {
	anchor, incl, tmpl, arch := b.PeriodAnchorDay, b.IncludePlanned, b.IsTemplate, b.IsArchived
	in := budgets.Input{Name: b.Name, PeriodType: b.PeriodType, PeriodAnchorDay: &anchor, StartDate: b.StartDate, EndDate: b.EndDate,
		Currency: b.Currency, RolloverPolicy: b.RolloverPolicy, IncludePlanned: &incl, AlertThresholds: b.AlertThresholds,
		IsTemplate: &tmpl, TemplateID: b.TemplateID, IsArchived: &arch, Version: &b.Version}
	for _, a := range b.Allocations {
		if a.BudgetPeriodID != nil {
			continue // per-period overrides are kept by the budgets module
		}
		amt := a.Amount
		in.Allocations = append(in.Allocations, budgets.AllocationInput{CategoryID: a.CategoryID, Amount: &amt, RolloverPolicy: a.RolloverPolicy})
	}
	return in
}

func prepUpdateBudget(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		BudgetID       uuid.UUID `json:"budgetId"`
		Name           *string   `json:"name"`
		Allocations    []allocIn `json:"allocations"`
		IdempotencyKey string    `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	pid, err := s.entityProfile(ctx, "budgets", in.BudgetID)
	if err != nil {
		return nil, err
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.unrestricted("a budget"); err != nil {
		return nil, err
	}
	cur, err := budgets.Get(ctx, s.db, pid, in.BudgetID)
	if err != nil {
		return nil, err
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, targets: []target{{"budgets", cur.ID, cur.Version}},
		summary: map[string]any{"budgetId": cur.ID, "before": map[string]any{"name": cur.Name, "allocations": cur.Allocations},
			"after": map[string]any{"name": in.Name, "allocations": in.Allocations}},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			now, err := budgets.Get(ctx, tx, pid, cur.ID)
			if err != nil {
				return nil, err
			}
			bin := budgetInputFrom(now)
			if in.Name != nil {
				bin.Name = *in.Name
			}
			if in.Allocations != nil {
				bin.Allocations = allocations(in.Allocations)
			}
			return budgets.Update(ctx, tx, pid, now, bin)
		}}, nil
}

func prepCreateGoal(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		ProfileID      *uuid.UUID  `json:"profileId"`
		Name           string      `json:"name"`
		TargetAmount   money.Money `json:"targetAmount"`
		TargetDate     *string     `json:"targetDate"`
		IdempotencyKey string      `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if in.TargetAmount.Sign() <= 0 {
		return nil, httpx.Validation(map[string]string{"targetAmount": "must be positive"})
	}
	return &prepared{view: v, idemKey: in.IdempotencyKey, summary: map[string]any{"create": "savings goal", "name": in.Name, "targetAmount": in.TargetAmount, "targetDate": in.TargetDate},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			t := in.TargetAmount
			return savings.Create(ctx, tx, v.P, savings.Input{Name: in.Name, TargetAmount: &t, TargetDate: in.TargetDate})
		}}, nil
}

func prepCreateRule(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (*prepared, error) {
	var in struct {
		ProfileID *uuid.UUID `json:"profileId"`
		Name      string     `json:"name"`
		Match     struct {
			Field string `json:"field"`
			Op    string `json:"op"`
			Value string `json:"value"`
		} `json:"match"`
		CategoryID     uuid.UUID `json:"categoryId"`
		IdempotencyKey string    `json:"idempotencyKey"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.unrestricted("a categorization rule"); err != nil {
		return nil, err
	}
	cat := in.CategoryID
	rin := automation.RuleInput{Name: in.Name, Conditions: []automation.Condition{{Field: in.Match.Field, Op: in.Match.Op, Value: in.Match.Value}},
		Actions: []automation.Action{{Type: "set_category", CategoryID: &cat}}}
	return &prepared{view: v, idemKey: in.IdempotencyKey, summary: map[string]any{"create": "categorization rule", "name": in.Name, "conditions": rin.Conditions, "actions": rin.Actions},
		apply: func(ctx context.Context, tx pgx.Tx) (any, error) {
			r := rin
			r.Conditions = append([]automation.Condition{}, rin.Conditions...)
			return automation.CreateRule(ctx, tx, v.P.ID, r)
		}}, nil
}

// ---------- preview_changes / apply_approved_changes ----------

func (s *session) previewChanges(ctx context.Context, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		Calls []struct {
			Tool      string          `json:"tool"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"calls"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	type res struct {
		Tool    string         `json:"tool"`
		Valid   bool           `json:"valid"`
		Errors  []string       `json:"errors"`
		Preview map[string]any `json:"preview"`
	}
	out := []res{}
	for _, c := range in.Calls {
		r := res{Tool: c.Tool, Errors: []string{}, Preview: map[string]any{}}
		prep, ok := writeTools[c.Tool]
		tdef := findTool(c.Tool)
		if !ok || tdef == nil {
			r.Errors = append(r.Errors, "not a write tool")
			out = append(out, r)
			continue
		}
		p, err := prep(ctx, s, tdef, c.Arguments)
		var after any
		if err == nil {
			after, err = s.dryRun(ctx, p)
		}
		if err != nil {
			e := errorPayload(err)["error"].(map[string]any)
			msg := fmt.Sprint(e["message"])
			if d, ok := e["details"]; ok {
				b, _ := json.Marshal(d)
				msg += " " + string(b)
			}
			r.Errors = append(r.Errors, msg)
		} else {
			r.Valid = true
			r.Preview = map[string]any{"summary": p.summary, "after": after, "requiresApproval": !p.view.Auto}
		}
		out = append(out, r)
	}
	return map[string]any{"results": out, "meta": newMeta()}, nil
}

func (s *session) applyApproved(ctx context.Context, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProposalIDs []uuid.UUID `json:"proposalIds"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	type res struct {
		ProposalID uuid.UUID `json:"proposalId"`
		Status     string    `json:"status"`
		Error      string    `json:"error,omitempty"`
	}
	out := []res{}
	for _, id := range in.ProposalIDs {
		p, err := applyProposal(ctx, s.db, s.maxRows, id, &s.clientID)
		r := res{ProposalID: id, Status: "failed"}
		switch {
		case err != nil:
			r.Error = errorPayload(err)["error"].(map[string]any)["message"].(string)
		case p.Status == "applied":
			r.Status = "applied"
		case p.Status == "pending":
			r.Status, r.Error = "not_approved", "a human has not approved this proposal yet"
		default:
			r.Error = "proposal is " + p.Status
			if p.Error != nil {
				r.Error += ": " + *p.Error
			}
		}
		out = append(out, r)
	}
	return map[string]any{"results": out, "meta": newMeta()}, nil
}
