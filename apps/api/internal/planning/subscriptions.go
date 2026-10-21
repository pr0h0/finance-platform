package planning

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// Subscription is the API shape (OpenAPI Subscription). Price and billing schedule live on the
// linked plan; a price change ends that plan's series and starts a new plan (supersedesId chain),
// so past occurrences keep the price that applied to them.
type Subscription struct {
	ID                   uuid.UUID    `json:"id"`
	ProfileID            uuid.UUID    `json:"profileId"`
	Version              int          `json:"version"`
	ServerVersion        int64        `json:"serverVersion"`
	CreatedAt            time.Time    `json:"createdAt"`
	UpdatedAt            time.Time    `json:"updatedAt"`
	DeletedAt            *time.Time   `json:"deletedAt"`
	PlannedTransactionID *uuid.UUID   `json:"plannedTransactionId"`
	MerchantID           *uuid.UUID   `json:"merchantId"`
	Name                 string       `json:"name"`
	Status               string       `json:"status"`
	TrialEndsAt          *string      `json:"trialEndsAt"`
	CancelledAt          *string      `json:"cancelledAt"`
	URL                  string       `json:"url"`
	Notes                string       `json:"notes"`
	Amount               *money.Money `json:"amount"`
	RRule                *string      `json:"rrule"`
	Annualized           *money.Money `json:"annualized"`
	Monthly              *money.Money `json:"monthly"`
	NextDate             *string      `json:"nextDate"`
	AccountID            *uuid.UUID   `json:"accountId"`
	CategoryID           *uuid.UUID   `json:"categoryId"`
	PriceHistory         []PricePoint `json:"priceHistory"`
}

type PricePoint struct {
	Amount money.Money `json:"amount"`
	From   string      `json:"from"`
	To     *string     `json:"to"`
}

// SubscriptionInput is OpenAPI SubscriptionInput. amount/rrule/nextDate/accountId/categoryId
// create or change the linked plan; effectiveDate dates a price change (default today).
type SubscriptionInput struct {
	ID                   *uuid.UUID   `json:"id,omitempty"`
	PlannedTransactionID *uuid.UUID   `json:"plannedTransactionId"`
	MerchantID           *uuid.UUID   `json:"merchantId"`
	Name                 string       `json:"name"`
	Status               string       `json:"status"`
	TrialEndsAt          *string      `json:"trialEndsAt"`
	CancelledAt          *string      `json:"cancelledAt"`
	URL                  string       `json:"url"`
	Notes                string       `json:"notes"`
	Amount               *money.Money `json:"amount"`
	RRule                *string      `json:"rrule"`
	NextDate             *string      `json:"nextDate"`
	AccountID            *uuid.UUID   `json:"accountId"`
	CategoryID           *uuid.UUID   `json:"categoryId"`
	EffectiveDate        *string      `json:"effectiveDate"`
	Version              *int         `json:"version,omitempty"`
}

// Annualize returns the yearly and monthly equivalents of a recurring amount (exact fractions,
// rounded once half-up): annual = amount × occurrences per year (recurrence.PerYear).
func Annualize(amount money.Money, rrule string) (annual, monthly money.Money, err error) {
	r, err := recurrence.Parse(rrule)
	if err != nil {
		return amount, amount, err
	}
	num, den := recurrence.PerYear(r)
	return fin.MulRat(amount, num, den), fin.MulRat(amount, num, den*12), nil
}

const subCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, planned_transaction_id, merchant_id, name,
	status, trial_ends_at, cancelled_at, url, notes`

func scanSub(row pgx.Row) (Subscription, error) {
	var s Subscription
	var trial, cancelled *time.Time
	err := row.Scan(&s.ID, &s.ProfileID, &s.Version, &s.ServerVersion, &s.CreatedAt, &s.UpdatedAt, &s.DeletedAt, &s.PlannedTransactionID,
		&s.MerchantID, &s.Name, &s.Status, &trial, &cancelled, &s.URL, &s.Notes)
	s.TrialEndsAt, s.CancelledAt = fin.FmtPtr(trial), fin.FmtPtr(cancelled)
	s.PriceHistory = []PricePoint{}
	return s, err
}

// enrich fills the derived price fields from the linked plan.
func enrich(ctx context.Context, db fin.DB, s *Subscription, today time.Time) error {
	if s.PlannedTransactionID == nil {
		return nil
	}
	p, err := GetPlan(ctx, db, s.ProfileID, *s.PlannedTransactionID)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil // plan deleted separately
		}
		return err
	}
	amount := p.Amount
	s.Amount, s.AccountID, s.CategoryID = &amount, p.AccountID, p.CategoryID
	if p.Recurrence != nil {
		rr := p.Recurrence.RRule
		s.RRule = &rr
		a, m, err := Annualize(p.Amount, p.Recurrence.RRule)
		if err == nil {
			s.Annualized, s.Monthly = &a, &m
		}
	} else {
		s.Annualized = &amount
	}
	occ, err := ExpandPlans(ctx, db, s.ProfileID, []Plan{p}, today, today.AddDate(5, 0, 0), today)
	if err != nil {
		return err
	}
	for _, o := range occ {
		if o.Status == "pending" {
			d := o.Date
			s.NextDate = &d
			break
		}
	}
	// price history: walk the supersedes chain (newest first)
	for seen := 0; seen < 100; seen++ {
		pp := PricePoint{Amount: p.Amount, From: p.DueDate}
		if p.Recurrence != nil {
			pp.From, pp.To = p.Recurrence.StartDate, p.Recurrence.EndDate
		}
		s.PriceHistory = append(s.PriceHistory, pp)
		if p.SupersedesID == nil {
			break
		}
		if p, err = getPlanAny(ctx, db, s.ProfileID, *p.SupersedesID); err != nil {
			break
		}
	}
	return nil
}

func getPlanAny(ctx context.Context, db fin.DB, profileID, id uuid.UUID) (Plan, error) {
	return scanPlan(db.QueryRow(ctx, `SELECT `+planCols+` FROM planned_transactions p LEFT JOIN recurrence_schedules r ON r.id = p.recurrence_id
		WHERE p.id = $1 AND p.profile_id = $2`, id, profileID))
}

func GetSubscription(ctx context.Context, db fin.DB, profileID, id uuid.UUID, today time.Time) (Subscription, error) {
	s, err := scanSub(db.QueryRow(ctx, `SELECT `+subCols+` FROM subscriptions WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return s, httpx.NotFound("subscription")
	}
	if err != nil {
		return s, err
	}
	return s, enrich(ctx, db, &s, today)
}

