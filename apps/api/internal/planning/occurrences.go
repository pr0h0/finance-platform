package planning

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// Occurrence is one dated instance of a plan (OpenAPI Occurrence). Unmentioned occurrences are
// derived by expanding the recurrence; planned_occurrences rows only hold matches/skips/overrides.
type Occurrence struct {
	PlannedTransactionID uuid.UUID    `json:"plannedTransactionId"`
	Date                 string       `json:"date"`        // effective due date (override or weekend-adjusted)
	NominalDate          string       `json:"nominalDate"` // occurrence identity (PUT /plans/{id}/occurrences/{nominalDate})
	Amount               money.Money  `json:"amount"`
	Status               string       `json:"status"`
	MatchedTransactionID *uuid.UUID   `json:"matchedTransactionId"`
	InstallmentNumber    *int         `json:"installmentNumber"`
	Description          string       `json:"description"`
	Kind                 string       `json:"kind"`
	AccountID            *uuid.UUID   `json:"accountId"`
	ToAccountID          *uuid.UUID   `json:"toAccountId"`
	CategoryID           *uuid.UUID   `json:"categoryId"`
	MerchantID           *uuid.UUID   `json:"merchantId"`
	Priority             string       `json:"priority"`
	Confidence           string       `json:"confidence"`
	Overdue              bool         `json:"overdue"`
	AmountMin            *money.Money `json:"-"`
	AmountMax            *money.Money `json:"-"`
	ReminderDaysBefore   *int         `json:"-"`
	Day                  time.Time    `json:"-"`
}

// Resolved reports whether the occurrence no longer represents a future obligation: matched to a
// real transaction, paid outside the ledger or skipped. Resolved occurrences are never counted
// again in budgets ("committed") or forecasts (financial invariant 19).
func (o Occurrence) Resolved() bool { return o.Status != "pending" }

type occRow struct {
	status     string
	amount     *money.Money
	dateOver   *time.Time
	matchedTxn *uuid.UUID
}

// window margin used to catch occurrences moved into the range by a date override.
const overrideMargin = 62

// Expand returns occurrences of the profile's plans whose effective date lies in [from, to],
// ordered by date. statuses nil = active plans only. today marks pending past occurrences overdue.
func Expand(ctx context.Context, db fin.DB, profileID uuid.UUID, from, to, today time.Time, planStatuses []string) ([]Occurrence, error) {
	if planStatuses == nil {
		planStatuses = []string{"active"}
	}
	plans, err := ListPlans(ctx, db, profileID, uuid.Nil, 100_000, planStatuses)
	if err != nil {
		return nil, err
	}
	return ExpandPlans(ctx, db, profileID, plans, from, to, today)
}

