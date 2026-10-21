package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// Meta is the Syncable part of every entity.
type Meta struct {
	ID            uuid.UUID  `json:"id"`
	ProfileID     uuid.UUID  `json:"profileId"`
	Version       int        `json:"version"`
	ServerVersion int64      `json:"serverVersion"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	DeletedAt     *time.Time `json:"deletedAt"`
}

const MetaCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at`

func (m *Meta) Dest() []any {
	return []any{&m.ID, &m.ProfileID, &m.Version, &m.ServerVersion, &m.CreatedAt, &m.UpdatedAt, &m.DeletedAt}
}

// Entity describes a simple profile-scoped syncable table with CRUD routes. Scan reads MetaCols+Cols.
// Table must have the Syncable columns (version, server_version, deleted_at).
type Entity[T any] struct {
	Table, Path, Name, Cols, Order string
	Scan                           func(row pgx.Row) (*T, error)
	// Write validates in and inserts (cur == nil) or updates (cur != nil, version already checked) the row.
	Write   func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, id uuid.UUID, in *T, cur *T) error
	GetMeta func(*T) *Meta
	// BeforeDelete may refuse a delete (e.g. a category that still has subcategories). Optional.
	BeforeDelete func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur *T) error
	// New returns a create input pre-filled with defaults (fields absent from the JSON keep them). Optional.
	New func() *T
	// ListWhere adds an SQL condition to the list query from the query string; its placeholders start
	// at $4 and bind args. Optional.
	ListWhere func(q url.Values) (cond string, args []any)
	// Decorate fills computed, read-only fields (e.g. balances) on every returned item. Optional.
	Decorate func(ctx context.Context, db DB, profileID uuid.UUID, items []*T) error
}

func (e Entity[T]) decorate(ctx context.Context, db DB, profileID uuid.UUID, items ...*T) error {
	if e.Decorate == nil || len(items) == 0 {
		return nil
	}
	return e.Decorate(ctx, db, profileID, items)
}

func (e Entity[T]) Get(ctx context.Context, db DB, profileID, id uuid.UUID, lock bool) (*T, error) {
	q := `SELECT ` + MetaCols + `, ` + e.Cols + ` FROM ` + e.Table + ` WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`
	if lock {
		q += ` FOR UPDATE`
	}
	v, err := e.Scan(db.QueryRow(ctx, q, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound(e.Name)
	}
	return v, err
}

func (e Entity[T]) Record(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, op changes.Op, before *T, verb string) (*T, error) {
	after, err := e.Scan(tx.QueryRow(ctx, `SELECT `+MetaCols+`, `+e.Cols+` FROM `+e.Table+` WHERE id = $1`, id))
	if err != nil {
		return nil, err
	}
	var data, b any = after, nil
	if op == changes.OpDelete {
		data = nil
	}
	if before != nil {
		b = before
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: e.Table, EntityID: id, Op: op, Data: data,
		Before: b, Action: e.Name + "." + verb})
	if err != nil {
		return nil, err
	}
	e.GetMeta(after).ServerVersion = v
	return after, nil
}

