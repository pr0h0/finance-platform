package planning

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// Plan is the API shape of a planned transaction (OpenAPI Plan). One-off when Recurrence is nil.
type Plan struct {
	ID                 uuid.UUID            `json:"id"`
	ProfileID          uuid.UUID            `json:"profileId"`
	Version            int                  `json:"version"`
	ServerVersion      int64                `json:"serverVersion"`
	CreatedAt          time.Time            `json:"createdAt"`
	UpdatedAt          time.Time            `json:"updatedAt"`
	DeletedAt          *time.Time           `json:"deletedAt"`
	Kind               string               `json:"kind"`
	AccountID          *uuid.UUID           `json:"accountId"`
	ToAccountID        *uuid.UUID           `json:"toAccountId"`
	CategoryID         *uuid.UUID           `json:"categoryId"`
	MerchantID         *uuid.UUID           `json:"merchantId"`
	Description        string               `json:"description"`
	Amount             money.Money          `json:"amount"`
	AmountMin          *money.Money         `json:"amountMin"`
	AmountMax          *money.Money         `json:"amountMax"`
	DueDate            string               `json:"dueDate"`
	RecurrenceID       *uuid.UUID           `json:"recurrenceId"`
	Recurrence         *recurrence.Schedule `json:"recurrence"`
	Priority           string               `json:"priority"`
	Confidence         string               `json:"confidence"`
	Status             string               `json:"status"`
	InstallmentTotal   *int                 `json:"installmentTotal"`
	InstallmentStart   *int                 `json:"installmentStart"`
	ReminderDaysBefore *int                 `json:"reminderDaysBefore"`
	Notes              string               `json:"notes"`
	SupersedesID       *uuid.UUID           `json:"supersedesId"`
	Installments       *Installments        `json:"installments,omitempty"`
}

// Installments is the progress of an installment plan (Feature 37).
type Installments struct {
	Total       int         `json:"total"`
	Paid        int         `json:"paid"`
	Remaining   int         `json:"remaining"`
	PaidAmount  money.Money `json:"paidAmount"`
	Outstanding money.Money `json:"outstanding"`
	NextDueDate *string     `json:"nextDueDate"`
}

// PlanInput is OpenAPI PlanInput. Recurrence.startDate defaults to dueDate.
type PlanInput struct {
	ID                 *uuid.UUID        `json:"id,omitempty"`
	Kind               string            `json:"kind"`
	AccountID          *uuid.UUID        `json:"accountId"`
	ToAccountID        *uuid.UUID        `json:"toAccountId"`
	CategoryID         *uuid.UUID        `json:"categoryId"`
	MerchantID         *uuid.UUID        `json:"merchantId"`
	Description        string            `json:"description"`
	Amount             *money.Money      `json:"amount"`
	AmountMin          *money.Money      `json:"amountMin"`
	AmountMax          *money.Money      `json:"amountMax"`
	DueDate            string            `json:"dueDate"`
	Recurrence         *recurrence.Input `json:"recurrence"`
	Priority           string            `json:"priority"`
	Confidence         string            `json:"confidence"`
	Status             string            `json:"status"`
	InstallmentTotal   *int              `json:"installmentTotal"`
	InstallmentStart   *int              `json:"installmentStart"`
	ReminderDaysBefore *int              `json:"reminderDaysBefore"`
	Notes              string            `json:"notes"`
	Version            *int              `json:"version,omitempty"`
	// syncRecurrence: the schedule is its own recurrence_schedules entity (sync clients); the plan only
	// points at recurrenceID and Recurrence is a read-only copy used for validation.
	syncRecurrence bool
	recurrenceID   *uuid.UUID
}

var (
	Priorities  = []string{"essential", "high", "normal", "low", "optional"}
	Confidences = []string{"certain", "expected", "possible", "speculative"}
)

