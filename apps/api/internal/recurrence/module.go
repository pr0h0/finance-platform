// Package recurrence: Recurrence schedules and expansion (rules in rrule.go).
//
// Owned routes under /api/v1: /recurrences
// See docs/api/openapi.yaml for the contract.
package recurrence

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Schedule is the API shape (OpenAPI Recurrence).
type Schedule struct {
	ID                    uuid.UUID  `json:"id"`
	ProfileID             uuid.UUID  `json:"profileId"`
	Version               int        `json:"version"`
	ServerVersion         int64      `json:"serverVersion"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	DeletedAt             *time.Time `json:"deletedAt"`
	RRule                 string     `json:"rrule"`
	StartDate             string     `json:"startDate"`
	EndDate               *string    `json:"endDate"`
	OccurrenceCount       *int       `json:"occurrenceCount"`
	Timezone              string     `json:"timezone"`
	BusinessDayAdjustment string     `json:"businessDayAdjustment"`
}

// Input is OpenAPI RecurrenceInput.
type Input struct {
	ID                    *uuid.UUID `json:"id,omitempty"`
	RRule                 string     `json:"rrule"`
	StartDate             string     `json:"startDate"`
	EndDate               *string    `json:"endDate"`
	OccurrenceCount       *int       `json:"occurrenceCount"`
	Timezone              string     `json:"timezone"`
	BusinessDayAdjustment string     `json:"businessDayAdjustment"`
	Version               *int       `json:"version,omitempty"`
}

// Spec converts the API shape to an expansion spec.
func (s Schedule) Spec() Spec {
	sp := Spec{RRule: s.RRule, Start: fin.MustDate(s.StartDate), Count: s.OccurrenceCount, Adjustment: s.BusinessDayAdjustment}
	if s.EndDate != nil {
		e := fin.MustDate(*s.EndDate)
		sp.End = &e
	}
	return sp
}

// Validate checks the input and fills defaults.
func (in *Input) Validate(prefix string) error {
	v := fin.Validator{}
	if _, err := Parse(in.RRule); err != nil {
		v[prefix+"rrule"] = err.Error()
	}
	start, err := fin.ParseDate(in.StartDate)
	v.Check(err == nil, prefix+"startDate", "must be YYYY-MM-DD")
	if in.EndDate != nil {
		end, err := fin.ParseDate(*in.EndDate)
		v.Check(err == nil, prefix+"endDate", "must be YYYY-MM-DD")
		v.Check(err != nil || !end.Before(start), prefix+"endDate", "must not be before startDate")
	}
	v.Check(in.OccurrenceCount == nil || (*in.OccurrenceCount > 0 && *in.OccurrenceCount <= 100_000), prefix+"occurrenceCount", "must be 1..100000")
	if in.BusinessDayAdjustment == "" {
		in.BusinessDayAdjustment = "none"
	}
	v.Check(fin.OneOf(in.BusinessDayAdjustment, "none", "previous", "next"), prefix+"businessDayAdjustment", "must be none, previous or next")
	if in.Timezone == "" {
		in.Timezone = "UTC"
	}
	_, err = time.LoadLocation(in.Timezone)
	v.Check(err == nil, prefix+"timezone", "unknown IANA timezone")
	return v.Err()
}

const cols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, rrule, start_date, end_date, occurrence_count, timezone, business_day_adjustment`

func scan(row pgx.Row) (Schedule, error) {
	var s Schedule
	var start time.Time
	var end *time.Time
	err := row.Scan(&s.ID, &s.ProfileID, &s.Version, &s.ServerVersion, &s.CreatedAt, &s.UpdatedAt, &s.DeletedAt,
		&s.RRule, &start, &end, &s.OccurrenceCount, &s.Timezone, &s.BusinessDayAdjustment)
	s.StartDate = fin.Fmt(start)
	s.EndDate = fin.FmtPtr(end)
	return s, err
}

// Get loads a non-deleted schedule of the profile.
func Get(ctx context.Context, db fin.DB, profileID, id uuid.UUID) (Schedule, error) {
	s, err := scan(db.QueryRow(ctx, `SELECT `+cols+` FROM recurrence_schedules WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return s, httpx.NotFound("recurrence")
	}
	return s, err
}

// Create inserts a schedule and records the change (in tx).
func Create(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in Input) (Schedule, error) {
	if err := in.Validate(""); err != nil {
		return Schedule{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	s, err := scan(tx.QueryRow(ctx, `INSERT INTO recurrence_schedules (id, profile_id, rrule, start_date, end_date, occurrence_count, timezone, business_day_adjustment)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+cols, id, profileID, in.RRule, in.StartDate, in.EndDate, in.OccurrenceCount, in.Timezone, in.BusinessDayAdjustment))
	if err != nil {
		return s, err
	}
	return record(ctx, tx, s, nil, "recurrence.create")
}

// Update replaces the editable fields (version must match unless force).
func Update(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Schedule, in Input, checkVersion bool) (Schedule, error) {
	if checkVersion {
		if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
			return cur, err
		}
	}
	if err := in.Validate(""); err != nil {
		return cur, err
	}
	s, err := scan(tx.QueryRow(ctx, `UPDATE recurrence_schedules SET rrule=$3, start_date=$4, end_date=$5, occurrence_count=$6, timezone=$7,
		business_day_adjustment=$8, version = version + 1 WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL RETURNING `+cols,
		cur.ID, profileID, in.RRule, in.StartDate, in.EndDate, in.OccurrenceCount, in.Timezone, in.BusinessDayAdjustment))
	if err != nil {
		return s, err
	}
	return record(ctx, tx, s, cur, "recurrence.update")
}

