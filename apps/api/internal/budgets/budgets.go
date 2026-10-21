package budgets

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
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
)

// Budget is the API shape (OpenAPI Budget). Allocations are the default per-period limits
// (budgetPeriodId null); category null = whole-budget limit (an overall monthly budget).
type Budget struct {
	ID              uuid.UUID    `json:"id"`
	ProfileID       uuid.UUID    `json:"profileId"`
	Version         int          `json:"version"`
	ServerVersion   int64        `json:"serverVersion"`
	CreatedAt       time.Time    `json:"createdAt"`
	UpdatedAt       time.Time    `json:"updatedAt"`
	DeletedAt       *time.Time   `json:"deletedAt"`
	Name            string       `json:"name"`
	PeriodType      string       `json:"periodType"`
	PeriodAnchorDay int          `json:"periodAnchorDay"`
	StartDate       string       `json:"startDate"`
	EndDate         *string      `json:"endDate"`
	Currency        string       `json:"currency"`
	RolloverPolicy  string       `json:"rolloverPolicy"`
	IncludePlanned  bool         `json:"includePlanned"`
	AlertThresholds []string     `json:"alertThresholds"`
	IsTemplate      bool         `json:"isTemplate"`
	TemplateID      *uuid.UUID   `json:"templateId"`
	IsArchived      bool         `json:"isArchived"`
	Allocations     []Allocation `json:"allocations"`
}

type Allocation struct {
	ID             uuid.UUID   `json:"id"`
	BudgetPeriodID *uuid.UUID  `json:"budgetPeriodId"`
	CategoryID     *uuid.UUID  `json:"categoryId"`
	Amount         money.Money `json:"amount"`
	RolloverAmount money.Money `json:"rolloverAmount"`
	RolloverPolicy *string     `json:"rolloverPolicy"`
}

type AllocationInput struct {
	CategoryID     *uuid.UUID   `json:"categoryId"`
	Amount         *money.Money `json:"amount"`
	RolloverPolicy *string      `json:"rolloverPolicy"`
}

// Input is OpenAPI BudgetInput.
type Input struct {
	ID              *uuid.UUID        `json:"id,omitempty"`
	Name            string            `json:"name"`
	PeriodType      string            `json:"periodType"`
	PeriodAnchorDay *int              `json:"periodAnchorDay"`
	StartDate       string            `json:"startDate"`
	EndDate         *string           `json:"endDate"`
	Currency        string            `json:"currency"`
	RolloverPolicy  string            `json:"rolloverPolicy"`
	IncludePlanned  *bool             `json:"includePlanned"`
	AlertThresholds []string          `json:"alertThresholds"`
	IsTemplate      *bool             `json:"isTemplate"`
	TemplateID      *uuid.UUID        `json:"templateId"`
	IsArchived      *bool             `json:"isArchived"`
	Allocations     []AllocationInput `json:"allocations"`
	Version         *int              `json:"version,omitempty"`
}

var rolloverPolicies = []string{"none", "carry_surplus", "carry_deficit", "carry_both"}