func (in *PlanInput) validate(ctx context.Context, db fin.DB, profileID uuid.UUID) error {
	v := fin.Validator{}
	v.Check(fin.OneOf(in.Kind, "income", "expense", "transfer"), "kind", "must be income, expense or transfer")
	v.Check(in.Amount != nil, "amount", "required")
	if in.Amount != nil {
		v.Check(in.Amount.Sign() > 0, "amount", "must be positive")
		for f, m := range map[string]*money.Money{"amountMin": in.AmountMin, "amountMax": in.AmountMax} {
			if m != nil {
				v.Check(m.Currency() == in.Amount.Currency(), f, "must use the plan currency")
				v.Check(m.Sign() > 0, f, "must be positive")
			}
		}
		if in.AmountMin != nil && in.AmountMax != nil && in.AmountMin.Currency() == in.AmountMax.Currency() {
			c, _ := in.AmountMin.Cmp(*in.AmountMax)
			v.Check(c <= 0, "amountMin", "must not exceed amountMax")
		}
	}
	_, err := fin.ParseDate(in.DueDate)
	v.Check(err == nil, "dueDate", "must be YYYY-MM-DD")
	if in.Priority == "" {
		in.Priority = "normal"
	}
	if in.Confidence == "" {
		in.Confidence = "expected"
	}
	if in.Status == "" {
		in.Status = "active"
	}
	v.Check(fin.OneOf(in.Priority, Priorities...), "priority", "invalid priority")
	v.Check(fin.OneOf(in.Confidence, Confidences...), "confidence", "invalid confidence")
	v.Check(fin.OneOf(in.Status, "active", "paused", "completed", "cancelled"), "status", "invalid status")
	v.Check(len(in.Description) <= 500, "description", "too long")
	v.Check(len(in.Notes) <= 5000, "notes", "too long")
	v.Check(in.ReminderDaysBefore == nil || (*in.ReminderDaysBefore >= 0 && *in.ReminderDaysBefore <= 60), "reminderDaysBefore", "must be 0..60")
	if in.Kind == "transfer" {
		v.Check(in.AccountID != nil && in.ToAccountID != nil, "toAccountId", "transfers need accountId and toAccountId")
		v.Check(in.AccountID == nil || in.ToAccountID == nil || *in.AccountID != *in.ToAccountID, "toAccountId", "must differ from accountId")
	} else {
		v.Check(in.ToAccountID == nil, "toAccountId", "only transfers have a destination account")
	}
	if in.InstallmentTotal != nil {
		v.Check(*in.InstallmentTotal > 0 && *in.InstallmentTotal <= 1200, "installmentTotal", "must be 1..1200")
		v.Check(in.Recurrence != nil || *in.InstallmentTotal == 1, "installmentTotal", "installment plans need a recurrence")
		if in.InstallmentStart == nil {
			one := 1
			in.InstallmentStart = &one
		}
		v.Check(*in.InstallmentStart >= 1 && *in.InstallmentStart <= *in.InstallmentTotal, "installmentStart", "must be 1..installmentTotal")
	} else {
		in.InstallmentStart = nil
	}
	if in.Recurrence != nil {
		if in.Recurrence.StartDate == "" {
			in.Recurrence.StartDate = in.DueDate
		}
		in.DueDate = in.Recurrence.StartDate // first due date of the series
		var re *httpx.Error
		if err := in.Recurrence.Validate("recurrence."); errors.As(err, &re) {
			for k, msg := range re.Details.(map[string]any)["fields"].(map[string]string) {
				v[k] = msg
			}
		}
	}
	for _, c := range []struct {
		f, t string
		id   *uuid.UUID
	}{{"accountId", "accounts", in.AccountID}, {"toAccountId", "accounts", in.ToAccountID}, {"categoryId", "categories", in.CategoryID}, {"merchantId", "merchants", in.MerchantID}} {
		if err := fin.CheckOwned(ctx, db, v, c.f, c.t, c.id, profileID); err != nil {
			return err
		}
	}
	return v.Err()
}

const planCols = `p.id, p.profile_id, p.version, p.server_version, p.created_at, p.updated_at, p.deleted_at, p.kind, p.account_id,
	p.to_account_id, p.category_id, p.merchant_id, p.description, p.amount, p.amount_min, p.amount_max, p.currency, p.due_date,
	p.recurrence_id, p.priority, p.confidence, p.status, p.installment_total, p.installment_start, p.reminder_days_before, p.notes,
	p.supersedes_id, r.id, r.rrule, r.start_date, r.end_date, r.occurrence_count, r.timezone, r.business_day_adjustment, r.version,
	r.server_version, r.created_at, r.updated_at`

const planFrom = ` FROM planned_transactions p LEFT JOIN recurrence_schedules r ON r.id = p.recurrence_id AND r.deleted_at IS NULL `