// ExpandPlans expands the given plans (see Expand).
func ExpandPlans(ctx context.Context, db fin.DB, profileID uuid.UUID, plans []Plan, from, to, today time.Time) ([]Occurrence, error) {
	if len(plans) == 0 {
		return nil, nil
	}
	ids := make([]uuid.UUID, len(plans))
	for i, p := range plans {
		ids[i] = p.ID
	}
	rows, err := db.Query(ctx, `SELECT planned_transaction_id, occurrence_date, status, amount_override, date_override, matched_transaction_id
		FROM planned_occurrences WHERE profile_id = $1 AND planned_transaction_id = ANY($2) AND deleted_at IS NULL`, profileID, ids)
	if err != nil {
		return nil, fmt.Errorf("occurrence rows: %w", err)
	}
	type key struct {
		plan uuid.UUID
		day  time.Time
	}
	state := map[key]occRow{}
	planCur := map[uuid.UUID]string{}
	for _, p := range plans {
		planCur[p.ID] = p.Amount.Currency()
	}
	for rows.Next() {
		var pid uuid.UUID
		var day time.Time
		var r occRow
		var amt pgtype.Numeric
		if err := rows.Scan(&pid, &day, &r.status, &amt, &r.dateOver, &r.matchedTxn); err != nil {
			rows.Close()
			return nil, err
		}
		if r.amount, err = fin.OptMoney(amt, planCur[pid]); err != nil {
			rows.Close()
			return nil, err
		}
		if r.dateOver != nil {
			d := fin.AsDate(*r.dateOver)
			r.dateOver = &d
		}
		state[key{pid, fin.AsDate(day)}] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var out []Occurrence
	for _, p := range plans {
		nominal, err := planDates(p, from.AddDate(0, 0, -overrideMargin), to.AddDate(0, 0, overrideMargin))
		if err != nil {
			return nil, err
		}
		for _, n := range nominal {
			o := Occurrence{PlannedTransactionID: p.ID, NominalDate: fin.Fmt(n.Date), Amount: p.Amount, Status: "pending",
				Description: p.Description, Kind: p.Kind, AccountID: p.AccountID, ToAccountID: p.ToAccountID, CategoryID: p.CategoryID,
				MerchantID: p.MerchantID, Priority: p.Priority, Confidence: p.Confidence, AmountMin: p.AmountMin, AmountMax: p.AmountMax,
				ReminderDaysBefore: p.ReminderDaysBefore, Day: n.Due}
			if p.InstallmentTotal != nil {
				num := *p.InstallmentStart + n.Index
				o.InstallmentNumber = &num
			}
			if r, ok := state[key{p.ID, n.Date}]; ok {
				o.Status, o.MatchedTransactionID = r.status, r.matchedTxn
				if r.amount != nil {
					o.Amount = *r.amount
				}
				if r.dateOver != nil {
					o.Day = *r.dateOver
				}
			}
			if o.Day.Before(from) || o.Day.After(to) {
				continue
			}
			o.Date = fin.Fmt(o.Day)
			o.Overdue = o.Status == "pending" && o.Day.Before(today)
			out = append(out, o)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].Day.Equal(out[j].Day) {
			return out[i].Day.Before(out[j].Day)
		}
		return out[i].PlannedTransactionID.String() < out[j].PlannedTransactionID.String()
	})
	return out, nil
}

// planDates expands a plan's nominal dates (weekend-adjusted due dates in recurrence.Occurrence.Due).
func planDates(p Plan, from, to time.Time) ([]recurrence.Occurrence, error) {
	if p.Recurrence == nil {
		d := fin.MustDate(p.DueDate)
		if d.Before(from) || d.After(to) {
			return nil, nil
		}
		return []recurrence.Occurrence{{Index: 0, Date: d, Due: d}}, nil
	}
	spec := p.Recurrence.Spec()
	if p.InstallmentTotal != nil {
		n := *p.InstallmentTotal - *p.InstallmentStart + 1
		if spec.Count == nil || n < *spec.Count {
			spec.Count = &n
		}
	}
	return recurrence.Expand(spec, from, to, 0)
}

// isOccurrence checks that nominal is a date of the plan's series.
func isOccurrence(p Plan, nominal time.Time) (bool, error) {
	occ, err := planDates(p, nominal.AddDate(0, 0, -3), nominal.AddDate(0, 0, 3))
	if err != nil {
		return false, err
	}
	for _, o := range occ {
		if o.Date.Equal(nominal) {
			return true, nil
		}
	}
	return false, nil
}

// OccurrenceRow is the synced shape of a planned_occurrences row (domain PlannedOccurrence).
type OccurrenceRow struct {
	ID                   uuid.UUID    `json:"id"`
	ProfileID            uuid.UUID    `json:"profileId"`
	Version              int          `json:"version"`
	ServerVersion        int64        `json:"serverVersion"`
	CreatedAt            time.Time    `json:"createdAt"`
	UpdatedAt            time.Time    `json:"updatedAt"`
	DeletedAt            *time.Time   `json:"deletedAt"`
	PlannedTransactionID uuid.UUID    `json:"plannedTransactionId"`
	OccurrenceDate       string       `json:"occurrenceDate"`
	Status               string       `json:"status"`
	AmountOverride       *money.Money `json:"amountOverride"`
	DateOverride         *string      `json:"dateOverride"`
	MatchedTransactionID *uuid.UUID   `json:"matchedTransactionId"`
}

// OccurrenceUpdate is OpenAPI OccurrenceUpdate.
type OccurrenceUpdate struct {
	Status               string       `json:"status"`
	MatchedTransactionID *uuid.UUID   `json:"matchedTransactionId"`
	AmountOverride       *money.Money `json:"amountOverride"`
	DateOverride         *string      `json:"dateOverride"`
}