func (in *Input) validate(ctx context.Context, db fin.DB, profileID uuid.UUID) error {
	v := fin.Validator{}
	in.Name = strings.TrimSpace(in.Name)
	v.Check(in.Name != "" && len(in.Name) <= 200, "name", "required, at most 200 characters")
	v.Check(fin.OneOf(in.PeriodType, "weekly", "monthly", "quarterly", "yearly", "custom"), "periodType", "must be weekly, monthly, quarterly, yearly or custom")
	if in.PeriodAnchorDay == nil {
		one := 1
		in.PeriodAnchorDay = &one
	}
	v.Check(*in.PeriodAnchorDay >= 1 && *in.PeriodAnchorDay <= 31, "periodAnchorDay", "must be 1..31")
	start, err := fin.ParseDate(in.StartDate)
	v.Check(err == nil, "startDate", "must be YYYY-MM-DD")
	if in.EndDate != nil {
		end, err := fin.ParseDate(*in.EndDate)
		v.Check(err == nil && !end.Before(start), "endDate", "must be a date not before startDate")
	}
	v.Check(in.PeriodType != "custom" || in.EndDate != nil, "endDate", "custom periods need an end date")
	in.Currency = strings.ToUpper(in.Currency)
	_, ok := money.Scale(in.Currency)
	v.Check(ok, "currency", "unknown currency")
	if in.RolloverPolicy == "" {
		in.RolloverPolicy = "none"
	}
	v.Check(fin.OneOf(in.RolloverPolicy, rolloverPolicies...), "rolloverPolicy", "invalid rollover policy")
	if in.IncludePlanned == nil {
		t := true
		in.IncludePlanned = &t
	}
	if in.AlertThresholds == nil {
		in.AlertThresholds = []string{"0.8", "1.0"}
	}
	v.Check(len(in.AlertThresholds) <= 5, "alertThresholds", "at most 5")
	for _, t := range in.AlertThresholds {
		r, ok := new(big.Rat).SetString(t)
		v.Check(ok && r.Sign() > 0 && r.Cmp(big.NewRat(10, 1)) < 0 && len(t) <= 7, "alertThresholds", "fractions between 0 and 10, e.g. \"0.8\"")
	}
	seen := map[string]bool{}
	v.Check(len(in.Allocations) <= 500, "allocations", "at most 500")
	for i, a := range in.Allocations {
		f := fmt.Sprintf("allocations[%d]", i)
		v.Check(a.Amount != nil, f+".amount", "required")
		if a.Amount != nil {
			v.Check(a.Amount.Sign() >= 0, f+".amount", "must not be negative")
			v.Check(a.Amount.Currency() == in.Currency, f+".amount", "must use the budget currency")
		}
		if a.RolloverPolicy != nil {
			v.Check(fin.OneOf(*a.RolloverPolicy, rolloverPolicies...), f+".rolloverPolicy", "invalid rollover policy")
		}
		k := "-"
		if a.CategoryID != nil {
			k = a.CategoryID.String()
		}
		v.Check(!seen[k], f+".categoryId", "duplicate category")
		seen[k] = true
		if err := fin.CheckOwned(ctx, db, v, f+".categoryId", "categories", a.CategoryID, profileID); err != nil {
			return err
		}
	}
	if err := fin.CheckOwned(ctx, db, v, "templateId", "budgets", in.TemplateID, profileID); err != nil {
		return err
	}
	return v.Err()
}

const budgetCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, name, period_type, period_anchor_day,
	start_date, end_date, currency, rollover_policy, include_planned, alert_thresholds::text[], is_template, template_id, is_archived`

func scanBudget(row pgx.Row) (Budget, error) {
	var b Budget
	var start time.Time
	var end *time.Time
	err := row.Scan(&b.ID, &b.ProfileID, &b.Version, &b.ServerVersion, &b.CreatedAt, &b.UpdatedAt, &b.DeletedAt, &b.Name, &b.PeriodType,
		&b.PeriodAnchorDay, &start, &end, &b.Currency, &b.RolloverPolicy, &b.IncludePlanned, &b.AlertThresholds, &b.IsTemplate, &b.TemplateID, &b.IsArchived)
	b.StartDate, b.EndDate, b.Currency = fin.Fmt(start), fin.FmtPtr(end), strings.TrimSpace(b.Currency)
	for i, t := range b.AlertThresholds {
		b.AlertThresholds[i] = trimZeros(t)
	}
	return b, err
}

func trimZeros(s string) string {
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
		if !strings.Contains(s, ".") {
			s += ".0"
		}
	}
	return s
}

func loadAllocations(ctx context.Context, db fin.DB, b *Budget, periodID *uuid.UUID) ([]Allocation, error) {
	rows, err := db.Query(ctx, `SELECT id, budget_period_id, category_id, amount, currency, rollover_amount, rollover_policy FROM budget_allocations
		WHERE budget_id = $1 AND profile_id = $2 AND deleted_at IS NULL AND budget_period_id IS NOT DISTINCT FROM $3
		ORDER BY category_id NULLS FIRST, id`, b.ID, b.ProfileID, periodID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Allocation{}
	for rows.Next() {
		var a Allocation
		var amt, roll pgtype.Numeric
		var cur string
		if err := rows.Scan(&a.ID, &a.BudgetPeriodID, &a.CategoryID, &amt, &cur, &roll, &a.RolloverPolicy); err != nil {
			return nil, err
		}
		if a.Amount, err = fin.NumericMoney(amt, cur); err != nil {
			return nil, err
		}
		if a.RolloverAmount, err = fin.NumericMoney(roll, cur); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func Get(ctx context.Context, db fin.DB, profileID, id uuid.UUID) (Budget, error) {
	b, err := scanBudget(db.QueryRow(ctx, `SELECT `+budgetCols+` FROM budgets WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return b, httpx.NotFound("budget")
	}
	if err != nil {
		return b, err
	}
	b.Allocations, err = loadAllocations(ctx, db, &b, nil)
	return b, err
}

