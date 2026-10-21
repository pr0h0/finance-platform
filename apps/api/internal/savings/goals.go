package savings

import (
	"context"
	"errors"
	"fmt"
	"math/big"
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

// Goal is the API shape (OpenAPI Goal). Progress ("saved"): with a dedicated account, the
// account balance (valued in the goal currency today); otherwise startingAmount + contributions
// (withdrawals negative), each valued on its contribution date.
type Goal struct {
	ID                  uuid.UUID    `json:"id"`
	ProfileID           uuid.UUID    `json:"profileId"`
	Version             int          `json:"version"`
	ServerVersion       int64        `json:"serverVersion"`
	CreatedAt           time.Time    `json:"createdAt"`
	UpdatedAt           time.Time    `json:"updatedAt"`
	DeletedAt           *time.Time   `json:"deletedAt"`
	Name                string       `json:"name"`
	Kind                string       `json:"kind"`
	TargetAmount        money.Money  `json:"targetAmount"`
	StartingAmount      money.Money  `json:"startingAmount"`
	TargetDate          *string      `json:"targetDate"`
	AccountID           *uuid.UUID   `json:"accountId"`
	EmergencyMonths     *int         `json:"emergencyMonths"`
	Priority            string       `json:"priority"`
	Status              string       `json:"status"`
	CompletedAt         *time.Time   `json:"completedAt"`
	Color               string       `json:"color"`
	Icon                string       `json:"icon"`
	Saved               money.Money  `json:"saved"`
	Progress            string       `json:"progress"`
	EstimatedCompletion *string      `json:"estimatedCompletion"`
	RequiredMonthly     *money.Money `json:"requiredMonthly"`
	OnTrack             bool         `json:"onTrack"`
	Basis               string       `json:"basis"`
}

type Input struct {
	ID              *uuid.UUID   `json:"id,omitempty"`
	Name            string       `json:"name"`
	Kind            string       `json:"kind"`
	TargetAmount    *money.Money `json:"targetAmount"`
	StartingAmount  *money.Money `json:"startingAmount"`
	TargetDate      *string      `json:"targetDate"`
	AccountID       *uuid.UUID   `json:"accountId"`
	EmergencyMonths *int         `json:"emergencyMonths"`
	Priority        string       `json:"priority"`
	Status          string       `json:"status"`
	Color           string       `json:"color"`
	Icon            string       `json:"icon"`
	Version         *int         `json:"version,omitempty"`
}

func (in *Input) validate(ctx context.Context, db fin.DB, profileID uuid.UUID) error {
	v := fin.Validator{}
	in.Name = strings.TrimSpace(in.Name)
	v.Check(in.Name != "" && len(in.Name) <= 200, "name", "required, at most 200 characters")
	if in.Kind == "" {
		in.Kind = "general"
	}
	v.Check(fin.OneOf(in.Kind, "general", "emergency_fund", "purchase", "debt_payoff"), "kind", "invalid kind")
	v.Check(in.TargetAmount != nil && in.TargetAmount.Sign() > 0, "targetAmount", "required and positive")
	if in.TargetAmount != nil {
		if in.StartingAmount == nil {
			z := fin.Zero(in.TargetAmount.Currency())
			in.StartingAmount = &z
		}
		v.Check(in.StartingAmount.Currency() == in.TargetAmount.Currency(), "startingAmount", "must use the goal currency")
	}
	if in.TargetDate != nil {
		_, err := fin.ParseDate(*in.TargetDate)
		v.Check(err == nil, "targetDate", "must be YYYY-MM-DD")
	}
	v.Check(in.EmergencyMonths == nil || (*in.EmergencyMonths >= 1 && *in.EmergencyMonths <= 36), "emergencyMonths", "must be 1..36")
	if in.Priority == "" {
		in.Priority = "normal"
	}
	v.Check(fin.OneOf(in.Priority, planning.Priorities...), "priority", "invalid priority")
	if in.Status == "" {
		in.Status = "active"
	}
	v.Check(fin.OneOf(in.Status, "active", "paused", "completed", "cancelled"), "status", "invalid status")
	v.Check(len(in.Color) <= 32 && len(in.Icon) <= 64, "icon", "too long")
	if err := fin.CheckOwned(ctx, db, v, "accountId", "accounts", in.AccountID, profileID); err != nil {
		return err
	}
	return v.Err()
}

const goalCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, name, kind, target_amount, starting_amount,
	currency, target_date, account_id, emergency_months, priority, status, completed_at, color, icon`

func scanGoal(row pgx.Row) (Goal, error) {
	var g Goal
	var target, start pgtype.Numeric
	var cur string
	var td *time.Time
	var em *int16
	err := row.Scan(&g.ID, &g.ProfileID, &g.Version, &g.ServerVersion, &g.CreatedAt, &g.UpdatedAt, &g.DeletedAt, &g.Name, &g.Kind, &target, &start,
		&cur, &td, &g.AccountID, &em, &g.Priority, &g.Status, &g.CompletedAt, &g.Color, &g.Icon)
	if err != nil {
		return g, err
	}
	if g.TargetAmount, err = fin.NumericMoney(target, cur); err != nil {
		return g, err
	}
	if g.StartingAmount, err = fin.NumericMoney(start, cur); err != nil {
		return g, err
	}
	g.TargetDate = fin.FmtPtr(td)
	if em != nil {
		n := int(*em)
		g.EmergencyMonths = &n
	}
	return g, nil
}

// Get loads a goal with its derived progress and projection.
func Get(ctx context.Context, db fin.DB, p fin.Profile, id uuid.UUID) (Goal, error) {
	g, err := scanGoal(db.QueryRow(ctx, `SELECT `+goalCols+` FROM savings_goals WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, p.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return g, httpx.NotFound("goal")
	}
	if err != nil {
		return g, err
	}
	return g, derive(ctx, db, p, &g)
}

