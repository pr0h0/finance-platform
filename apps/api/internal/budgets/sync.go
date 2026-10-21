package budgets

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Sync clients store budgets and their allocations as separate rows (budget_allocations is its own
// entity there), so a pushed budget never carries allocations and never replaces them.
var syncBudgets = fin.SyncEntity[Budget, Input]{
	Table:       "budgets",
	MoneyFields: []string{"currency", "periodType", "startDate", "endDate"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Budget, error) {
		return Get(ctx, tx, profileID, id)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *Input) error {
		in.ID, in.Allocations = &id, nil
		_, err := Create(ctx, tx, profileID, *in)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Budget, in *Input) error {
		in.Version, in.Allocations, in.keepAllocations = &cur.Version, nil, true
		_, err := Update(ctx, tx, profileID, cur, *in)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Budget) error {
		return Delete(ctx, tx, profileID, cur)
	},
}

// AllocationRow is the sync (client table) shape of a budget_allocations row.
type AllocationRow struct {
	ID             uuid.UUID   `json:"id"`
	ProfileID      uuid.UUID   `json:"profileId"`
	Version        int         `json:"version"`
	ServerVersion  int64       `json:"serverVersion"`
	CreatedAt      time.Time   `json:"createdAt"`
	UpdatedAt      time.Time   `json:"updatedAt"`
	DeletedAt      *time.Time  `json:"deletedAt"`
	BudgetID       uuid.UUID   `json:"budgetId"`
	BudgetPeriodID *uuid.UUID  `json:"budgetPeriodId"`
	CategoryID     *uuid.UUID  `json:"categoryId"`
	Amount         money.Money `json:"amount"`
	RolloverAmount money.Money `json:"rolloverAmount"`
	RolloverPolicy *string     `json:"rolloverPolicy"`
}

func getAllocation(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (AllocationRow, error) {
	var a AllocationRow
	var amt, roll pgtype.Numeric
	var cur string
	err := tx.QueryRow(ctx, `SELECT id, profile_id, version, server_version, created_at, updated_at, deleted_at, budget_id,
		budget_period_id, category_id, amount, currency, rollover_amount, rollover_policy
		FROM budget_allocations WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID).
		Scan(&a.ID, &a.ProfileID, &a.Version, &a.ServerVersion, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt, &a.BudgetID,
			&a.BudgetPeriodID, &a.CategoryID, &amt, &cur, &roll, &a.RolloverPolicy)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, httpx.NotFound("allocation")
	}
	if err != nil {
		return a, err
	}
	if a.Amount, err = fin.NumericMoney(amt, cur); err != nil {
		return a, err
	}
	a.RolloverAmount, err = fin.NumericMoney(roll, cur)
	return a, err
}

func writeAllocation(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *AllocationRow, cur *AllocationRow) error {
	if cur != nil && cur.BudgetID != in.BudgetID {
		return httpx.Validation(map[string]string{"budgetId": "cannot change"})
	}
	b, err := Get(ctx, tx, profileID, in.BudgetID)
	if err != nil {
		return httpx.Validation(map[string]string{"budgetId": "unknown budget"})
	}
	v := fin.Validator{}
	v.Check(in.Amount.Currency() == b.Currency && in.Amount.Sign() >= 0, "amount", "non-negative, in the budget currency")
	v.Check(in.RolloverPolicy == nil || fin.OneOf(*in.RolloverPolicy, rolloverPolicies...), "rolloverPolicy", "invalid rollover policy")
	v.Check(in.BudgetPeriodID == nil, "budgetPeriodId", "period allocations are server-managed")
	if err := fin.CheckOwned(ctx, tx, v, "categoryId", "categories", in.CategoryID, profileID); err != nil {
		return err
	}
	if err := v.Err(); err != nil {
		return err
	}
	if cur == nil {
		_, err = tx.Exec(ctx, `INSERT INTO budget_allocations (id, profile_id, budget_id, category_id, amount, currency, rollover_policy)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, profileID, in.BudgetID, in.CategoryID, in.Amount.Numeric(), in.Amount.Currency(), in.RolloverPolicy)
	} else {
		_, err = tx.Exec(ctx, `UPDATE budget_allocations SET category_id=$3, amount=$4, currency=$5, rollover_policy=$6, version = version + 1
			WHERE id = $1 AND profile_id = $2`, id, profileID, in.CategoryID, in.Amount.Numeric(), in.Amount.Currency(), in.RolloverPolicy)
	}
	if err != nil {
		return err
	}
	return recordAllocation(ctx, tx, profileID, id, changes.OpUpsert, cur)
}

func recordAllocation(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, op changes.Op, before *AllocationRow) error {
	var data any
	if op == changes.OpUpsert {
		a, err := getAllocation(ctx, tx, profileID, id)
		if err != nil {
			return err
		}
		data = a
	}
	var b any
	if before != nil {
		b = before
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "budget_allocations", EntityID: id, Op: op,
		Data: data, Before: b, Action: "budget_allocation." + string(op)})
	return err
}

var syncAllocations = fin.SyncEntity[AllocationRow, AllocationRow]{
	Table:       "budget_allocations",
	MoneyFields: []string{"amount", "budgetId", "categoryId"},
	Get:         getAllocation,
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *AllocationRow) error {
		return writeAllocation(ctx, tx, profileID, id, in, nil)
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur AllocationRow, in *AllocationRow) error {
		return writeAllocation(ctx, tx, profileID, cur.ID, in, &cur)
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur AllocationRow) error {
		if _, err := tx.Exec(ctx, `UPDATE budget_allocations SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`,
			cur.ID, profileID); err != nil {
			return err
		}
		return recordAllocation(ctx, tx, profileID, cur.ID, changes.OpDelete, &cur)
	},
}