func List(ctx context.Context, db fin.DB, profileID, after uuid.UUID, limit int) ([]Budget, error) {
	rows, err := db.Query(ctx, `SELECT `+budgetCols+` FROM budgets WHERE profile_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, profileID, after, limit)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Budget, error) { return scanBudget(row) })
	if err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Allocations, err = loadAllocations(ctx, db, &out[i], nil); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func Create(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in Input) (Budget, error) {
	if err := in.validate(ctx, tx, profileID); err != nil {
		return Budget{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	isTemplate := in.IsTemplate != nil && *in.IsTemplate
	if _, err := tx.Exec(ctx, `INSERT INTO budgets (id, profile_id, name, period_type, period_anchor_day, start_date, end_date, currency,
		rollover_policy, include_planned, alert_thresholds, is_template, template_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric[],$12,$13)`,
		id, profileID, in.Name, in.PeriodType, *in.PeriodAnchorDay, in.StartDate, in.EndDate, in.Currency, in.RolloverPolicy, *in.IncludePlanned,
		in.AlertThresholds, isTemplate, in.TemplateID); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return Budget{}, httpx.Conflict("budget id already exists")
		}
		return Budget{}, err
	}
	if err := replaceAllocations(ctx, tx, profileID, id, in.Allocations); err != nil {
		return Budget{}, err
	}
	return record(ctx, tx, profileID, id, nil, "budget.create")
}

func Update(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Budget, in Input) (Budget, error) {
	if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
		return cur, err
	}
	if err := in.validate(ctx, tx, profileID); err != nil {
		return cur, err
	}
	archived := in.IsArchived != nil && *in.IsArchived
	isTemplate := in.IsTemplate != nil && *in.IsTemplate
	if _, err := tx.Exec(ctx, `UPDATE budgets SET name=$3, period_type=$4, period_anchor_day=$5, start_date=$6, end_date=$7, currency=$8,
		rollover_policy=$9, include_planned=$10, alert_thresholds=$11::numeric[], is_template=$12, template_id=$13, is_archived=$14, version = version + 1
		WHERE id = $1 AND profile_id = $2`, cur.ID, profileID, in.Name, in.PeriodType, *in.PeriodAnchorDay, in.StartDate, in.EndDate, in.Currency,
		in.RolloverPolicy, *in.IncludePlanned, in.AlertThresholds, isTemplate, in.TemplateID, archived); err != nil {
		return cur, err
	}
	if err := replaceAllocations(ctx, tx, profileID, cur.ID, in.Allocations); err != nil {
		return cur, err
	}
	return record(ctx, tx, profileID, cur.ID, cur, "budget.update")
}

// replaceAllocations swaps the default allocation set (tombstones the old rows).
func replaceAllocations(ctx context.Context, tx pgx.Tx, profileID, budgetID uuid.UUID, allocs []AllocationInput) error {
	if _, err := tx.Exec(ctx, `UPDATE budget_allocations SET deleted_at = now(), version = version + 1
		WHERE budget_id = $1 AND profile_id = $2 AND budget_period_id IS NULL AND deleted_at IS NULL`, budgetID, profileID); err != nil {
		return err
	}
	for _, a := range allocs {
		if _, err := tx.Exec(ctx, `INSERT INTO budget_allocations (profile_id, budget_id, category_id, amount, currency, rollover_policy)
			VALUES ($1,$2,$3,$4,$5,$6)`, profileID, budgetID, a.CategoryID, a.Amount.Numeric(), a.Amount.Currency(), a.RolloverPolicy); err != nil {
			return err
		}
	}
	return nil
}

func Delete(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur Budget) error {
	if _, err := tx.Exec(ctx, `UPDATE budgets SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "budgets", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "budget.delete"})
	return err
}