// SetOccurrence matches / skips / marks paid / overrides one occurrence (identified by its nominal date).
func SetOccurrence(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, p Plan, nominal time.Time, u OccurrenceUpdate) (OccurrenceRow, error) {
	v := fin.Validator{}
	ok, err := isOccurrence(p, nominal)
	if err != nil {
		return OccurrenceRow{}, err
	}
	if !ok {
		return OccurrenceRow{}, httpx.NotFound("occurrence")
	}
	if u.Status == "" {
		u.Status = "pending"
	}
	v.Check(fin.OneOf(u.Status, "pending", "matched", "skipped", "paid_manual"), "status", "invalid status")
	v.Check((u.Status == "matched") == (u.MatchedTransactionID != nil), "matchedTransactionId", "required exactly when status is matched")
	if u.AmountOverride != nil {
		v.Check(u.AmountOverride.Currency() == p.Amount.Currency(), "amountOverride", "must use the plan currency")
		v.Check(u.AmountOverride.Sign() > 0, "amountOverride", "must be positive")
	}
	if u.DateOverride != nil {
		_, err := fin.ParseDate(*u.DateOverride)
		v.Check(err == nil, "dateOverride", "must be YYYY-MM-DD")
	}
	if u.MatchedTransactionID != nil && u.Status == "matched" {
		var kind, status string
		err := tx.QueryRow(ctx, `SELECT kind, status FROM transactions WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, *u.MatchedTransactionID, profileID).Scan(&kind, &status)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			v.Check(false, "matchedTransactionId", "transaction not found in this profile")
		case err != nil:
			return OccurrenceRow{}, err
		default:
			v.Check(status != "void", "matchedTransactionId", "transaction is void")
			v.Check(kind == p.Kind, "matchedTransactionId", fmt.Sprintf("a %s plan can only match a %s transaction", p.Kind, p.Kind))
		}
		var other bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM planned_occurrences WHERE matched_transaction_id = $1 AND deleted_at IS NULL
			AND NOT (planned_transaction_id = $2 AND occurrence_date = $3))`, *u.MatchedTransactionID, p.ID, nominal).Scan(&other); err != nil {
			return OccurrenceRow{}, err
		}
		if other && len(v) == 0 {
			return OccurrenceRow{}, httpx.Conflict("transaction is already matched to another planned occurrence")
		}
	}
	if err := v.Err(); err != nil {
		return OccurrenceRow{}, err
	}
	if u.Status != "matched" {
		u.MatchedTransactionID = nil
	}
	var before *OccurrenceRow
	if cur, err := getOccurrenceRow(ctx, tx, profileID, p.ID, nominal, true); err == nil {
		before = &cur
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return OccurrenceRow{}, err
	}
	if before == nil {
		_, err = tx.Exec(ctx, `INSERT INTO planned_occurrences (profile_id, planned_transaction_id, occurrence_date, status, amount_override, date_override, matched_transaction_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, profileID, p.ID, nominal, u.Status, optNumeric(u.AmountOverride), u.DateOverride, u.MatchedTransactionID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE planned_occurrences SET status=$3, amount_override=$4, date_override=$5, matched_transaction_id=$6,
			version = version + 1 WHERE id = $1 AND profile_id = $2`, before.ID, profileID, u.Status, optNumeric(u.AmountOverride), u.DateOverride, u.MatchedTransactionID)
	}
	if err != nil {
		if strings.Contains(err.Error(), "planned_occurrences_matched_txn_uq") {
			return OccurrenceRow{}, httpx.Conflict("transaction is already matched to another planned occurrence")
		}
		return OccurrenceRow{}, err
	}
	row, err := getOccurrenceRow(ctx, tx, profileID, p.ID, nominal, false)
	if err != nil {
		return row, err
	}
	action := "plan_occurrence." + u.Status
	sv, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "planned_occurrences", EntityID: row.ID, Op: changes.OpUpsert,
		Data: row, Before: before, Action: action, Metadata: map[string]any{"plan_id": p.ID.String()}})
	row.ServerVersion = sv
	return row, err
}