func scanPlan(row pgx.Row) (Plan, error) {
	var p Plan
	var amt, amin, amax pgtype.Numeric
	var cur string
	var due time.Time
	var rid *uuid.UUID
	var rrule, tz, adj *string
	var rstart, rend *time.Time
	var rcount, rver *int
	var rsv *int64
	var rcreated, rupdated *time.Time
	err := row.Scan(&p.ID, &p.ProfileID, &p.Version, &p.ServerVersion, &p.CreatedAt, &p.UpdatedAt, &p.DeletedAt, &p.Kind, &p.AccountID,
		&p.ToAccountID, &p.CategoryID, &p.MerchantID, &p.Description, &amt, &amin, &amax, &cur, &due, &p.RecurrenceID, &p.Priority,
		&p.Confidence, &p.Status, &p.InstallmentTotal, &p.InstallmentStart, &p.ReminderDaysBefore, &p.Notes, &p.SupersedesID,
		&rid, &rrule, &rstart, &rend, &rcount, &tz, &adj, &rver, &rsv, &rcreated, &rupdated)
	if err != nil {
		return p, err
	}
	cur = strings.TrimSpace(cur)
	if p.Amount, err = fin.NumericMoney(amt, cur); err != nil {
		return p, err
	}
	if p.AmountMin, err = fin.OptMoney(amin, cur); err != nil {
		return p, err
	}
	if p.AmountMax, err = fin.OptMoney(amax, cur); err != nil {
		return p, err
	}
	p.DueDate = fin.Fmt(due)
	if rid != nil {
		p.Recurrence = &recurrence.Schedule{ID: *rid, ProfileID: p.ProfileID, Version: *rver, ServerVersion: *rsv, CreatedAt: *rcreated,
			UpdatedAt: *rupdated, RRule: *rrule, StartDate: fin.Fmt(*rstart), EndDate: fin.FmtPtr(rend), OccurrenceCount: rcount,
			Timezone: *tz, BusinessDayAdjustment: *adj}
	}
	return p, nil
}

// GetPlan loads a non-deleted plan of the profile.
func GetPlan(ctx context.Context, db fin.DB, profileID, id uuid.UUID) (Plan, error) {
	p, err := scanPlan(db.QueryRow(ctx, `SELECT `+planCols+planFrom+`WHERE p.id = $1 AND p.profile_id = $2 AND p.deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, httpx.NotFound("plan")
	}
	return p, err
}

// ListPlans returns non-deleted plans ordered by id (keyset after `after`); statuses nil = all.
func ListPlans(ctx context.Context, db fin.DB, profileID uuid.UUID, after uuid.UUID, limit int, statuses []string) ([]Plan, error) {
	var st any
	if statuses != nil {
		st = statuses
	}
	rows, err := db.Query(ctx, `SELECT `+planCols+planFrom+`WHERE p.profile_id = $1 AND p.deleted_at IS NULL AND p.id > $2
		AND ($4::text[] IS NULL OR p.status = ANY($4)) ORDER BY p.id LIMIT $3`, profileID, after, limit, st)
	if err != nil {
		return nil, fmt.Errorf("list plans: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Plan, error) { return scanPlan(row) })
}

// CreatePlan validates and inserts a plan (and its schedule) and records the change.
func CreatePlan(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in PlanInput) (Plan, error) {
	if err := in.validate(ctx, tx, profileID); err != nil {
		return Plan{}, err
	}
	recID := in.recurrenceID
	if in.Recurrence != nil && !in.syncRecurrence {
		s, err := recurrence.Create(ctx, tx, profileID, *in.Recurrence)
		if err != nil {
			return Plan{}, err
		}
		recID = &s.ID
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	_, err := tx.Exec(ctx, `INSERT INTO planned_transactions (id, profile_id, kind, account_id, to_account_id, category_id, merchant_id,
		description, amount, amount_min, amount_max, currency, due_date, recurrence_id, priority, confidence, status, installment_total,
		installment_start, reminder_days_before, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
		id, profileID, in.Kind, in.AccountID, in.ToAccountID, in.CategoryID, in.MerchantID, in.Description, in.Amount.Numeric(),
		optNumeric(in.AmountMin), optNumeric(in.AmountMax), in.Amount.Currency(), in.DueDate, recID, in.Priority, in.Confidence, in.Status,
		in.InstallmentTotal, in.InstallmentStart, in.ReminderDaysBefore, in.Notes)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return Plan{}, httpx.Conflict("plan id already exists")
		}
		return Plan{}, err
	}
	return recordPlan(ctx, tx, profileID, id, nil, "plan.create")
}

