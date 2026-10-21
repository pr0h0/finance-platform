package analytics

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/forecasting"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
)

// ===== unusual expenses (Feature 65) =====

// Anomaly is a flagged expense with a human-readable explanation.
type Anomaly struct {
	TransactionID uuid.UUID   `json:"transactionId"`
	Date          string      `json:"date"`
	Description   string      `json:"description"`
	Amount        money.Money `json:"amount"`
	CategoryID    *uuid.UUID  `json:"categoryId"`
	MerchantID    *uuid.UUID  `json:"merchantId"`
	Rule          string      `json:"rule"`
	Explanation   string      `json:"explanation"`
	Baseline      money.Money `json:"baseline"`
	Dismissed     bool        `json:"dismissed"`
}

// Anomaly rules (transparent, deterministic; amounts in the reporting currency):
//   - large_for_category: an expense of a category above 3x the median of that category's
//     expenses in the previous 180 days (needs >= 5 earlier expenses).
//   - new_merchant_large: the first expense at a merchant/payee seen in the previous 365 days
//     that is above 2x the median of all expenses of the previous 180 days (needs >= 10).
const (
	ruleCategory    = "large_for_category"
	ruleNewMerchant = "new_merchant_large"
)

type txnSpend struct {
	id       uuid.UUID
	date     time.Time
	desc     string
	cat      *uuid.UUID
	merchant *uuid.UUID
	key      string // merchant grouping key
	amount   money.Money
}

func expensesByTxn(ctx context.Context, db fin.DB, q Query, conv *fin.Converter) ([]txnSpend, error) {
	flows, err := loadFlows(ctx, db, q, conv)
	if err != nil {
		return nil, err
	}
	idx := map[uuid.UUID]int{}
	var out []txnSpend
	for _, f := range flows {
		if f.Kind != "expense" || !f.Valued {
			continue
		}
		if i, ok := idx[f.TransactionID]; ok {
			s, _ := out[i].amount.Add(f.Spend)
			out[i].amount = s
			if out[i].cat == nil {
				out[i].cat = f.CategoryID // first categorized split names the transaction
			}
			continue
		}
		key := "name:" + NormalizeMerchant(f.Payee+" "+f.Description)
		if f.MerchantID != nil {
			key = f.MerchantID.String()
		}
		idx[f.TransactionID] = len(out)
		out = append(out, txnSpend{id: f.TransactionID, date: f.Date, desc: f.Description, cat: f.CategoryID, merchant: f.MerchantID, key: key, amount: f.Spend})
	}
	return out, nil
}

func median(xs []*big.Int) *big.Int {
	s := append([]*big.Int(nil), xs...)
	sort.Slice(s, func(i, j int) bool { return s[i].Cmp(s[j]) < 0 })
	n := len(s)
	if n%2 == 1 {
		return new(big.Int).Set(s[n/2])
	}
	sum := new(big.Int).Add(s[n/2-1], s[n/2])
	return money.DivRound(sum, big.NewInt(2), money.HalfUp)
}

