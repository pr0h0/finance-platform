package recurrence

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
)

var syncEntity = fin.SyncEntity[Schedule, Input]{
	Table:       "recurrence_schedules",
	MoneyFields: []string{"rrule", "startDate", "endDate", "occurrenceCount"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Schedule, error) {
		return Get(ctx, tx, profileID, id)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *Input) error {
		in.ID = &id
		_, err := Create(ctx, tx, profileID, *in)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Schedule, in *Input) error {
		_, err := Update(ctx, tx, profileID, cur, *in, false)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Schedule) error {
		return Delete(ctx, tx, profileID, cur)
	},
}