// UpdatePlan applies a full input to an existing plan (version checked).
func UpdatePlan(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Plan, in PlanInput) (Plan, error) {
	if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
		return cur, err
	}
	if err := in.validate(ctx, tx, profileID); err != nil {
		return cur, err
	}
	recID := cur.RecurrenceID
	switch {
	case in.syncRecurrence:
		recID = in.recurrenceID
	case in.Recurrence == nil && cur.Recurrence != nil:
		if err := recurrence.Delete(ctx, tx, profileID, *cur.Recurrence); err != nil {
			return cur, err
		}
		recID = nil
	case in.Recurrence != nil && cur.Recurrence == nil:
		in.Recurrence.ID = nil
		s, err := recurrence.Create(ctx, tx, profileID, *in.Recurrence)
		if err != nil {
			return cur, err
		}
		recID = &s.ID
	case in.Recurrence != nil:
		if _, err := recurrence.Update(ctx, tx, profileID, *cur.Recurrence, *in.Recurrence, false); err != nil {
			return cur, err
		}
	}
	_, err := tx.Exec(ctx, `UPDATE planned_transactions SET kind=$3, account_id=$4, to_account_id=$5, category_id=$6, merchant_id=$7,
		description=$8, amount=$9, amount_min=$10, amount_max=$11, currency=$12, due_date=$13, recurrence_id=$14, priority=$15,
		confidence=$16, status=$17, installment_total=$18, installment_start=$19, reminder_days_before=$20, notes=$21, version = version + 1
		WHERE id = $1 AND profile_id = $2`,
		cur.ID, profileID, in.Kind, in.AccountID, in.ToAccountID, in.CategoryID, in.MerchantID, in.Description, in.Amount.Numeric(),
		optNumeric(in.AmountMin), optNumeric(in.AmountMax), in.Amount.Currency(), in.DueDate, recID, in.Priority, in.Confidence, in.Status,
		in.InstallmentTotal, in.InstallmentStart, in.ReminderDaysBefore, in.Notes)
	if err != nil {
		return cur, err
	}
	return recordPlan(ctx, tx, profileID, cur.ID, cur, "plan.update")
}

// DeletePlan tombstones a plan and its schedule.
func DeletePlan(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Plan) error {
	if cur.Recurrence != nil {
		if err := recurrence.Delete(ctx, tx, profileID, *cur.Recurrence); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE planned_transactions SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "planned_transactions", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "plan.delete"})
	return err
}

func recordPlan(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before any, action string) (Plan, error) {
	p, err := GetPlan(ctx, tx, profileID, id)
	if err != nil {
		return p, err
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "planned_transactions", EntityID: id, Op: changes.OpUpsert, Data: p, Before: before, Action: action})
	p.ServerVersion = v
	return p, err
}

func optNumeric(m *money.Money) any {
	if m == nil {
		return nil
	}
	return m.Numeric()
}

// ToInput converts a plan to its input shape (for patches).
func (p Plan) ToInput() PlanInput {
	in := PlanInput{Kind: p.Kind, AccountID: p.AccountID, ToAccountID: p.ToAccountID, CategoryID: p.CategoryID, MerchantID: p.MerchantID,
		Description: p.Description, Amount: &p.Amount, AmountMin: p.AmountMin, AmountMax: p.AmountMax, DueDate: p.DueDate, Priority: p.Priority,
		Confidence: p.Confidence, Status: p.Status, InstallmentTotal: p.InstallmentTotal, InstallmentStart: p.InstallmentStart,
		ReminderDaysBefore: p.ReminderDaysBefore, Notes: p.Notes}
	if p.Recurrence != nil {
		in.Recurrence = &recurrence.Input{RRule: p.Recurrence.RRule, StartDate: p.Recurrence.StartDate, EndDate: p.Recurrence.EndDate,
			OccurrenceCount: p.Recurrence.OccurrenceCount, Timezone: p.Recurrence.Timezone, BusinessDayAdjustment: p.Recurrence.BusinessDayAdjustment}
	}
	return in
}