// Anomalies evaluates the rules for expenses booked in [from, to].
func Anomalies(ctx context.Context, db fin.DB, q Query, includeDismissed bool) ([]Anomaly, error) {
	conv := fin.NewConverter(db, q.P.ID)
	hq := q
	hq.From = q.From.AddDate(0, 0, -365)
	all, err := expensesByTxn(ctx, db, hq, conv)
	if err != nil {
		return nil, err
	}
	dismissed := map[string]bool{}
	rows, err := db.Query(ctx, `SELECT transaction_id, rule FROM anomaly_dismissals WHERE profile_id = $1 AND deleted_at IS NULL`, q.P.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var rule string
		if err := rows.Scan(&id, &rule); err != nil {
			rows.Close()
			return nil, err
		}
		dismissed[id.String()+rule] = true
	}
	rows.Close()
	out := []Anomaly{}
	cur := q.Currency
	for i, t := range all {
		if t.date.Before(q.From) || t.amount.Sign() <= 0 {
			continue
		}
		var catHist, allHist []*big.Int
		seen := false
		for _, h := range all[:i] {
			age := fin.DaysBetween(h.date, t.date)
			if h.key == t.key && age <= 365 {
				seen = true
			}
			if age > 180 || h.amount.Sign() <= 0 {
				continue
			}
			allHist = append(allHist, h.amount.Minor())
			if t.cat != nil && h.cat != nil && *h.cat == *t.cat {
				catHist = append(catHist, h.amount.Minor())
			}
		}
		add := func(rule, expl string, base *big.Int) {
			if dismissed[t.id.String()+rule] && !includeDismissed {
				return
			}
			b, _ := money.FromMinor(base, cur)
			out = append(out, Anomaly{TransactionID: t.id, Date: fin.Fmt(t.date), Description: t.desc, Amount: t.amount, CategoryID: t.cat,
				MerchantID: t.merchant, Rule: rule, Explanation: expl, Baseline: b, Dismissed: dismissed[t.id.String()+rule]})
		}
		if len(catHist) >= 5 {
			med := median(catHist)
			if med.Sign() > 0 && t.amount.Minor().Cmp(new(big.Int).Mul(med, big.NewInt(3))) > 0 {
				m, _ := money.FromMinor(med, cur)
				add(ruleCategory, fmt.Sprintf("%s is more than 3x the typical amount (median %s) for this category over the previous 180 days (%d expenses).",
					t.amount, m, len(catHist)), med)
			}
		}
		if !seen && len(allHist) >= 10 {
			med := median(allHist)
			if med.Sign() > 0 && t.amount.Minor().Cmp(new(big.Int).Mul(med, big.NewInt(2))) > 0 {
				m, _ := money.FromMinor(med, cur)
				add(ruleNewMerchant, fmt.Sprintf("First payment to this merchant in a year, and %s is more than 2x your typical expense (median %s).", t.amount, m), med)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Date > out[j].Date })
	return out, nil
}

// DismissAnomaly records (or with undo=true removes) a dismissal; syncable user state.
func DismissAnomaly(ctx context.Context, tx pgx.Tx, profileID, txnID uuid.UUID, rule string, undo bool) error {
	if !fin.OneOf(rule, ruleCategory, ruleNewMerchant) {
		return httpx.Validation(map[string]string{"rule": "unknown rule"})
	}
	ok, err := fin.Owned(ctx, tx, "transactions", txnID, profileID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("transaction")
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM anomaly_dismissals WHERE profile_id = $1 AND transaction_id = $2 AND rule = $3 AND deleted_at IS NULL FOR UPDATE`,
		profileID, txnID, rule).Scan(&id)
	exists := err == nil
	if err != nil && err != pgx.ErrNoRows {
		return err
	}
	p, _ := principalUser(ctx)
	switch {
	case undo && exists:
		if _, err := tx.Exec(ctx, `UPDATE anomaly_dismissals SET deleted_at = now(), version = version + 1 WHERE id = $1`, id); err != nil {
			return err
		}
		_, err = changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "anomaly_dismissals", EntityID: id, Op: changes.OpDelete, Action: "anomaly.undismiss"})
		return err
	case !undo && !exists:
		id = uuid.New()
		if _, err := tx.Exec(ctx, `INSERT INTO anomaly_dismissals (id, profile_id, transaction_id, rule, dismissed_by) VALUES ($1,$2,$3,$4,$5)`, id, profileID, txnID, rule, p); err != nil {
			return err
		}
		_, err = changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "anomaly_dismissals", EntityID: id, Op: changes.OpUpsert,
			Data: map[string]any{"id": id, "profileId": profileID, "transactionId": txnID, "rule": rule}, Action: "anomaly.dismiss"})
		return err
	}
	return nil // already in the requested state (idempotent)
}

// ===== deterministic insights (Feature 64) =====

type Insight struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"`
	Severity string         `json:"severity"`
	Title    string         `json:"title"`
	Body     string         `json:"body"`
	Data     map[string]any `json:"data"`
}

// Insights runs fixed, explainable checks; no AI is involved. Thresholds are in the bodies.
func Insights(ctx context.Context, db fin.DB, p fin.Profile, cur string) ([]Insight, error) {
	out := []Insight{}
	today := p.Today
	lastStart := fin.MonthStart(today).AddDate(0, -1, 0)
	lastEnd := fin.MonthEnd(lastStart)
	baseStart := lastStart.AddDate(0, -3, 0)
	q := Query{P: p, From: baseStart, To: lastEnd, Currency: cur, Interval: "month", GroupBy: "parent"}

	// 1. category spikes: last full month vs the average of the 3 months before it.
	byCat, err := SpendingByCategory(ctx, db, q)
	if err != nil {
		return nil, err
	}
	lastKey := PeriodKey("month", lastStart)
	type acc struct {
		last money.Money
		base fin.Accumulator
		name string
	}
	cats := map[string]*acc{}
	for _, r := range byCat.Rows {
		a := cats[r.Key]
		if a == nil {
			a = &acc{last: fin.Zero(cur), name: r.Label}
			cats[r.Key] = a
		}
		if r.Period == lastKey {
			a.last = r.Amount
		} else {
			a.base.Add(r.Amount)
		}
	}
	minDiff, _ := money.Parse("50", cur)
	keys := make([]string, 0, len(cats))
	for k := range cats {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		a := cats[k]
		avg := fin.MulRat(a.base.Money(cur), 1, 3)
		if avg.Sign() <= 0 {
			continue
		}
		diff, _ := a.last.Sub(avg)
		ratio := fin.Ratio(diff, avg, 4)
		r, _ := new(big.Rat).SetString(ratio)
		if r.Cmp(big.NewRat(1, 4)) >= 0 && cmpM(diff, minDiff) >= 0 {
			out = append(out, Insight{ID: "category_spike:" + k + ":" + lastKey, Kind: "category_spike", Severity: "warning",
				Title: fmt.Sprintf("%s spending up %s%%", a.name, pct(ratio)),
				Body:  fmt.Sprintf("In %s you spent %s on %s, %s more than the 3-month average of %s (rule: >= 25%% and >= %s above average).", lastKey, a.last, a.name, diff, avg, minDiff),
				Data:  map[string]any{"categoryKey": k, "period": lastKey, "amount": a.last, "average": avg, "change": ratio}})
		}
	}

	// 2. savings rate of the last full month vs the 3 before.
	sr, err := SavingsRate(ctx, db, Query{P: p, From: baseStart, To: lastEnd, Currency: cur, Interval: "month"})
	if err != nil {
		return nil, err
	}
	var lastRate *string
	for _, r := range sr.Rows {
		if r.Period == lastKey {
			lastRate = r.Value
		}
	}
	if lastRate != nil {
		sev := "info"
		if (*lastRate)[0] == '-' {
			sev = "warning"
		}
		out = append(out, Insight{ID: "savings_rate:" + lastKey, Kind: "savings_rate", Severity: sev,
			Title: fmt.Sprintf("Savings rate %s%% in %s", pct(*lastRate), lastKey),
			Body:  "Savings rate = (income - spending) / income. Transfers between your accounts are not counted.",
			Data:  map[string]any{"period": lastKey, "rate": *lastRate}})
	}

	// 3. forecast shortfalls in the next 30 days.
	f, err := forecasting.Build(ctx, db, p, forecasting.Options{Days: 30, Currency: cur})
	if err != nil {
		return nil, err
	}
	for _, s := range f.Shortfalls {
		if s.Scenario != "expected" {
			continue
		}
		acct := "your accounts"
		if s.AccountID != nil {
			acct = "an account"
		}
		out = append(out, Insight{ID: "shortfall:" + fmt.Sprint(s.AccountID) + ":" + s.Date, Kind: "forecast_shortfall", Severity: "critical",
			Title: "Projected negative balance on " + s.Date,
			Body:  fmt.Sprintf("The expected forecast takes %s down to %s on %s. Move money or reschedule planned payments.", acct, s.Amount, s.Date),
			Data:  map[string]any{"date": s.Date, "amount": s.Amount, "accountId": s.AccountID}})
		break
	}

	// 4. bills due in the next 7 days.
	occ, err := planning.Expand(ctx, db, p.ID, today, today.AddDate(0, 0, 7), today, nil)
	if err != nil {
		return nil, err
	}
	conv := fin.NewConverter(db, p.ID)
	var bills fin.Accumulator
	n := 0
	for _, o := range occ {
		if o.Kind == "expense" && !o.Resolved() {
			v, _, err := conv.Convert(ctx, o.Amount, cur, today)
			if err != nil {
				return nil, err
			}
			bills.Add(v)
			n++
		}
	}
	if n > 0 {
		out = append(out, Insight{ID: "upcoming_bills:" + fin.Fmt(today), Kind: "upcoming_bills", Severity: "info",
			Title: fmt.Sprintf("%d planned payment(s) in the next 7 days", n),
			Body:  fmt.Sprintf("Total %s due by %s.", bills.Money(cur), fin.Fmt(today.AddDate(0, 0, 7))),
			Data:  map[string]any{"count": n, "total": bills.Money(cur)}})
	}

	// 5. recurring cost total.
	rc, err := RecurringCosts(ctx, db, Query{P: p, From: today, To: today, Currency: cur})
	if err != nil {
		return nil, err
	}
	if len(rc.Rows) > 1 {
		annual := rc.Rows[len(rc.Rows)-1].Allocated
		out = append(out, Insight{ID: "recurring_costs:" + lastKey, Kind: "recurring_costs", Severity: "info",
			Title: fmt.Sprintf("Recurring costs: %s per month", rc.Total),
			Body:  fmt.Sprintf("%d recurring expense(s) add up to %s per year.", len(rc.Rows)-1, annual),
			Data:  map[string]any{"monthly": rc.Total, "annual": annual}})
	}

	// 6. uncategorized expenses in the last 90 days.
	var uncategorized int
	if err := db.QueryRow(ctx, `SELECT count(DISTINCT t.id) FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id AND s.deleted_at IS NULL
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.kind = 'expense' AND s.category_id IS NULL AND t.booking_date > $2`,
		p.ID, today.AddDate(0, 0, -90)).Scan(&uncategorized); err != nil {
		return nil, err
	}
	if uncategorized > 0 {
		out = append(out, Insight{ID: "uncategorized:" + fin.Fmt(today), Kind: "uncategorized", Severity: "info",
			Title: fmt.Sprintf("%d uncategorized expense(s)", uncategorized),
			Body:  "Categorize them (or add a rule) so budgets and reports are accurate.",
			Data:  map[string]any{"count": uncategorized}})
	}

	// 7. budget alerts.
	alerts, err := budgets.CurrentAlerts(ctx, db, p.ID, today)
	if err != nil {
		return nil, err
	}
	for _, a := range alerts {
		sev := "warning"
		if r, _ := new(big.Rat).SetString(*a.Line.Alert); r.Cmp(big.NewRat(1, 1)) >= 0 {
			sev = "critical"
		}
		out = append(out, Insight{ID: fmt.Sprintf("budget:%s:%s:%v:%s", a.Budget.ID, a.PeriodStart, a.Line.CategoryID, *a.Line.Alert), Kind: "budget_alert", Severity: sev,
			Title: fmt.Sprintf("%s: %s%% used", a.Budget.Name, pct(*a.Line.Utilization)),
			Body:  fmt.Sprintf("Spent %s of %s (threshold %s%%). Committed planned spending: %s.", a.Line.Actual, a.Line.Limit, pct(*a.Line.Alert), a.Line.Planned),
			Data:  map[string]any{"budgetId": a.Budget.ID, "categoryId": a.Line.CategoryID, "utilization": *a.Line.Utilization}})
	}

	// 8. data completeness.
	if !byCat.Complete || !f.Complete {
		out = append(out, Insight{ID: "incomplete:" + fin.Fmt(today), Kind: "incomplete_data", Severity: "warning",
			Title: "Some amounts could not be converted",
			Body:  "Exchange rates are missing for some dates; totals exclude those amounts until rates are added.",
			Data:  map[string]any{"missingRates": append(byCat.MissingRates, f.MissingRates...)}})
	}
	return out, nil
}

func pct(ratio string) string {
	r, ok := new(big.Rat).SetString(ratio)
	if !ok {
		return ratio
	}
	return r.Mul(r, big.NewRat(100, 1)).FloatString(1)
}
