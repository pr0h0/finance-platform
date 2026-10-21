// Package audit: Audit log queries.
//
// Owned routes under /api/v1: /audit
// See docs/api/openapi.yaml for the contract. Writing is done by internal/changes.
package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Entry is the OpenAPI AuditEntry.
type Entry struct {
	ID         int64           `json:"id"`
	OccurredAt time.Time       `json:"occurredAt"`
	ActorType  string          `json:"actorType"`
	ActorID    *uuid.UUID      `json:"actorId"`
	ProfileID  *uuid.UUID      `json:"profileId"`
	Action     string          `json:"action"`
	EntityType *string         `json:"entityType"`
	EntityID   *uuid.UUID      `json:"entityId"`
	Before     json.RawMessage `json:"before"`
	After      json.RawMessage `json:"after"`
	RequestID  *string         `json:"requestId"`
}

// Filter narrows a query; zero values mean "any". ProfileID nil = server-wide (admin only).
type Filter struct {
	ProfileID  *uuid.UUID
	EntityType string
	EntityID   *uuid.UUID
	Action     string
	From, To   *time.Time // dates, inclusive, UTC days
}

// Query returns entries newest first with id-based cursor pagination.
func Query(ctx context.Context, db *pgxpool.Pool, f Filter, page httpx.Page) (httpx.List[Entry], error) {
	var before *int64
	if page.Cursor != "" {
		var c struct {
			ID int64 `json:"i"`
		}
		if err := httpx.DecodeCursor(page.Cursor, &c); err != nil {
			return httpx.List[Entry]{}, err
		}
		before = &c.ID
	}
	var to *time.Time
	if f.To != nil {
		t := f.To.AddDate(0, 0, 1)
		to = &t
	}
	rows, err := db.Query(ctx, `SELECT id, occurred_at, actor_type, actor_id, profile_id, action, entity_type, entity_id,
		COALESCE(before, 'null'), COALESCE(after, 'null'), request_id FROM audit_log
		WHERE ($1::uuid IS NULL OR profile_id = $1) AND ($2 = '' OR entity_type = $2) AND ($3::uuid IS NULL OR entity_id = $3)
		  AND ($4 = '' OR action = $4) AND ($5::timestamptz IS NULL OR occurred_at >= $5) AND ($6::timestamptz IS NULL OR occurred_at < $6)
		  AND ($7::bigint IS NULL OR id < $7)
		ORDER BY id DESC LIMIT $8`, f.ProfileID, f.EntityType, f.EntityID, f.Action, f.From, to, before, page.Limit+1)
	if err != nil {
		return httpx.List[Entry]{}, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Entry, error) {
		var e Entry
		err := row.Scan(&e.ID, &e.OccurredAt, &e.ActorType, &e.ActorID, &e.ProfileID, &e.Action, &e.EntityType, &e.EntityID,
			&e.Before, &e.After, &e.RequestID)
		return e, err
	})
	if err != nil {
		return httpx.List[Entry]{}, err
	}
	out := httpx.List[Entry]{Items: items}
	if len(items) > page.Limit {
		out.Items = items[:page.Limit]
		out.NextCursor = httpx.EncodeCursor(struct {
			ID int64 `json:"i"`
		}{out.Items[page.Limit-1].ID})
	}
	if out.Items == nil {
		out.Items = []Entry{}
	}
	return out, nil
}

// ParseFilter reads entityType, entityId, action, from, to.
func ParseFilter(r *http.Request) (Filter, error) {
	q := r.URL.Query()
	f := Filter{EntityType: q.Get("entityType"), Action: q.Get("action")}
	bad := map[string]string{}
	if s := q.Get("entityId"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			bad["entityId"] = "invalid uuid"
		}
		f.EntityID = &id
	}
	for _, k := range []string{"from", "to"} {
		if s := q.Get(k); s != "" {
			t, err := time.Parse(time.DateOnly, s)
			if err != nil {
				bad[k] = "YYYY-MM-DD"
			}
			if k == "from" {
				f.From = &t
			} else {
				f.To = &t
			}
		}
	}
	if len(bad) > 0 {
		return f, httpx.Validation(bad)
	}
	return f, nil
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	r.Get("/audit", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		f, err := ParseFilter(r)
		if err != nil {
			return err
		}
		f.ProfileID = &profileID
		page, err := httpx.ParsePage(r, 50, 500)
		if err != nil {
			return err
		}
		out, err := Query(r.Context(), deps.DB, f, page)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
}