// Mount registers list/create/get/patch/delete for the entity.
func (e Entity[T]) Mount(r chi.Router, db *pgxpool.Pool) {
	r.Get(e.Path, httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 200, 500)
		if err != nil {
			return err
		}
		var c struct {
			N int `json:"n"`
		}
		if err := httpx.DecodeCursor(page.Cursor, &c); err != nil {
			return err
		}
		where, args := "", []any{profileID, page.Limit + 1, c.N}
		if e.ListWhere != nil {
			if cond, extra := e.ListWhere(r.URL.Query()); cond != "" {
				where, args = " AND "+cond, append(args, extra...)
			}
		}
		rows, err := db.Query(r.Context(), `SELECT `+MetaCols+`, `+e.Cols+` FROM `+e.Table+`
			WHERE profile_id = $1 AND deleted_at IS NULL`+where+` ORDER BY `+e.Order+` LIMIT $2 OFFSET $3`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[*T]{Items: []*T{}}
		for rows.Next() {
			v, err := e.Scan(rows)
			if err != nil {
				return err
			}
			out.Items = append(out.Items, v)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(out.Items) > page.Limit {
			out.Items = out.Items[:page.Limit]
			out.NextCursor = httpx.EncodeCursor(struct {
				N int `json:"n"`
			}{c.N + page.Limit})
		}
		if err := e.decorate(r.Context(), db, profileID, out.Items...); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.With(httpx.Idempotent(db)).Post(e.Path, httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		in := new(T)
		if e.New != nil {
			in = e.New()
		}
		if err := httpx.DecodeJSON(r, in); err != nil {
			return err
		}
		id := e.GetMeta(in).ID
		if id == uuid.Nil {
			id = uuid.New()
		}
		var out *T
		err = InTx(r.Context(), db, func(tx pgx.Tx) error {
			if err := e.Write(r.Context(), tx, profileID, id, in, nil); err != nil {
				return err
			}
			out, err = e.Record(r.Context(), tx, profileID, id, changes.OpUpsert, nil, "create")
			return err
		})
		if err != nil {
			return err
		}
		if err := e.decorate(r.Context(), db, profileID, out); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, out)
		return nil
	}))
	r.Get(e.Path+"/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		id, err := IDParam(r, "id", e.Name)
		if err != nil {
			return err
		}
		v, err := e.Get(r.Context(), db, profileID, id, false)
		if err != nil {
			return err
		}
		if err := e.decorate(r.Context(), db, profileID, v); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, v)
		return nil
	}))
	r.Patch(e.Path+"/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := IDParam(r, "id", e.Name)
		if err != nil {
			return err
		}
		var out *T
		err = InTx(r.Context(), db, func(tx pgx.Tx) error {
			cur, err := e.Get(r.Context(), tx, profileID, id, true)
			if err != nil {
				return err
			}
			b, _ := json.Marshal(cur)
			in := new(T)
			_ = json.Unmarshal(b, in)
			keys, err := DecodePatch(r, in)
			if err != nil {
				return err
			}
			cm, im := e.GetMeta(cur), e.GetMeta(in)
			if !keys["version"] {
				return httpx.Validation(map[string]string{"version": "required"})
			}
			if im.Version != cm.Version {
				return VersionConflict(cm.Version)
			}
			*im = *cm // id/profile/timestamps are not client-editable
			if err := e.Write(r.Context(), tx, profileID, id, in, cur); err != nil {
				return err
			}
			out, err = e.Record(r.Context(), tx, profileID, id, changes.OpUpsert, cur, "update")
			return err
		})
		if err != nil {
			return err
		}
		if err := e.decorate(r.Context(), db, profileID, out); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.Delete(e.Path+"/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := IDParam(r, "id", e.Name)
		if err != nil {
			return err
		}
		err = InTx(r.Context(), db, func(tx pgx.Tx) error {
			cur, err := e.Get(r.Context(), tx, profileID, id, true)
			if err != nil {
				return err
			}
			if e.BeforeDelete != nil {
				if err := e.BeforeDelete(r.Context(), tx, profileID, cur); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(r.Context(), `UPDATE `+e.Table+` SET deleted_at = now(), version = version + 1 WHERE id = $1`, id); err != nil {
				return err
			}
			_, err = e.Record(r.Context(), tx, profileID, id, changes.OpDelete, cur, "delete")
			return err
		})
		if err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}

// Sync is the sync push adapter for the entity (docs/architecture/sync-protocol.md): the client's full
// API-shaped object goes through the same Write validation as REST; read-only fields are ignored.
func (e Entity[T]) Sync(moneyFields ...string) sync.Entity {
	decode := func(id, profileID uuid.UUID, data json.RawMessage) (*T, error) {
		in := new(T)
		if e.New != nil {
			in = e.New()
		}
		if err := json.Unmarshal(data, in); err != nil {
			return nil, httpx.Validation(map[string]string{"data": err.Error()})
		}
		*e.GetMeta(in) = Meta{ID: id, ProfileID: profileID}
		return in, nil
	}
	return sync.Entity{
		MoneyFields: moneyFields,
		Load: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (any, bool, error) {
			v, err := e.Scan(tx.QueryRow(ctx, `SELECT `+MetaCols+`, `+e.Cols+` FROM `+e.Table+` WHERE id = $1 AND profile_id = $2`, id, profileID))
			if err != nil {
				return nil, false, err
			}
			return v, e.GetMeta(v).DeletedAt != nil, nil
		},
		Upsert: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, _ *uuid.UUID) error {
			in, err := decode(id, profileID, data)
			if err != nil {
				return err
			}
			var cur *T
			verb := "create"
			if !create {
				if cur, err = e.Get(ctx, tx, profileID, id, true); err != nil {
					return err
				}
				*e.GetMeta(in) = *e.GetMeta(cur)
				verb = "update"
			}
			if err := e.Write(ctx, tx, profileID, id, in, cur); err != nil {
				return err
			}
			_, err = e.Record(ctx, tx, profileID, id, changes.OpUpsert, cur, verb)
			return err
		},
		Delete: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, _ *uuid.UUID) error {
			cur, err := e.Get(ctx, tx, profileID, id, true)
			if err != nil {
				return err
			}
			if e.BeforeDelete != nil {
				if err := e.BeforeDelete(ctx, tx, profileID, cur); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE `+e.Table+` SET deleted_at = now(), version = version + 1 WHERE id = $1`, id); err != nil {
				return err
			}
			_, err = e.Record(ctx, tx, profileID, id, changes.OpDelete, cur, "delete")
			return err
		},
	}
}

// InTx runs fn in a transaction and commits when it returns nil. Write the response after InTx returns.
func InTx(ctx context.Context, db *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
