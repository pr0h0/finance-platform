package fin

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// SyncEntity adapts a module's service functions (the same validation as its REST handlers) to a sync
// push entity. The client sends its stored row; it is decoded leniently into the module's input type I,
// so read-only fields are ignored. Get loads a non-deleted row (httpx 404 otherwise); tombstoned rows
// are reported to sync as a minimal {id, version, deletedAt} snapshot.
type SyncEntity[S any, I any] struct {
	Table       string
	MoneyFields []string
	Get         func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (S, error)
	Create      func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in *I) error
	Update      func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur S, in *I) error
	Delete      func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur S) error
}

func (e SyncEntity[S, I]) Register() {
	sync.RegisterEntity(e.Table, sync.Entity{
		MoneyFields: e.MoneyFields,
		Load: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (any, bool, error) {
			var version int
			var deleted *time.Time
			if err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT version, deleted_at FROM %s WHERE id = $1 AND profile_id = $2`,
				pgx.Identifier{e.Table}.Sanitize()), id, profileID).Scan(&version, &deleted); err != nil {
				return nil, false, err
			}
			if deleted != nil {
				return map[string]any{"id": id, "version": version, "deletedAt": deleted}, true, nil
			}
			s, err := e.Get(ctx, tx, profileID, id)
			return s, false, err
		},
		Upsert: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, _ *uuid.UUID) error {
			in := new(I)
			if err := json.Unmarshal(data, in); err != nil {
				return httpx.Validation(map[string]string{"data": err.Error()})
			}
			if create {
				return e.Create(ctx, tx, profileID, id, in)
			}
			cur, err := e.Get(ctx, tx, profileID, id)
			if err != nil {
				return err
			}
			return e.Update(ctx, tx, profileID, cur, in)
		},
		Delete: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, _ *uuid.UUID) error {
			cur, err := e.Get(ctx, tx, profileID, id)
			if err != nil {
				return err
			}
			return e.Delete(ctx, tx, profileID, cur)
		},
	})
}

// NotEditable is the Update of an append-only entity.
func NotEditable[S any, I any](what string) func(context.Context, pgx.Tx, uuid.UUID, S, *I) error {
	return func(context.Context, pgx.Tx, uuid.UUID, S, *I) error {
		return httpx.Unprocessable(what + " cannot be edited; delete it and add a new one")
	}
}