func record(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before any, action string) (Budget, error) {
	b, err := Get(ctx, tx, profileID, id)
	if err != nil {
		return b, err
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "budgets", EntityID: id, Op: changes.OpUpsert, Data: b, Before: before, Action: action})
	b.ServerVersion = v
	return b, err
}

// Instantiate creates a budget from a template (copying its settings and allocations).
func Instantiate(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, tpl Budget, name, startDate string) (Budget, error) {
	if !tpl.IsTemplate {
		return Budget{}, httpx.Unprocessable("budget is not a template")
	}
	if name == "" {
		name = tpl.Name
	}
	in := Input{Name: name, PeriodType: tpl.PeriodType, PeriodAnchorDay: &tpl.PeriodAnchorDay, StartDate: startDate, Currency: tpl.Currency,
		RolloverPolicy: tpl.RolloverPolicy, IncludePlanned: &tpl.IncludePlanned, AlertThresholds: tpl.AlertThresholds, TemplateID: &tpl.ID}
	if tpl.PeriodType == "custom" && tpl.EndDate != nil {
		// keep the template's period length
		days := fin.DaysBetween(fin.MustDate(tpl.StartDate), fin.MustDate(*tpl.EndDate))
		s, err := fin.ParseDate(startDate)
		if err != nil {
			return Budget{}, httpx.Validation(map[string]string{"startDate": "must be YYYY-MM-DD"})
		}
		e := fin.Fmt(s.AddDate(0, 0, days))
		in.EndDate = &e
	}
	for _, a := range tpl.Allocations {
		amt := a.Amount
		in.Allocations = append(in.Allocations, AllocationInput{CategoryID: a.CategoryID, Amount: &amt, RolloverPolicy: a.RolloverPolicy})
	}
	return Create(ctx, tx, profileID, in)
}

// ===== periods =====

// PeriodFor returns the budget period containing d. Monthly/quarterly/yearly periods start on the
// anchor day (clamped to the month length, e.g. salary day 31 -> Feb 28) counted from the start
// month; weekly periods are 7-day blocks from the start date; custom = [start, end]. The first
// period starts no earlier than the budget start; the last ends no later than its end.
func PeriodFor(b Budget, d time.Time) (time.Time, time.Time, bool) {
	start := fin.MustDate(b.StartDate)
	var end *time.Time
	if b.EndDate != nil {
		e := fin.MustDate(*b.EndDate)
		end = &e
	}
	if d.Before(start) || (end != nil && d.After(*end)) {
		return d, d, false
	}
	var ps, pe time.Time
	switch b.PeriodType {
	case "custom":
		return start, *end, true
	case "weekly":
		k := fin.DaysBetween(start, d) / 7
		ps = start.AddDate(0, 0, 7*k)
		pe = ps.AddDate(0, 0, 6)
	default:
		step := map[string]int{"monthly": 1, "quarterly": 3, "yearly": 12}[b.PeriodType]
		base := fin.Date(start.Year(), start.Month(), 1)
		months := (d.Year()-base.Year())*12 + int(d.Month()) - int(base.Month())
		k := months / step
		ps = fin.AddMonthsClamped(base, k*step, b.PeriodAnchorDay)
		if ps.After(d) {
			k--
			ps = fin.AddMonthsClamped(base, k*step, b.PeriodAnchorDay)
		}
		pe = fin.AddMonthsClamped(base, (k+1)*step, b.PeriodAnchorDay).AddDate(0, 0, -1)
	}
	if ps.Before(start) {
		ps = start
	}
	if end != nil && pe.After(*end) {
		pe = *end
	}
	return ps, pe, true
}

// ===== status: actual vs committed vs remaining =====

type Line struct {
	CategoryID           *uuid.UUID  `json:"categoryId"`
	Limit                money.Money `json:"limit"`
	RolloverIn           money.Money `json:"rolloverIn"`
	Actual               money.Money `json:"actual"`
	Planned              money.Money `json:"planned"`
	Remaining            money.Money `json:"remaining"`
	Utilization          *string     `json:"utilization"`
	ProjectedUtilization *string     `json:"projectedUtilization"`
	Alert                *string     `json:"alert"`
	rolloverPolicy       string
}