func ListSubscriptions(ctx context.Context, db fin.DB, profileID, after uuid.UUID, limit int, today time.Time) ([]Subscription, error) {
	rows, err := db.Query(ctx, `SELECT `+subCols+` FROM subscriptions WHERE profile_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, profileID, after, limit)
	if err != nil {
		return nil, err
	}
	subs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Subscription, error) { return scanSub(row) })
	if err != nil {
		return nil, err
	}
	for i := range subs {
		if err := enrich(ctx, db, &subs[i], today); err != nil {
			return nil, err
		}
	}
	return subs, nil
}

func (in *SubscriptionInput) validate(ctx context.Context, db fin.DB, profileID uuid.UUID) error {
	v := fin.Validator{}
	v.Check(in.Name != "" && len(in.Name) <= 200, "name", "required, at most 200 characters")
	if in.Status == "" {
		in.Status = "active"
	}
	v.Check(fin.OneOf(in.Status, "trial", "active", "paused", "cancelled"), "status", "must be trial, active, paused or cancelled")
	for f, d := range map[string]*string{"trialEndsAt": in.TrialEndsAt, "cancelledAt": in.CancelledAt, "nextDate": in.NextDate, "effectiveDate": in.EffectiveDate} {
		if d != nil {
			_, err := fin.ParseDate(*d)
			v.Check(err == nil, f, "must be YYYY-MM-DD")
		}
	}
	if in.RRule != nil {
		_, err := recurrence.Parse(*in.RRule)
		v.Check(err == nil, "rrule", "invalid recurrence rule")
	}
	if in.Amount != nil {
		v.Check(in.Amount.Sign() > 0, "amount", "must be positive")
	}
	v.Check(len(in.URL) <= 2000 && len(in.Notes) <= 5000, "notes", "too long")
	if err := fin.CheckOwned(ctx, db, v, "merchantId", "merchants", in.MerchantID, profileID); err != nil {
		return err
	}
	if err := fin.CheckOwned(ctx, db, v, "plannedTransactionId", "planned_transactions", in.PlannedTransactionID, profileID); err != nil {
		return err
	}
	return v.Err()
}

// CreateSubscription inserts a subscription; with an amount it also creates the billing plan.
func CreateSubscription(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in SubscriptionInput, today time.Time) (Subscription, error) {
	if err := in.validate(ctx, tx, profileID); err != nil {
		return Subscription{}, err
	}
	if in.PlannedTransactionID == nil && in.Amount != nil {
		start := fin.Fmt(today)
		if in.NextDate != nil {
			start = *in.NextDate
		} else if in.Status == "trial" && in.TrialEndsAt != nil {
			start = *in.TrialEndsAt
		}
		rr := "FREQ=MONTHLY"
		if in.RRule != nil {
			rr = *in.RRule
		}
		p, err := CreatePlan(ctx, tx, profileID, PlanInput{Kind: "expense", AccountID: in.AccountID, CategoryID: in.CategoryID, MerchantID: in.MerchantID,
			Description: in.Name, Amount: in.Amount, DueDate: start, Recurrence: &recurrence.Input{RRule: rr, StartDate: start}, Confidence: "certain"})
		if err != nil {
			return Subscription{}, err
		}
		in.PlannedTransactionID = &p.ID
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	if in.Status == "cancelled" && in.CancelledAt == nil {
		d := fin.Fmt(today)
		in.CancelledAt = &d
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscriptions (id, profile_id, planned_transaction_id, merchant_id, name, status, trial_ends_at, cancelled_at, url, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id, profileID, in.PlannedTransactionID, in.MerchantID, in.Name, in.Status, in.TrialEndsAt,
		in.CancelledAt, in.URL, in.Notes); err != nil {
		return Subscription{}, err
	}
	if err := applyLifecycle(ctx, tx, profileID, in, "", today); err != nil {
		return Subscription{}, err
	}
	return recordSub(ctx, tx, profileID, id, nil, "subscription.create", today)
}

// UpdateSubscription handles metadata edits, price changes, pause/resume and cancellation.
func UpdateSubscription(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Subscription, in SubscriptionInput, today time.Time) (Subscription, error) {
	if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
		return cur, err
	}
	if err := in.validate(ctx, tx, profileID); err != nil {
		return cur, err
	}
	planID := in.PlannedTransactionID
	if planID != nil && cur.PlannedTransactionID != nil && *planID == *cur.PlannedTransactionID {
		p, err := GetPlan(ctx, tx, profileID, *planID)
		if err != nil {
			return cur, err
		}
		pin := p.ToInput()
		pin.Version = &p.Version
		changed := false
		if !sameID(in.AccountID, p.AccountID) || !sameID(in.CategoryID, p.CategoryID) {
			pin.AccountID, pin.CategoryID, changed = in.AccountID, in.CategoryID, true
		}
		if in.RRule != nil && p.Recurrence != nil && *in.RRule != p.Recurrence.RRule {
			pin.Recurrence.RRule, changed = *in.RRule, true
		}
		priceChange := in.Amount != nil && (in.Amount.Currency() != p.Amount.Currency() || cmp(*in.Amount, p.Amount) != 0)
		if changed {
			if p, err = UpdatePlan(ctx, tx, profileID, p, pin); err != nil {
				return cur, err
			}
		}
		if priceChange {
			eff := today
			if in.EffectiveDate != nil {
				eff = fin.MustDate(*in.EffectiveDate)
			}
			np, err := changePrice(ctx, tx, profileID, p, *in.Amount, eff)
			if err != nil {
				return cur, err
			}
			planID = &np.ID
		}
	}
	if in.Status == "cancelled" && in.CancelledAt == nil {
		d := fin.Fmt(today)
		in.CancelledAt = &d
	}
	if in.Status != "cancelled" {
		in.CancelledAt = nil
	}
	if _, err := tx.Exec(ctx, `UPDATE subscriptions SET planned_transaction_id=$3, merchant_id=$4, name=$5, status=$6, trial_ends_at=$7,
		cancelled_at=$8, url=$9, notes=$10, version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID, planID, in.MerchantID,
		in.Name, in.Status, in.TrialEndsAt, in.CancelledAt, in.URL, in.Notes); err != nil {
		return cur, err
	}
	in.PlannedTransactionID = planID
	if err := applyLifecycle(ctx, tx, profileID, in, cur.Status, today); err != nil {
		return cur, err
	}
	return recordSub(ctx, tx, profileID, cur.ID, cur, "subscription.update", today)
}