func List(ctx context.Context, db fin.DB, p fin.Profile, after uuid.UUID, limit int) ([]Goal, error) {
	rows, err := db.Query(ctx, `SELECT `+goalCols+` FROM savings_goals WHERE profile_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, p.ID, after, limit)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Goal, error) { return scanGoal(row) })
	if err != nil {
		return nil, err
	}
	for i := range out {
		if err := derive(ctx, db, p, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Saved computes current progress (see Goal).
func Saved(ctx context.Context, db fin.DB, p fin.Profile, g Goal) (money.Money, bool, error) {
	cur := g.TargetAmount.Currency()
	conv := fin.NewConverter(db, p.ID)
	var acc fin.Accumulator
	if g.AccountID != nil {
		bals, err := fin.Balances(ctx, db, p.ID, p.Today)
		if err != nil {
			return fin.Zero(cur), false, err
		}
		for _, b := range bals {
			if b.AccountID == *g.AccountID {
				v, _, err := conv.Convert(ctx, b.Amount, cur, p.Today)
				if err != nil {
					return fin.Zero(cur), false, err
				}
				acc.Add(v)
			}
		}
		return acc.Money(cur), conv.Complete(), nil
	}
	acc.Add(g.StartingAmount)
	rows, err := db.Query(ctx, `SELECT amount, currency, contribution_date FROM savings_contributions
		WHERE goal_id = $1 AND profile_id = $2 AND deleted_at IS NULL`, g.ID, p.ID)
	if err != nil {
		return fin.Zero(cur), false, err
	}
	defer rows.Close()
	for rows.Next() {
		var n pgtype.Numeric
		var c string
		var d time.Time
		if err := rows.Scan(&n, &c, &d); err != nil {
			return fin.Zero(cur), false, err
		}
		m, err := fin.NumericMoney(n, c)
		if err != nil {
			return fin.Zero(cur), false, err
		}
		v, _, err := conv.Convert(ctx, m, cur, fin.AsDate(d))
		if err != nil {
			return fin.Zero(cur), false, err
		}
		acc.Add(v)
	}
	return acc.Money(cur), conv.Complete(), rows.Err()
}

// derive fills saved, progress and the completion projection (Feature 74):
//   - requiredMonthly: (target - saved) / whole months left until targetDate (at least 1), rounded up;
//   - estimatedCompletion: the date planned contributions (transfer/income plans into the goal's
//     account) reach the target; without such plans, the average net contribution of the last
//     6 months extrapolated monthly (basis "history"); none when that average is not positive;
//   - onTrack: estimate exists and is not after targetDate.
func derive(ctx context.Context, db fin.DB, p fin.Profile, g *Goal) error {
	cur := g.TargetAmount.Currency()
	saved, _, err := Saved(ctx, db, p, *g)
	if err != nil {
		return err
	}
	g.Saved = saved
	g.Progress = fin.Ratio(saved, g.TargetAmount, 4)
	remaining, _ := g.TargetAmount.Sub(saved)
	if remaining.Sign() <= 0 {
		d := fin.Fmt(p.Today)
		if g.CompletedAt != nil {
			d = fin.Fmt(*g.CompletedAt)
		}
		z := fin.Zero(cur)
		g.EstimatedCompletion, g.RequiredMonthly, g.OnTrack, g.Basis = &d, &z, true, "reached"
		return nil
	}
	if g.TargetDate != nil {
		td := fin.MustDate(*g.TargetDate)
		months := (td.Year()-p.Today.Year())*12 + int(td.Month()) - int(p.Today.Month())
		if td.Day() < p.Today.Day() {
			months--
		}
		months = max(months, 1)
		req, _ := money.FromMinor(money.DivRound(remaining.Minor(), big.NewInt(int64(months)), money.Ceiling), cur)
		g.RequiredMonthly = &req
	}
	if g.Status != "active" {
		g.Basis = "inactive"
		return nil
	}
	est, basis, err := estimate(ctx, db, p, *g, remaining)
	if err != nil {
		return err
	}
	g.EstimatedCompletion, g.Basis = est, basis
	g.OnTrack = est != nil && (g.TargetDate == nil || *est <= *g.TargetDate)
	return nil
}

func estimate(ctx context.Context, db fin.DB, p fin.Profile, g Goal, remaining money.Money) (*string, string, error) {
	cur := remaining.Currency()
	conv := fin.NewConverter(db, p.ID)
	if g.AccountID != nil {
		occ, err := planning.Expand(ctx, db, p.ID, p.Today, p.Today.AddDate(30, 0, 0), p.Today, nil)
		if err != nil {
			return nil, "", err
		}
		var acc fin.Accumulator
		planned := false
		for _, o := range occ {
			if o.Resolved() {
				continue
			}
			into := (o.Kind == "transfer" && o.ToAccountID != nil && *o.ToAccountID == *g.AccountID) ||
				(o.Kind == "income" && o.AccountID != nil && *o.AccountID == *g.AccountID)
			out := (o.Kind == "transfer" || o.Kind == "expense") && o.AccountID != nil && *o.AccountID == *g.AccountID
			if !into && !out {
				continue
			}
			planned = true
			v, _, err := conv.Convert(ctx, o.Amount, cur, p.Today)
			if err != nil {
				return nil, "", err
			}
			if out {
				v = v.Neg()
			}
			acc.Add(v)
			if c, _ := acc.Money(cur).Cmp(remaining); c >= 0 {
				d := o.Date
				return &d, "planned", nil
			}
		}
		if planned {
			return nil, "planned", nil
		}
	}
	// History: net contributions in the last 6 months.
	from := p.Today.AddDate(0, -6, 0)
	var acc fin.Accumulator
	rows, err := db.Query(ctx, `SELECT amount, currency, contribution_date FROM savings_contributions
		WHERE goal_id = $1 AND profile_id = $2 AND deleted_at IS NULL AND contribution_date > $3 AND contribution_date <= $4`, g.ID, p.ID, from, p.Today)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var n pgtype.Numeric
		var c string
		var d time.Time
		if err := rows.Scan(&n, &c, &d); err != nil {
			return nil, "", err
		}
		m, err := fin.NumericMoney(n, c)
		if err != nil {
			return nil, "", err
		}
		v, _, err := conv.Convert(ctx, m, cur, fin.AsDate(d))
		if err != nil {
			return nil, "", err
		}
		acc.Add(v)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	total := acc.Money(cur)
	if total.Sign() <= 0 {
		return nil, "history", nil
	}
	// months needed = ceil(remaining * 6 / total)
	months := money.DivRound(new(big.Int).Mul(remaining.Minor(), big.NewInt(6)), total.Minor(), money.Ceiling).Int64()
	if months > 1200 {
		return nil, "history", nil
	}
	d := fin.Fmt(fin.AddMonthsClamped(p.Today, int(months), p.Today.Day()))
	return &d, "history", nil
}

func Create(ctx context.Context, tx pgx.Tx, p fin.Profile, in Input) (Goal, error) {
	if err := in.validate(ctx, tx, p.ID); err != nil {
		return Goal{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	if _, err := tx.Exec(ctx, `INSERT INTO savings_goals (id, profile_id, name, kind, target_amount, starting_amount, currency, target_date,
		account_id, emergency_months, priority, status, color, icon) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		id, p.ID, in.Name, in.Kind, in.TargetAmount.Numeric(), in.StartingAmount.Numeric(), in.TargetAmount.Currency(), in.TargetDate, in.AccountID,
		in.EmergencyMonths, in.Priority, in.Status, in.Color, in.Icon); err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return Goal{}, httpx.Conflict("goal id already exists")
		}
		return Goal{}, err
	}
	return record(ctx, tx, p, id, nil, "goal.create")
}

