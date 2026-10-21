package automation

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
)

var syncEntity = fin.SyncEntity[Rule, RuleInput]{
	Table: "categorization_rules",
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Rule, error) {
		return GetRule(ctx, tx, profileID, id)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *RuleInput) error {
		in.ID = &id
		_, err := CreateRule(ctx, tx, profileID, *in)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Rule, in *RuleInput) error {
		in.Version = &cur.Version // sync already checked the base version
		_, err := UpdateRule(ctx, tx, profileID, cur, *in)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Rule) error {
		return DeleteRule(ctx, tx, profileID, cur)
	},
}