// changePrice ends the current series the day before `eff` and starts a superseding plan with the
// new price from the first occurrence on or after `eff`. One-off plans are simply repriced.
func changePrice(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, p Plan, amount money.Money, eff time.Time) (Plan, error) {
	in := p.ToInput()
	in.Amount = &amount
	in.Version = &p.Version
	if p.Recurrence == nil {
		return UpdatePlan(ctx, tx, profileID, p, in)
	}
	open := p.Recurrence.Spec()
	open.End = nil
	next, err := recurrence.Next(open, eff, 20)
	if err != nil {
		return p, err
	}
	if next == nil {
		return p, httpx.Validation(map[string]string{"effectiveDate": "the schedule has no occurrence after this date"})
	}
	if !next.Date.After(fin.MustDate(p.Recurrence.StartDate)) {
		return UpdatePlan(ctx, tx, profileID, p, in) // change applies from the very first occurrence
	}
	if _, err := recurrence.SetEnd(ctx, tx, profileID, *p.Recurrence, next.Date.AddDate(0, 0, -1)); err != nil {
		return p, err
	}
	in.Version = nil
	in.Recurrence.StartDate = fin.Fmt(next.Date)
	in.Recurrence.OccurrenceCount = nil
	in.DueDate = in.Recurrence.StartDate
	np, err := CreatePlan(ctx, tx, profileID, in)
	if err != nil {
		return p, err
	}
	if _, err := tx.Exec(ctx, `UPDATE planned_transactions SET supersedes_id = $3 WHERE id = $1 AND profile_id = $2`, np.ID, profileID, p.ID); err != nil {
		return p, err
	}
	return recordPlan(ctx, tx, profileID, np.ID, nil, "plan.supersede")
}

// applyLifecycle keeps the billing plan in line with the subscription status: cancelled ends the
// series at cancelledAt, paused pauses the plan, active/trial resume it.
func applyLifecycle(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in SubscriptionInput, prevStatus string, today time.Time) error {
	if in.PlannedTransactionID == nil || in.Status == prevStatus {
		return nil
	}
	p, err := GetPlan(ctx, tx, profileID, *in.PlannedTransactionID)
	if err != nil {
		return err
	}
	pin := p.ToInput()
	pin.Version = &p.Version
	switch in.Status {
	case "cancelled":
		end := fin.MustDate(*in.CancelledAt)
		if p.Recurrence != nil {
			if fin.MustDate(p.Recurrence.StartDate).After(end) {
				pin.Status = "cancelled"
			} else {
				_, err = recurrence.SetEnd(ctx, tx, profileID, *p.Recurrence, end)
				return err
			}
		} else if fin.MustDate(p.DueDate).After(end) {
			pin.Status = "cancelled"
		} else {
			return nil
		}
	case "paused":
		pin.Status = "paused"
	default:
		if p.Status != "paused" {
			return nil
		}
		pin.Status = "active"
	}
	_, err = UpdatePlan(ctx, tx, profileID, p, pin)
	return err
}

func DeleteSubscription(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Subscription) error {
	if cur.PlannedTransactionID != nil {
		if p, err := GetPlan(ctx, tx, profileID, *cur.PlannedTransactionID); err == nil {
			if err := DeletePlan(ctx, tx, profileID, p); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE subscriptions SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "subscriptions", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "subscription.delete"})
	return err
}

func recordSub(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before any, action string, today time.Time) (Subscription, error) {
	s, err := GetSubscription(ctx, tx, profileID, id, today)
	if err != nil {
		return s, err
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "subscriptions", EntityID: id, Op: changes.OpUpsert, Data: s, Before: before, Action: action})
	s.ServerVersion = v
	return s, err
}

func sameID(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