func Update(ctx context.Context, tx pgx.Tx, p fin.Profile, cur Goal, in Input) (Goal, error) {
	if err := fin.CheckVersion(in.Version, cur.Version); err != nil {
		return cur, err
	}
	if err := in.validate(ctx, tx, p.ID); err != nil {
		return cur, err
	}
	if _, err := tx.Exec(ctx, `UPDATE savings_goals SET name=$3, kind=$4, target_amount=$5, starting_amount=$6, currency=$7, target_date=$8,
		account_id=$9, emergency_months=$10, priority=$11, status=$12, color=$13, icon=$14,
		completed_at = CASE WHEN $12 = 'completed' THEN coalesce(completed_at, now()) ELSE NULL END, version = version + 1
		WHERE id = $1 AND profile_id = $2`, cur.ID, p.ID, in.Name, in.Kind, in.TargetAmount.Numeric(), in.StartingAmount.Numeric(),
		in.TargetAmount.Currency(), in.TargetDate, in.AccountID, in.EmergencyMonths, in.Priority, in.Status, in.Color, in.Icon); err != nil {
		return cur, err
	}
	return record(ctx, tx, p, cur.ID, cur, "goal.update")
}

func Delete(ctx context.Context, tx pgx.Tx, p fin.Profile, cur Goal) error {
	if _, err := tx.Exec(ctx, `UPDATE savings_goals SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, cur.ID, p.ID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: p.ID, EntityType: "savings_goals", EntityID: cur.ID, Op: changes.OpDelete, Before: cur, Action: "goal.delete"})
	return err
}

func record(ctx context.Context, tx pgx.Tx, p fin.Profile, id uuid.UUID, before any, action string) (Goal, error) {
	g, err := Get(ctx, tx, p, id)
	if err != nil {
		return g, err
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: p.ID, EntityType: "savings_goals", EntityID: id, Op: changes.OpUpsert, Data: g, Before: before, Action: action})
	g.ServerVersion = v
	return g, err
}

// ===== contributions =====

type Contribution struct {
	ID               uuid.UUID   `json:"id"`
	ProfileID        uuid.UUID   `json:"profileId"`
	Version          int         `json:"version"`
	ServerVersion    int64       `json:"serverVersion"`
	CreatedAt        time.Time   `json:"createdAt"`
	UpdatedAt        time.Time   `json:"updatedAt"`
	DeletedAt        *time.Time  `json:"deletedAt"`
	GoalID           uuid.UUID   `json:"goalId"`
	Amount           money.Money `json:"amount"`
	ContributionDate string      `json:"contributionDate"`
	TransactionID    *uuid.UUID  `json:"transactionId"`
	Notes            string      `json:"notes"`
}

type ContributionInput struct {
	ID               *uuid.UUID   `json:"id,omitempty"`
	Amount           *money.Money `json:"amount"`
	ContributionDate string       `json:"contributionDate"`
	TransactionID    *uuid.UUID   `json:"transactionId"`
	Notes            string       `json:"notes"`
}

const contribCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, goal_id, amount, currency, contribution_date, transaction_id, notes`

func scanContrib(row pgx.Row) (Contribution, error) {
	var c Contribution
	var n pgtype.Numeric
	var cur string
	var d time.Time
	err := row.Scan(&c.ID, &c.ProfileID, &c.Version, &c.ServerVersion, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt, &c.GoalID, &n, &cur, &d, &c.TransactionID, &c.Notes)
	if err != nil {
		return c, err
	}
	c.ContributionDate = fin.Fmt(d)
	c.Amount, err = fin.NumericMoney(n, cur)
	return c, err
}

func Contributions(ctx context.Context, db fin.DB, profileID, goalID uuid.UUID) ([]Contribution, error) {
	rows, err := db.Query(ctx, `SELECT `+contribCols+` FROM savings_contributions WHERE goal_id = $1 AND profile_id = $2 AND deleted_at IS NULL
		ORDER BY contribution_date DESC, id`, goalID, profileID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Contribution, error) { return scanContrib(row) })
}

// AddContribution records a contribution (negative = withdrawal); reaching the target marks the
// goal completed.
func AddContribution(ctx context.Context, tx pgx.Tx, p fin.Profile, g Goal, in ContributionInput) (Contribution, error) {
	v := fin.Validator{}
	v.Check(in.Amount != nil && !in.Amount.IsZero(), "amount", "required and non-zero (negative = withdrawal)")
	if in.Amount != nil {
		v.Check(in.Amount.Currency() == g.TargetAmount.Currency(), "amount", "must use the goal currency")
	}
	_, err := fin.ParseDate(in.ContributionDate)
	v.Check(err == nil, "contributionDate", "must be YYYY-MM-DD")
	v.Check(len(in.Notes) <= 5000, "notes", "too long")
	if err := fin.CheckOwned(ctx, tx, v, "transactionId", "transactions", in.TransactionID, p.ID); err != nil {
		return Contribution{}, err
	}
	if err := v.Err(); err != nil {
		return Contribution{}, err
	}
	id := uuid.New()
	if in.ID != nil {
		id = *in.ID
	}
	c, err := scanContrib(tx.QueryRow(ctx, `INSERT INTO savings_contributions (id, profile_id, goal_id, amount, currency, contribution_date, transaction_id, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+contribCols, id, p.ID, g.ID, in.Amount.Numeric(), in.Amount.Currency(), in.ContributionDate, in.TransactionID, in.Notes))
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			return c, httpx.Conflict("contribution id already exists")
		}
		return c, err
	}
	sv, err := changes.Record(ctx, tx, changes.Change{ProfileID: p.ID, EntityType: "savings_contributions", EntityID: c.ID, Op: changes.OpUpsert, Data: c,
		Action: "goal.contribute", Metadata: map[string]any{"goal_id": g.ID.String()}})
	if err != nil {
		return c, err
	}
	c.ServerVersion = sv
	return c, completeIfReached(ctx, tx, p, g.ID)
}

func completeIfReached(ctx context.Context, tx pgx.Tx, p fin.Profile, goalID uuid.UUID) error {
	g, err := Get(ctx, tx, p, goalID)
	if err != nil || g.Status != "active" {
		return err
	}
	if c, _ := g.Saved.Cmp(g.TargetAmount); c < 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE savings_goals SET status = 'completed', completed_at = now(), version = version + 1 WHERE id = $1`, goalID); err != nil {
		return err
	}
	_, err = record(ctx, tx, p, goalID, g, "goal.complete")
	return err
}

func DeleteContribution(ctx context.Context, tx pgx.Tx, p fin.Profile, goalID, id uuid.UUID) error {
	c, err := scanContrib(tx.QueryRow(ctx, `SELECT `+contribCols+` FROM savings_contributions WHERE id = $1 AND goal_id = $2 AND profile_id = $3 AND deleted_at IS NULL`, id, goalID, p.ID))
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("contribution")
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE savings_contributions SET deleted_at = now(), version = version + 1 WHERE id = $1`, id); err != nil {
		return err
	}
	_, err = changes.Record(ctx, tx, changes.Change{ProfileID: p.ID, EntityType: "savings_contributions", EntityID: id, Op: changes.OpDelete, Before: c, Action: "goal.contribution_delete"})
	return err
}

// ===== emergency fund (Feature 75) =====

type EmergencyFund struct {
	Currency         string            `json:"currency"`
	Reserves         money.Money       `json:"reserves"`
	EssentialMonthly money.Money       `json:"essentialMonthly"`
	MonthsCovered    *string           `json:"monthsCovered"`
	TargetMonths     int               `json:"targetMonths"`
	Target           money.Money       `json:"target"`
	Shortfall        money.Money       `json:"shortfall"`
	ReservesBasis    string            `json:"reservesBasis"`
	ExpensesBasis    string            `json:"expensesBasis"`
	Assumptions      []string          `json:"assumptions"`
	Complete         bool              `json:"complete"`
	MissingRates     []fin.MissingRate `json:"missingRates"`
}

var liquidTypes = []string{"checking", "savings", "cash", "wallet", "prepaid"}

// Emergency estimates how many months reserves cover essential expenses.
//   - Reserves: progress of active emergency_fund goals; without such goals, the balances of all
//     liquid accounts (checking, savings, cash, wallet, prepaid).
//   - Essential monthly expenses: monthly equivalent of active recurring expense plans with
//     priority "essential"; without any, the average monthly spending of the last 6 full months.
func Emergency(ctx context.Context, db fin.DB, p fin.Profile, cur string) (EmergencyFund, error) {
	ef := EmergencyFund{Currency: cur, TargetMonths: 6}
	conv := fin.NewConverter(db, p.ID)
	var reserves fin.Accumulator
	goals, err := List(ctx, db, p, uuid.Nil, 10_000)
	if err != nil {
		return ef, err
	}
	for _, g := range goals {
		if g.Kind != "emergency_fund" || (g.Status != "active" && g.Status != "completed") {
			continue
		}
		v, _, err := conv.Convert(ctx, g.Saved, cur, p.Today)
		if err != nil {
			return ef, err
		}
		reserves.Add(v)
		ef.ReservesBasis = "emergency_fund_goals"
		if g.EmergencyMonths != nil {
			ef.TargetMonths = *g.EmergencyMonths
		}
	}
	if ef.ReservesBasis == "" {
		ef.ReservesBasis = "liquid_accounts"
		accs, err := fin.Accounts(ctx, db, p.ID)
		if err != nil {
			return ef, err
		}
		liquid := map[uuid.UUID]bool{}
		for _, a := range accs {
			liquid[a.ID] = !a.Archived && fin.OneOf(a.Type, liquidTypes...)
		}
		bals, err := fin.Balances(ctx, db, p.ID, p.Today)
		if err != nil {
			return ef, err
		}
		for _, b := range bals {
			if liquid[b.AccountID] {
				v, _, err := conv.Convert(ctx, b.Amount, cur, p.Today)
				if err != nil {
					return ef, err
				}
				reserves.Add(v)
			}
		}
	}
	ef.Reserves = reserves.Money(cur)

	var essential fin.Accumulator
	plans, err := planning.ListPlans(ctx, db, p.ID, uuid.Nil, 100_000, []string{"active"})
	if err != nil {
		return ef, err
	}
	for _, pl := range plans {
		if pl.Kind != "expense" || pl.Priority != "essential" || pl.Recurrence == nil {
			continue
		}
		if pl.Recurrence.EndDate != nil && fin.MustDate(*pl.Recurrence.EndDate).Before(p.Today) {
			continue
		}
		_, monthly, err := planning.Annualize(pl.Amount, pl.Recurrence.RRule)
		if err != nil {
			continue
		}
		v, _, err := conv.Convert(ctx, monthly, cur, p.Today)
		if err != nil {
			return ef, err
		}
		essential.Add(v)
		ef.ExpensesBasis = "essential_plans"
	}
	if ef.ExpensesBasis == "" {
		ef.ExpensesBasis = "average_spending_6_months"
		end := fin.MonthStart(p.Today).AddDate(0, 0, -1)
		start := fin.MonthStart(end).AddDate(0, -5, 0)
		flows, err := fin.Flows(ctx, db, p.ID, start, end, nil)
		if err != nil {
			return ef, err
		}
		var spent fin.Accumulator
		for _, f := range flows {
			v, _, err := conv.Convert(ctx, f.Spending(), cur, f.Date)
			if err != nil {
				return ef, err
			}
			spent.Add(v)
		}
		essential.Add(fin.MulRat(spent.Money(cur), 1, 6))
	}
	ef.EssentialMonthly = essential.Money(cur)
	if ef.EssentialMonthly.Sign() > 0 {
		m := fin.Ratio(ef.Reserves, ef.EssentialMonthly, 1)
		ef.MonthsCovered = &m
	}
	ef.Target = fin.MulRat(ef.EssentialMonthly, int64(ef.TargetMonths), 1)
	short, _ := ef.Target.Sub(ef.Reserves)
	if short.Sign() < 0 {
		short = fin.Zero(cur)
	}
	ef.Shortfall = short
	ef.Assumptions = []string{
		fmt.Sprintf("Reserves basis: %s; essential expenses basis: %s.", ef.ReservesBasis, ef.ExpensesBasis),
		"Mark recurring plans as priority \"essential\" to base the estimate on essential costs only.",
		"Months covered is an estimate; it ignores income during the period.",
	}
	ef.Complete = conv.Complete()
	ef.MissingRates = conv.Missing()
	return ef, nil
}
