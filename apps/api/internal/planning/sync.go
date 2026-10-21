package planning

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// planSync is the client row of planned_transactions: the schedule is referenced by recurrenceId
// (pushed separately as recurrence_schedules), never embedded.
type planSync struct {
	PlanInput
	RecurrenceID *uuid.UUID `json:"recurrenceId"`
}

func (in *planSync) input(ctx context.Context, tx pgx.Tx, profileID uuid.UUID) (PlanInput, error) {
	pi := in.PlanInput
	pi.Recurrence, pi.syncRecurrence, pi.recurrenceID = nil, true, in.RecurrenceID
	if in.RecurrenceID != nil {
		s, err := recurrence.Get(ctx, tx, profileID, *in.RecurrenceID)
		if err != nil {
			return pi, httpx.Validation(map[string]string{"recurrenceId": "unknown recurrence"})
		}
		pi.Recurrence = &recurrence.Input{RRule: s.RRule, StartDate: s.StartDate, EndDate: s.EndDate, OccurrenceCount: s.OccurrenceCount,
			Timezone: s.Timezone, BusinessDayAdjustment: s.BusinessDayAdjustment}
	}
	return pi, nil
}

var syncPlans = fin.SyncEntity[Plan, planSync]{
	Table:       "planned_transactions",
	MoneyFields: []string{"amount", "amountMin", "amountMax", "kind", "accountId", "toAccountId"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Plan, error) {
		return GetPlan(ctx, tx, profileID, id)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *planSync) error {
		pi, err := in.input(ctx, tx, profileID)
		if err != nil {
			return err
		}
		pi.ID = &id
		_, err = CreatePlan(ctx, tx, profileID, pi)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Plan, in *planSync) error {
		pi, err := in.input(ctx, tx, profileID)
		if err != nil {
			return err
		}
		pi.Version = &cur.Version // sync already checked the base version
		_, err = UpdatePlan(ctx, tx, profileID, cur, pi)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Plan) error {
		cur.Recurrence = nil // the client tombstones its schedule row itself
		return DeletePlan(ctx, tx, profileID, cur)
	},
}

// occurrenceSync is the client row of planned_occurrences.
type occurrenceSync struct {
	OccurrenceUpdate
	PlannedTransactionID uuid.UUID `json:"plannedTransactionId"`
	OccurrenceDate       string    `json:"occurrenceDate"`
}

var syncOccurrences = fin.SyncEntity[OccurrenceRow, occurrenceSync]{
	Table:       "planned_occurrences",
	MoneyFields: []string{"amountOverride", "status", "matchedTransactionId"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (OccurrenceRow, error) {
		var planID uuid.UUID
		var day time.Time
		if err := tx.QueryRow(ctx, `SELECT planned_transaction_id, occurrence_date FROM planned_occurrences
			WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID).Scan(&planID, &day); err != nil {
			return OccurrenceRow{}, err
		}
		return getOccurrenceRow(ctx, tx, profileID, planID, day, false)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *occurrenceSync) error {
		p, err := GetPlan(ctx, tx, profileID, in.PlannedTransactionID)
		if err != nil {
			return httpx.Validation(map[string]string{"plannedTransactionId": "unknown plan"})
		}
		day, err := fin.ParseDate(in.OccurrenceDate)
		if err != nil {
			return httpx.Validation(map[string]string{"occurrenceDate": "must be YYYY-MM-DD"})
		}
		in.id = &id
		_, err = SetOccurrence(ctx, tx, profileID, p, day, in.OccurrenceUpdate)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur OccurrenceRow, in *occurrenceSync) error {
		p, err := GetPlan(ctx, tx, profileID, cur.PlannedTransactionID)
		if err != nil {
			return err
		}
		_, err = SetOccurrence(ctx, tx, profileID, p, fin.MustDate(cur.OccurrenceDate), in.OccurrenceUpdate)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur OccurrenceRow) error {
		if _, err := tx.Exec(ctx, `UPDATE planned_occurrences SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`,
			cur.ID, profileID); err != nil {
			return err
		}
		_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "planned_occurrences", EntityID: cur.ID,
			Op: changes.OpDelete, Before: cur, Action: "plan_occurrence.delete"})
		return err
	},
}

func today(ctx context.Context, tx pgx.Tx, profileID uuid.UUID) (fin.Profile, error) {
	return fin.LoadProfile(ctx, tx, profileID)
}

var syncSubscriptions = fin.SyncEntity[Subscription, SubscriptionInput]{
	Table: "subscriptions",
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Subscription, error) {
		p, err := today(ctx, tx, profileID)
		if err != nil {
			return Subscription{}, err
		}
		return GetSubscription(ctx, tx, profileID, id, p.Today)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *SubscriptionInput) error {
		p, err := today(ctx, tx, profileID)
		if err != nil {
			return err
		}
		in.ID, in.Amount = &id, nil // the price lives on the linked plan, pushed as its own entity
		_, err = CreateSubscription(ctx, tx, profileID, *in, p.Today)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Subscription, in *SubscriptionInput) error {
		p, err := today(ctx, tx, profileID)
		if err != nil {
			return err
		}
		// The plan's account, category and schedule are edited through the plan entity itself.
		in.Version, in.Amount, in.RRule, in.AccountID, in.CategoryID = &cur.Version, nil, nil, cur.AccountID, cur.CategoryID
		_, err = UpdateSubscription(ctx, tx, profileID, cur, *in, p.Today)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Subscription) error {
		return DeleteSubscription(ctx, tx, profileID, cur)
	},
}