func getOccurrenceRow(ctx context.Context, db fin.DB, profileID, planID uuid.UUID, nominal time.Time, lock bool) (OccurrenceRow, error) {
	q := `SELECT o.id, o.profile_id, o.version, o.server_version, o.created_at, o.updated_at, o.deleted_at, o.planned_transaction_id,
		o.occurrence_date, o.status, o.amount_override, p.currency, o.date_override, o.matched_transaction_id
		FROM planned_occurrences o JOIN planned_transactions p ON p.id = o.planned_transaction_id
		WHERE o.profile_id = $1 AND o.planned_transaction_id = $2 AND o.occurrence_date = $3 AND o.deleted_at IS NULL`
	if lock {
		q += ` FOR UPDATE OF o`
	}
	var r OccurrenceRow
	var day time.Time
	var dov *time.Time
	var amt pgtype.Numeric
	var cur string
	err := db.QueryRow(ctx, q, profileID, planID, nominal).Scan(&r.ID, &r.ProfileID, &r.Version, &r.ServerVersion, &r.CreatedAt, &r.UpdatedAt,
		&r.DeletedAt, &r.PlannedTransactionID, &day, &r.Status, &amt, &cur, &dov, &r.MatchedTransactionID)
	if err != nil {
		return r, err
	}
	r.OccurrenceDate = fin.Fmt(day)
	r.DateOverride = fin.FmtPtr(dov)
	r.AmountOverride, err = fin.OptMoney(amt, cur)
	return r, err
}

// MatchSuggestion is OpenAPI MatchSuggestion.
type MatchSuggestion struct {
	PlannedTransactionID uuid.UUID `json:"plannedTransactionId"`
	OccurrenceDate       string    `json:"occurrenceDate"`
	TransactionID        uuid.UUID `json:"transactionId"`
	Score                string    `json:"score"`
	Reasons              []string  `json:"reasons"`
}

type candidateTxn struct {
	id         uuid.UUID
	kind       string
	date       time.Time
	merchantID *uuid.UUID
	postings   map[uuid.UUID]money.Money // account -> amount (signed)
	categories []uuid.UUID
}