type Totals struct {
	Limit     money.Money `json:"limit"`
	Actual    money.Money `json:"actual"`
	Planned   money.Money `json:"planned"`
	Remaining money.Money `json:"remaining"`
}

// Status is OpenAPI BudgetStatus.
type Status struct {
	BudgetID     uuid.UUID         `json:"budgetId"`
	PeriodStart  string            `json:"periodStart"`
	PeriodEnd    string            `json:"periodEnd"`
	PeriodStatus string            `json:"periodStatus"`
	Lines        []Line            `json:"lines"`
	Totals       Totals            `json:"totals"`
	Complete     bool              `json:"complete"`
	MissingRates []fin.MissingRate `json:"missingRates"`
}

// ComputeStatus reports, per allocation, the completed spending (actual: expense splits minus
// refunds in the category or its subcategories), the still-open planned spending (committed:
// pending, unmatched expense occurrences due in the period — a matched occurrence counts only
// through its real transaction, never twice), and remaining = limit + rollover - actual - planned.
// Utilization = actual / (limit + rollover); alert = highest threshold reached by utilization.
// All amounts are valued in the budget currency at each transaction's booking-date rate.
func ComputeStatus(ctx context.Context, db fin.DB, b Budget, d, today time.Time) (Status, error) {
	ps, pe, ok := PeriodFor(b, d)
	if !ok {
		return Status{}, httpx.Validation(map[string]string{"date": "outside the budget's date range"})
	}
	st := Status{BudgetID: b.ID, PeriodStart: fin.Fmt(ps), PeriodEnd: fin.Fmt(pe), PeriodStatus: "open", Lines: []Line{}}
	var periodID *uuid.UUID
	var pstatus string
	err := db.QueryRow(ctx, `SELECT id, status FROM budget_periods WHERE budget_id = $1 AND profile_id = $2 AND start_date = $3 AND deleted_at IS NULL`,
		b.ID, b.ProfileID, ps).Scan(&periodID, &pstatus)
	if err == nil {
		st.PeriodStatus = pstatus
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return st, err
	}
	allocs := b.Allocations
	if periodID != nil {
		specific, err := loadAllocations(ctx, db, &b, periodID)
		if err != nil {
			return st, err
		}
		byCat := map[string]int{}
		for i, a := range allocs {
			byCat[catKey(a.CategoryID)] = i
		}
		allocs = append([]Allocation(nil), allocs...)
		for _, a := range specific {
			if i, ok := byCat[catKey(a.CategoryID)]; ok {
				allocs[i] = a
			} else {
				allocs = append(allocs, a)
			}
		}
	}
	cats, err := fin.Categories(ctx, db, b.ProfileID)
	if err != nil {
		return st, err
	}
	conv := fin.NewConverter(db, b.ProfileID)
	flows, err := fin.Flows(ctx, db, b.ProfileID, ps, pe, nil)
	if err != nil {
		return st, err
	}
	type valued struct {
		cat *uuid.UUID
		amt money.Money
	}
	var spent []valued
	for _, f := range flows {
		if f.Kind == "income" {
			continue
		}
		m, _, err := conv.Convert(ctx, f.Spending(), b.Currency, f.Date)
		if err != nil {
			return st, err
		}
		spent = append(spent, valued{f.CategoryID, m})
	}
	var committed []valued
	if b.IncludePlanned {
		occ, err := planning.Expand(ctx, db, b.ProfileID, ps, pe, today, nil)
		if err != nil {
			return st, err
		}
		for _, o := range occ {
			if o.Kind != "expense" || o.Resolved() {
				continue
			}
			on := o.Day
			if on.After(today) {
				on = today // future rates are unknown: value at today's rate
			}
			m, _, err := conv.Convert(ctx, o.Amount, b.Currency, on)
			if err != nil {
				return st, err
			}
			committed = append(committed, valued{o.CategoryID, m})
		}
	}
	match := func(lineCat *uuid.UUID, c *uuid.UUID) bool {
		return lineCat == nil || (c != nil && fin.IsWithin(cats, *c, *lineCat))
	}
	var overall *Line
	var tot Totals
	var tl, ta, tp, tr fin.Accumulator
	for _, a := range allocs {
		var act, plan fin.Accumulator
		for _, s := range spent {
			if match(a.CategoryID, s.cat) {
				act.Add(s.amt)
			}
		}
		for _, c := range committed {
			if match(a.CategoryID, c.cat) {
				plan.Add(c.amt)
			}
		}
		l := Line{CategoryID: a.CategoryID, Limit: a.Amount, RolloverIn: a.RolloverAmount, Actual: act.Money(b.Currency), Planned: plan.Money(b.Currency),
			rolloverPolicy: b.RolloverPolicy}
		if a.RolloverPolicy != nil {
			l.rolloverPolicy = *a.RolloverPolicy
		}
		avail, _ := l.Limit.Add(l.RolloverIn)
		rem, _ := avail.Sub(l.Actual)
		l.Remaining, _ = rem.Sub(l.Planned)
		if avail.Sign() > 0 {
			u := fin.Ratio(l.Actual, avail, 4)
			l.Utilization = &u
			proj, _ := l.Actual.Add(l.Planned)
			pu := fin.Ratio(proj, avail, 4)
			l.ProjectedUtilization = &pu
			l.Alert = highestThreshold(b.AlertThresholds, u)
		} else if l.Actual.Sign() > 0 && len(b.AlertThresholds) > 0 {
			l.Alert = highestThreshold(b.AlertThresholds, "1000000")
		}
		st.Lines = append(st.Lines, l)
		if a.CategoryID == nil {
			overall = &st.Lines[len(st.Lines)-1]
		} else {
			tl.Add(avail)
			ta.Add(l.Actual)
			tp.Add(l.Planned)
			tr.Add(l.Remaining)
		}
	}
	if overall != nil {
		avail, _ := overall.Limit.Add(overall.RolloverIn)
		tot = Totals{Limit: avail, Actual: overall.Actual, Planned: overall.Planned, Remaining: overall.Remaining}
	} else {
		tot = Totals{Limit: tl.Money(b.Currency), Actual: ta.Money(b.Currency), Planned: tp.Money(b.Currency), Remaining: tr.Money(b.Currency)}
	}
	st.Totals = tot
	st.Complete = conv.Complete()
	st.MissingRates = conv.Missing()
	return st, nil
}

