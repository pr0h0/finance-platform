package savings

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
)

func syncProfile(ctx context.Context, tx pgx.Tx, profileID uuid.UUID) (fin.Profile, error) {
	return fin.LoadProfile(ctx, tx, profileID)
}

var syncGoals = fin.SyncEntity[Goal, Input]{
	Table:       "savings_goals",
	MoneyFields: []string{"targetAmount", "startingAmount"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Goal, error) {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return Goal{}, err
		}
		return Get(ctx, tx, p, id)
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *Input) error {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return err
		}
		in.ID = &id
		_, err = Create(ctx, tx, p, *in)
		return err
	},
	Update: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Goal, in *Input) error {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return err
		}
		in.Version = &cur.Version // sync already checked the base version
		_, err = Update(ctx, tx, p, cur, *in)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Goal) error {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return err
		}
		return Delete(ctx, tx, p, cur)
	},
}

// contributionSync is the client row: ContributionInput plus the goal it belongs to.
type contributionSync struct {
	ContributionInput
	GoalID uuid.UUID `json:"goalId"`
}

var syncContributions = fin.SyncEntity[Contribution, contributionSync]{
	Table:       "savings_contributions",
	MoneyFields: []string{"amount"},
	Get: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (Contribution, error) {
		c, err := scanContrib(tx.QueryRow(ctx, `SELECT `+contribCols+` FROM savings_contributions WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID))
		return c, err
	},
	Create: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *contributionSync) error {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return err
		}
		g, err := Get(ctx, tx, p, in.GoalID)
		if err != nil {
			return err
		}
		in.ID = &id
		_, err = AddContribution(ctx, tx, p, g, in.ContributionInput)
		return err
	},
	Update: fin.NotEditable[Contribution, contributionSync]("a contribution"),
	Delete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Contribution) error {
		p, err := syncProfile(ctx, tx, profileID)
		if err != nil {
			return err
		}
		return DeleteContribution(ctx, tx, p, cur.GoalID, cur.ID)
	},
}