// Suggestions proposes unmatched transaction <-> pending occurrence pairs. Scoring (0..1, shown
// as reasons): amount within the plan's range or ±10% (0.4), date within 7 days (0.3), same
// account (0.15), same merchant (0.1), same category (0.05). Minimum 0.55; each transaction and
// occurrence is suggested at most once (best score first).
func Suggestions(ctx context.Context, db fin.DB, profileID uuid.UUID, from, to, today time.Time) ([]MatchSuggestion, error) {
	occ, err := Expand(ctx, db, profileID, from, to, today, nil)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `SELECT t.id, t.kind, t.booking_date, t.merchant_id, p.account_id, p.amount, p.currency,
		coalesce((SELECT array_agg(s.category_id) FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IS NOT NULL), '{}')
		FROM transactions t JOIN postings p ON p.transaction_id = t.id AND p.deleted_at IS NULL
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.status <> 'void' AND t.kind IN ('income','expense','transfer')
		  AND t.booking_date BETWEEN $2 AND $3
		  AND NOT EXISTS (SELECT 1 FROM planned_occurrences o WHERE o.matched_transaction_id = t.id AND o.deleted_at IS NULL)
		ORDER BY t.booking_date, t.id`, profileID, from.AddDate(0, 0, -7), to.AddDate(0, 0, 7))
	if err != nil {
		return nil, err
	}
	byID := map[uuid.UUID]*candidateTxn{}
	var order []*candidateTxn
	for rows.Next() {
		var c candidateTxn
		var acc uuid.UUID
		var amt pgtype.Numeric
		var cur string
		if err := rows.Scan(&c.id, &c.kind, &c.date, &c.merchantID, &acc, &amt, &cur, &c.categories); err != nil {
			rows.Close()
			return nil, err
		}
		m, err := fin.NumericMoney(amt, cur)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if prev, ok := byID[c.id]; ok {
			prev.postings[acc] = m
			continue
		}
		c.date = fin.AsDate(c.date)
		c.postings = map[uuid.UUID]money.Money{acc: m}
		byID[c.id] = &c
		order = append(order, &c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	type scored struct {
		s     MatchSuggestion
		score int // per mille
	}
	var all []scored
	for _, o := range occ {
		if o.Status != "pending" {
			continue
		}
		for _, c := range order {
			if score, reasons := scoreMatch(o, c); score >= 550 {
				all = append(all, scored{MatchSuggestion{PlannedTransactionID: o.PlannedTransactionID, OccurrenceDate: o.NominalDate, TransactionID: c.id,
					Score: fmt.Sprintf("%d.%03d", score/1000, score%1000), Reasons: reasons}, score})
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].score > all[j].score })
	usedTxn, usedOcc := map[uuid.UUID]bool{}, map[string]bool{}
	out := []MatchSuggestion{}
	for _, a := range all {
		k := a.s.PlannedTransactionID.String() + a.s.OccurrenceDate
		if usedTxn[a.s.TransactionID] || usedOcc[k] {
			continue
		}
		usedTxn[a.s.TransactionID], usedOcc[k] = true, true
		out = append(out, a.s)
	}
	return out, nil
}

func scoreMatch(o Occurrence, c *candidateTxn) (int, []string) {
	if c.kind != o.Kind {
		return 0, nil
	}
	// The amount that moved on the plan's account (or the only/first posting).
	var amt money.Money
	found := false
	if o.AccountID != nil {
		amt, found = c.postings[*o.AccountID]
	}
	if !found {
		for _, m := range c.postings {
			if (o.Kind == "income") == (m.Sign() > 0) {
				amt, found = m, true
				break
			}
		}
	}
	if !found || amt.Currency() != o.Amount.Currency() {
		return 0, nil
	}
	amt = amt.Abs()
	score := 0
	var reasons []string
	lo, hi := o.AmountMin, o.AmountMax
	inRange := lo != nil && hi != nil && cmp(amt, *lo) >= 0 && cmp(amt, *hi) <= 0
	diff, _ := amt.Sub(o.Amount)
	// |diff| / expected in per mille
	pm := new(big.Int).Div(new(big.Int).Mul(diff.Abs().Minor(), big.NewInt(1000)), o.Amount.Minor()).Int64()
	switch {
	case diff.IsZero():
		score += 400
		reasons = append(reasons, "exact amount")
	case inRange:
		score += 350
		reasons = append(reasons, "amount within the expected range")
	case pm <= 100:
		score += int(400 * (100 - pm) / 100)
		reasons = append(reasons, fmt.Sprintf("amount within %d.%d%% of plan", pm/10, pm%10))
	default:
		return 0, nil
	}
	days := fin.DaysBetween(o.Day, c.date)
	if days < 0 {
		days = -days
	}
	if days > 7 {
		return 0, nil
	}
	score += 300 * (8 - days) / 8
	reasons = append(reasons, fmt.Sprintf("%d day(s) from due date", days))
	if o.AccountID != nil {
		if _, ok := c.postings[*o.AccountID]; ok {
			score += 150
			reasons = append(reasons, "same account")
		}
	}
	if o.MerchantID != nil && c.merchantID != nil && *o.MerchantID == *c.merchantID {
		score += 100
		reasons = append(reasons, "same merchant")
	}
	if o.CategoryID != nil {
		for _, cat := range c.categories {
			if cat == *o.CategoryID {
				score += 50
				reasons = append(reasons, "same category")
				break
			}
		}
	}
	return min(score, 1000), reasons
}

func cmp(a, b money.Money) int {
	c, _ := a.Cmp(b)
	return c
}

// InstallmentProgress computes paid/outstanding for an installment plan.
func InstallmentProgress(ctx context.Context, db fin.DB, profileID uuid.UUID, p Plan, today time.Time) (*Installments, error) {
	if p.InstallmentTotal == nil {
		return nil, nil
	}
	start := fin.MustDate(p.DueDate)
	occ, err := ExpandPlans(ctx, db, profileID, []Plan{p}, start.AddDate(-1, 0, 0), start.AddDate(110, 0, 0), today)
	if err != nil {
		return nil, err
	}
	total := *p.InstallmentTotal
	alreadyPaid := *p.InstallmentStart - 1 // installments paid before tracking started
	paid := fin.Accumulator{}
	paidN := alreadyPaid
	outstanding := fin.Accumulator{}
	var next *string
	for _, o := range occ {
		if o.Status == "matched" || o.Status == "paid_manual" {
			paidN++
			paid.Add(o.Amount)
			continue
		}
		if o.Status == "skipped" {
			continue
		}
		outstanding.Add(o.Amount)
		if next == nil {
			d := o.Date
			next = &d
		}
	}
	return &Installments{Total: total, Paid: paidN, Remaining: total - paidN, PaidAmount: paid.Money(p.Amount.Currency()),
		Outstanding: outstanding.Money(p.Amount.Currency()), NextDueDate: next}, nil
}