// SetEnd terminates a series (used by subscription cancellation / price changes).
func SetEnd(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Schedule, end time.Time) (Schedule, error) {
	in := cur.input()
	e := fin.Fmt(end)
	in.EndDate = &e
	return Update(ctx, tx, profileID, cur, in, false)
}

func (s Schedule) input() Input {
	return Input{RRule: s.RRule, StartDate: s.StartDate, EndDate: s.EndDate, OccurrenceCount: s.OccurrenceCount, Timezone: s.Timezone, BusinessDayAdjustment: s.BusinessDayAdjustment}
}

// Delete tombstones a schedule.
func Delete(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Schedule) error {
	if _, err := tx.Exec(ctx, `UPDATE recurrence_schedules SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "recurrence_schedules", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "recurrence.delete"})
	return err
}

func record(ctx context.Context, tx pgx.Tx, s Schedule, before any, action string) (Schedule, error) {
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: s.ProfileID, EntityType: "recurrence_schedules", EntityID: s.ID, Op: changes.OpUpsert, Data: s, Before: before, Action: action})
	s.ServerVersion = v
	return s, err
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	r.Get("/recurrences", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 50, 500)
		if err != nil {
			return err
		}
		var after uuid.UUID
		if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
			return err
		}
		rows, err := deps.DB.Query(r.Context(), `SELECT `+cols+` FROM recurrence_schedules WHERE profile_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, pid, after, page.Limit+1)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Schedule, error) { return scan(row) })
		if err != nil {
			return err
		}
		out := httpx.List[Schedule]{Items: items}
		if len(items) > page.Limit {
			out.Items = items[:page.Limit]
			out.NextCursor = httpx.EncodeCursor(out.Items[page.Limit-1].ID)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	r.With(httpx.Idempotent(deps.DB)).Post("/recurrences", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		var s Schedule
		err = pgx.BeginFunc(r.Context(), deps.DB, func(tx pgx.Tx) error {
			s, err = Create(r.Context(), tx, pid, in)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, s)
		return nil
	}))
	r.Post("/recurrences/preview", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		var in Input
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if err := in.Validate(""); err != nil {
			return err
		}
		return writeDates(w, r, deps, pid, Schedule{RRule: in.RRule, StartDate: in.StartDate, EndDate: in.EndDate, OccurrenceCount: in.OccurrenceCount, BusinessDayAdjustment: in.BusinessDayAdjustment})
	}))
	r.Get("/recurrences/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		_, s, err := load(r, deps, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, s)
		return nil
	}))
	r.Get("/recurrences/{id}/occurrences", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, s, err := load(r, deps, authz.RoleViewer)
		if err != nil {
			return err
		}
		return writeDates(w, r, deps, pid, s)
	}))
	r.Patch("/recurrences/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, cur, err := load(r, deps, authz.RoleEditor)
		if err != nil {
			return err
		}
		in := cur.input()
		in.Version = nil
		if err := fin.DecodePatch(r, cur.input(), &in); err != nil {
			return err
		}
		var s Schedule
		err = pgx.BeginFunc(r.Context(), deps.DB, func(tx pgx.Tx) error {
			s, err = Update(r.Context(), tx, pid, cur, in, true)
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, s)
		return nil
	}))
	r.Delete("/recurrences/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		pid, cur, err := load(r, deps, authz.RoleEditor)
		if err != nil {
			return err
		}
		var inUse bool
		if err := deps.DB.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM planned_transactions WHERE recurrence_id = $1 AND deleted_at IS NULL)`, cur.ID).Scan(&inUse); err != nil {
			return err
		}
		if inUse {
			return httpx.Conflict("recurrence is used by a plan; delete or change the plan instead")
		}
		if err := pgx.BeginFunc(r.Context(), deps.DB, func(tx pgx.Tx) error { return Delete(r.Context(), tx, pid, cur) }); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
}

func load(r *http.Request, deps *app.Deps, role authz.Role) (uuid.UUID, Schedule, error) {
	pid, _, err := authz.ProfileFromRequest(r, deps.DB, role)
	if err != nil {
		return pid, Schedule{}, err
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return pid, Schedule{}, httpx.NotFound("recurrence")
	}
	s, err := Get(r.Context(), deps.DB, pid, id)
	return pid, s, err
}

func writeDates(w http.ResponseWriter, r *http.Request, deps *app.Deps, pid uuid.UUID, s Schedule) error {
	p, err := fin.LoadProfile(r.Context(), deps.DB, pid)
	if err != nil {
		return err
	}
	from, to, err := fin.Range(r, p.Today, p.Today.AddDate(1, 0, 0), 366*10)
	if err != nil {
		return err
	}
	occ, err := Expand(s.Spec(), from, to, 5000)
	if err != nil {
		return httpx.Validation(map[string]string{"rrule": err.Error()})
	}
	out := make([]string, len(occ))
	for i, o := range occ {
		out[i] = fin.Fmt(o.Due)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"dates": out})
	return nil
}
