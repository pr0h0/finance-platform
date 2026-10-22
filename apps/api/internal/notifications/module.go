// Package notifications: In-app notifications and reminders.
//
// Owned routes under /api/v1: /notifications (incl. /notifications/preferences, /push-subscriptions, /test)
// See docs/api/openapi.yaml for the contract. Notifications belong to a user (not a profile
// header); Generate (run by the background job) derives them from planning, budgets, forecasts,
// anomalies and sync conflicts and is idempotent through notifications.dedupe_key. Users who opted in
// also get them by email (SMTP) and Web Push: Generate queues channel email/push rows, Deliver sends them.
package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/forecasting"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
)

type Notification struct {
	ID        uuid.UUID       `json:"id"`
	ProfileID *uuid.UUID      `json:"profileId"`
	Kind      string          `json:"kind"`
	Severity  string          `json:"severity"`
	Title     string          `json:"title"`
	Body      string          `json:"body"`
	Data      json.RawMessage `json:"data"`
	ReadAt    *time.Time      `json:"readAt"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Register mounts this module's routes on the /api/v1 router and, when background jobs are
// enabled, starts the reminder generator (every 15 minutes, one instance via an advisory lock).
func Register(r chi.Router, deps *app.Deps) {
	db := deps.DB
	r.Get("/notifications", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 50, 200)
		if err != nil {
			return err
		}
		var cur struct {
			At time.Time `json:"at"`
			ID uuid.UUID `json:"id"`
		}
		cur.At = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
		if err := httpx.DecodeCursor(page.Cursor, &cur); err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT n.id, n.profile_id, n.kind, n.severity, n.title, n.body, n.data, n.read_at, n.created_at
			FROM notifications n WHERE n.user_id = $1 AND n.dismissed_at IS NULL AND n.channel = 'in_app'
			  AND (n.scheduled_for IS NULL OR n.scheduled_for <= now())
			  AND (n.profile_id IS NULL OR EXISTS (SELECT 1 FROM profile_members m WHERE m.profile_id = n.profile_id AND m.user_id = $1))
			  AND (NOT $2 OR n.read_at IS NULL) AND (n.created_at, n.id) < ($3, $4)
			ORDER BY n.created_at DESC, n.id DESC LIMIT $5`, p.UserID, r.URL.Query().Get("unread") == "true", cur.At, cur.ID, page.Limit+1)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Notification, error) {
			var n Notification
			err := row.Scan(&n.ID, &n.ProfileID, &n.Kind, &n.Severity, &n.Title, &n.Body, &n.Data, &n.ReadAt, &n.CreatedAt)
			return n, err
		})
		if err != nil {
			return err
		}
		out := httpx.List[Notification]{Items: items}
		if len(items) > page.Limit {
			out.Items = items[:page.Limit]
			last := out.Items[page.Limit-1]
			cur.At, cur.ID = last.CreatedAt, last.ID
			out.NextCursor = httpx.EncodeCursor(cur)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
	mark := func(sql string) http.HandlerFunc {
		return httpx.H(func(w http.ResponseWriter, r *http.Request) error {
			p, err := authz.Require(r.Context())
			if err != nil {
				return err
			}
			id, err := uuid.Parse(chi.URLParam(r, "id"))
			if err != nil {
				return httpx.NotFound("notification")
			}
			tag, err := db.Exec(r.Context(), sql, id, p.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return httpx.NotFound("notification")
			}
			w.WriteHeader(http.StatusNoContent)
			return nil
		})
	}
	r.Post("/notifications/read-all", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		if _, err := db.Exec(r.Context(), `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, p.UserID); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))
	r.Post("/notifications/{id}/read", mark(`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`))
	r.Delete("/notifications/{id}", mark(`UPDATE notifications SET dismissed_at = coalesce(dismissed_at, now()) WHERE id = $1 AND user_id = $2`))

	registerDelivery(r, deps)

	if deps.Config != nil && deps.Config.JobsEnabled && db != nil {
		go loop(db, deps.Config, deps.Log)
	}
}

func loop(db *pgxpool.Pool, cfg *config.Config, log *slog.Logger) {
	time.Sleep(30 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		n, err := RunOnce(ctx, db)
		cancel()
		if err != nil && log != nil {
			log.Error("notification job failed", "err", err)
		} else if n > 0 && log != nil {
			log.Info("notifications generated", "count", n)
		}
		ctx, cancel = context.WithTimeout(context.Background(), 10*time.Minute)
		n, err = Deliver(ctx, db, cfg)
		cancel()
		if err != nil && log != nil {
			log.Error("notification delivery failed", "err", err)
		} else if n > 0 && log != nil {
			log.Info("notifications delivered", "count", n)
		}
		time.Sleep(15 * time.Minute)
	}
}

// RunOnce generates notifications for every profile if this instance wins the advisory lock.
func RunOnce(ctx context.Context, db *pgxpool.Pool) (int, error) {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext('finplat.notifications'))`).Scan(&got); err != nil || !got {
		return 0, err
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('finplat.notifications'))`) //nolint:errcheck
	rows, err := db.Query(ctx, `SELECT id FROM profiles WHERE deleted_at IS NULL`)
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return 0, err
	}
	total := 0
	var errs []error
	for _, id := range ids {
		n, err := Generate(ctx, db, id)
		total += n
		if err != nil {
			errs = append(errs, fmt.Errorf("profile %s: %w", id, err))
		}
	}
	return total, errors.Join(errs...)
}

type candidate struct {
	kind, severity, title, body, dedupe string
	data                                map[string]any
}

// Generate derives reminders for one profile and delivers them to each member (deduplicated):
//   - bill_due: pending planned expenses/transfers due within the plan's reminderDaysBefore (default 3);
//   - bill_overdue: pending ones up to 7 days past due;
//   - budget_threshold: a budget line reached an alert threshold in the current period;
//   - low_balance: the expected forecast goes below zero within 14 days;
//   - trial_ending: a subscription trial ends within 3 days;
//   - unusual_expense: an anomaly flagged in the last 7 days (not dismissed);
//   - sync_conflict: open sync conflicts wait for a decision.
func Generate(ctx context.Context, db fin.DB, profileID uuid.UUID) (int, error) {
	p, err := fin.LoadProfile(ctx, db, profileID)
	if err != nil {
		return 0, err
	}
	today := p.Today
	var cands []candidate
	occ, err := planning.Expand(ctx, db, p.ID, today.AddDate(0, 0, -7), today.AddDate(0, 0, 60), today, nil)
	if err != nil {
		return 0, err
	}
	for _, o := range occ {
		if o.Kind == "income" || o.Resolved() {
			continue
		}
		days := 3
		if o.ReminderDaysBefore != nil {
			days = *o.ReminderDaysBefore
		}
		left := fin.DaysBetween(today, o.Day)
		data := map[string]any{"planId": o.PlannedTransactionID, "date": o.Date, "nominalDate": o.NominalDate, "amount": o.Amount}
		switch {
		case left < 0:
			cands = append(cands, candidate{"bill_overdue", "warning", "Overdue: " + o.Description,
				fmt.Sprintf("%s was due on %s. Match the payment, mark it paid or skip it.", o.Amount, o.Date), "bill_overdue:" + o.PlannedTransactionID.String() + ":" + o.NominalDate, data})
		case left <= days:
			when := "today"
			if left == 1 {
				when = "tomorrow"
			} else if left > 1 {
				when = "on " + o.Date
			}
			cands = append(cands, candidate{"bill_due", "info", o.Description + " due " + when,
				fmt.Sprintf("%s is scheduled %s.", o.Amount, when), "bill_due:" + o.PlannedTransactionID.String() + ":" + o.NominalDate, data})
		}
	}
	alerts, err := budgets.CurrentAlerts(ctx, db, p.ID, today)
	if err != nil {
		return 0, err
	}
	for _, a := range alerts {
		sev := "warning"
		if t, _ := new(big.Rat).SetString(*a.Line.Alert); t != nil && t.Cmp(big.NewRat(1, 1)) >= 0 {
			sev = "critical"
		}
		cat := "all categories"
		if a.Line.CategoryID != nil {
			cat = a.Line.CategoryID.String()
		}
		cands = append(cands, candidate{"budget_threshold", sev, a.Budget.Name + ": budget threshold reached",
			fmt.Sprintf("Spent %s of %s (utilization %s, threshold %s).", a.Line.Actual, a.Line.Limit, *a.Line.Utilization, *a.Line.Alert),
			fmt.Sprintf("budget:%s:%s:%s:%s", a.Budget.ID, a.PeriodStart, cat, *a.Line.Alert),
			map[string]any{"budgetId": a.Budget.ID, "categoryId": a.Line.CategoryID, "periodStart": a.PeriodStart, "threshold": *a.Line.Alert}})
	}
	f, err := forecasting.Build(ctx, db, p, forecasting.Options{Days: 14, Currency: p.BaseCurrency})
	if err != nil {
		return 0, err
	}
	for _, s := range f.Shortfalls {
		if s.Scenario != "expected" || s.AccountID == nil {
			continue
		}
		cands = append(cands, candidate{"low_balance", "critical", "Balance projected below zero on " + s.Date,
			fmt.Sprintf("An account is expected to reach %s on %s based on planned payments.", s.Amount, s.Date),
			"shortfall:" + s.AccountID.String() + ":" + s.Date, map[string]any{"accountId": s.AccountID, "date": s.Date, "amount": s.Amount}})
	}
	rows, err := db.Query(ctx, `SELECT id, name, trial_ends_at FROM subscriptions WHERE profile_id = $1 AND deleted_at IS NULL AND status = 'trial'
		AND trial_ends_at BETWEEN $2 AND $3`, p.ID, today, today.AddDate(0, 0, 3))
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id uuid.UUID
		var name string
		var end time.Time
		if err := rows.Scan(&id, &name, &end); err != nil {
			rows.Close()
			return 0, err
		}
		cands = append(cands, candidate{"trial_ending", "info", name + " trial ends " + fin.Fmt(end), "Cancel before then if you do not want to be charged.",
			"trial:" + id.String() + ":" + fin.Fmt(end), map[string]any{"subscriptionId": id}})
	}
	rows.Close()
	anoms, err := analytics.Anomalies(ctx, db, analytics.Query{P: p, From: today.AddDate(0, 0, -7), To: today, Currency: p.BaseCurrency}, false)
	if err != nil {
		return 0, err
	}
	for _, a := range anoms {
		cands = append(cands, candidate{"unusual_expense", "warning", "Unusual expense: " + a.Description, a.Explanation,
			"anomaly:" + a.TransactionID.String() + ":" + a.Rule, map[string]any{"transactionId": a.TransactionID, "rule": a.Rule}})
	}

	var conflicts int
	var latest *uuid.UUID
	if err := db.QueryRow(ctx, `SELECT count(*), (array_agg(id ORDER BY created_at DESC, id DESC))[1] FROM sync_conflicts
		WHERE profile_id = $1 AND status = 'open'`, p.ID).Scan(&conflicts, &latest); err != nil {
		return 0, err
	}
	if conflicts > 0 {
		cands = append(cands, candidate{"sync_conflict", "warning", fmt.Sprintf("%d sync conflict(s) need your decision", conflicts),
			"Changes from different devices touched the same records. Review them on the Sync page.",
			"sync_conflict:" + latest.String(), map[string]any{"count": conflicts, "link": "/sync"}})
	}

	mrows, err := db.Query(ctx, `SELECT user_id FROM profile_members WHERE profile_id = $1`, p.ID)
	if err != nil {
		return 0, err
	}
	users, err := pgx.CollectRows(mrows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return 0, err
	}
	n := 0
	for _, u := range users {
		prefs, err := loadPrefs(ctx, db, u)
		if err != nil {
			return n, err
		}
		var hasPush bool
		if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $1)`, u).Scan(&hasPush); err != nil {
			return n, err
		}
		for _, c := range cands {
			data, _ := json.Marshal(c.data)
			dedupe := p.ID.String() + ":" + c.dedupe
			tag, err := db.Exec(ctx, `INSERT INTO notifications (user_id, profile_id, kind, severity, title, body, data, dedupe_key, delivered_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
				u, p.ID, c.kind, c.severity, c.title, c.body, data, dedupe)
			if err != nil {
				return n, err
			}
			if tag.RowsAffected() == 1 {
				n++
				if err := enqueue(ctx, db, u, prefs, hasPush, p.ID, c, data, dedupe); err != nil {
					return n, err
				}
			}
		}
	}
	return n, nil
}