func catKey(id *uuid.UUID) string {
	if id == nil {
		return "-"
	}
	return id.String()
}

func highestThreshold(ts []string, util string) *string {
	u, ok := new(big.Rat).SetString(util)
	if !ok {
		return nil
	}
	sorted := append([]string(nil), ts...)
	sort.Slice(sorted, func(i, j int) bool {
		a, _ := new(big.Rat).SetString(sorted[i])
		b, _ := new(big.Rat).SetString(sorted[j])
		return a.Cmp(b) < 0
	})
	var hit *string
	for _, t := range sorted {
		r, _ := new(big.Rat).SetString(t)
		if u.Cmp(r) >= 0 {
			v := t
			hit = &v
		}
	}
	return hit
}

// Carry returns the amount carried into the next period: leftover = limit + rolloverIn - actual,
// then carry_surplus keeps only a positive leftover, carry_deficit only a negative one (overspend
// reduces the next limit), carry_both keeps either, none carries nothing.
func Carry(policy string, limit, rolloverIn, actual money.Money) money.Money {
	avail, _ := limit.Add(rolloverIn)
	left, _ := avail.Sub(actual)
	switch {
	case policy == "carry_both",
		policy == "carry_surplus" && left.Sign() > 0,
		policy == "carry_deficit" && left.Sign() < 0:
		return left
	}
	return fin.Zero(limit.Currency())
}

// ClosePeriod closes the period containing d and writes the rollover into the next period.
func ClosePeriod(ctx context.Context, tx pgx.Tx, b Budget, d, today time.Time) (Status, error) {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM budgets WHERE id = $1 FOR UPDATE`, b.ID); err != nil {
		return Status{}, err
	}
	st, err := ComputeStatus(ctx, tx, b, d, today)
	if err != nil {
		return st, err
	}
	if st.PeriodStatus == "closed" {
		return st, httpx.Conflict("period is already closed")
	}
	ps, pe := fin.MustDate(st.PeriodStart), fin.MustDate(st.PeriodEnd)
	pid, err := upsertPeriod(ctx, tx, b, ps, pe, "closed")
	if err != nil {
		return st, err
	}
	_ = pid
	st.PeriodStatus = "closed"
	nextStart := pe.AddDate(0, 0, 1)
	ns, ne, ok := PeriodFor(b, nextStart)
	if !ok || b.PeriodType == "custom" {
		return st, recordBudgetTouch(ctx, tx, b, "budget.period_close")
	}
	nid, err := upsertPeriod(ctx, tx, b, ns, ne, "open")
	if err != nil {
		return st, err
	}
	defaults := map[string]Allocation{}
	for _, a := range b.Allocations {
		defaults[catKey(a.CategoryID)] = a
	}
	for _, l := range st.Lines {
		carry := Carry(l.rolloverPolicy, l.Limit, l.RolloverIn, l.Actual)
		limit := l.Limit
		if a, ok := defaults[catKey(l.CategoryID)]; ok {
			limit = a.Amount
		}
		if _, err := tx.Exec(ctx, `INSERT INTO budget_allocations (profile_id, budget_id, budget_period_id, category_id, amount, currency, rollover_amount)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (budget_id, budget_period_id, category_id) WHERE deleted_at IS NULL
			DO UPDATE SET rollover_amount = EXCLUDED.rollover_amount, version = budget_allocations.version + 1`,
			b.ProfileID, b.ID, nid, l.CategoryID, limit.Numeric(), b.Currency, carry.Numeric()); err != nil {
			return st, err
		}
	}
	return st, recordBudgetTouch(ctx, tx, b, "budget.period_close")
}

func upsertPeriod(ctx context.Context, tx pgx.Tx, b Budget, ps, pe time.Time, status string) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO budget_periods (profile_id, budget_id, start_date, end_date, status, closed_at)
		VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 = 'closed' THEN now() END)
		ON CONFLICT (budget_id, start_date) DO UPDATE SET status = EXCLUDED.status, closed_at = EXCLUDED.closed_at, end_date = EXCLUDED.end_date,
		  version = budget_periods.version + 1
		RETURNING id`, b.ProfileID, b.ID, ps, pe, status).Scan(&id)
	if err != nil {
		return id, err
	}
	snap := map[string]any{"id": id, "profileId": b.ProfileID, "budgetId": b.ID, "startDate": fin.Fmt(ps), "endDate": fin.Fmt(pe), "status": status}
	_, err = changes.Record(ctx, tx, changes.Change{ProfileID: b.ProfileID, EntityType: "budget_periods", EntityID: id, Op: changes.OpUpsert, Data: snap, Action: "budget_period." + status})
	return id, err
}

// recordBudgetTouch re-records the budget so clients pull its updated period allocations.
func recordBudgetTouch(ctx context.Context, tx pgx.Tx, b Budget, action string) error {
	if _, err := tx.Exec(ctx, `UPDATE budgets SET version = version + 1 WHERE id = $1`, b.ID); err != nil {
		return err
	}
	_, err := record(ctx, tx, b.ProfileID, b.ID, nil, action)
	return err
}

// Alert is a budget line that reached an alert threshold in the current period.
type Alert struct {
	Budget      Budget
	Line        Line
	PeriodStart string
}

// CurrentAlerts evaluates every active, non-template budget's current period.
func CurrentAlerts(ctx context.Context, db fin.DB, profileID uuid.UUID, today time.Time) ([]Alert, error) {
	all, err := List(ctx, db, profileID, uuid.Nil, 10_000)
	if err != nil {
		return nil, err
	}
	var out []Alert
	for _, b := range all {
		if b.IsTemplate || b.IsArchived {
			continue
		}
		if _, _, ok := PeriodFor(b, today); !ok {
			continue
		}
		st, err := ComputeStatus(ctx, db, b, today, today)
		if err != nil {
			return nil, err
		}
		for _, l := range st.Lines {
			if l.Alert != nil {
				out = append(out, Alert{Budget: b, Line: l, PeriodStart: st.PeriodStart})
			}
		}
	}
	return out, nil
}
