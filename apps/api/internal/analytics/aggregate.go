package analytics

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// Definitions (docs/architecture/planning-analytics.md):
//   - spending = expense splits - refund splits (refunds reduce the refunded category);
//   - income = income splits;
//   - transfers, fx, opening balances and adjustments are neither (credit-card payments are
//     transfers, so card purchases count once); excluded/void/deleted transactions never count;
//   - savings rate = (income - spending) / income for the period; undefined when income is 0;
//   - every amount is valued in the reporting currency at its booking-date rate (fin.Converter);
//     amounts without a rate are excluded and reported in missingRates (complete = false).

// Query is the common analytics input.
type Query struct {
	P          fin.Profile
	From, To   time.Time
	Currency   string
	AccountIDs []uuid.UUID
	Interval   string // none | day | week | month | quarter | year
	GroupBy    string
}

// vflow is a flow valued in the reporting currency: Spend is the signed spending contribution
// (expense +, refund -), Income the income amount.
type vflow struct {
	fin.Flow
	Spend, Income money.Money
	Valued        bool
}

func loadFlows(ctx context.Context, db fin.DB, q Query, conv *fin.Converter) ([]vflow, error) {
	flows, err := fin.Flows(ctx, db, q.P.ID, q.From, q.To, q.AccountIDs)
	if err != nil {
		return nil, err
	}
	out := make([]vflow, 0, len(flows))
	for _, f := range flows {
		v := vflow{Flow: f, Spend: fin.Zero(q.Currency), Income: fin.Zero(q.Currency)}
		amt, ok, err := conv.Convert(ctx, f.Amount, q.Currency, f.Date)
		if err != nil {
			return nil, err
		}
		v.Valued = ok
		switch f.Kind {
		case "income":
			v.Income = amt
		case "expense":
			v.Spend = amt
		case "refund":
			v.Spend = amt.Neg()
		}
		out = append(out, v)
	}
	return out, nil
}

// PeriodKey names the period containing d.
func PeriodKey(interval string, d time.Time) string {
	switch interval {
	case "day":
		return fin.Fmt(d)
	case "week":
		y, w := d.ISOWeek()
		return fmt.Sprintf("%04d-W%02d", y, w)
	case "month":
		return d.Format("2006-01")
	case "quarter":
		return fmt.Sprintf("%04d-Q%d", d.Year(), (int(d.Month())-1)/3+1)
	case "year":
		return fmt.Sprintf("%04d", d.Year())
	}
	return ""
}

// Periods lists the period keys and their [start, end] covering [from, to] in order.
func Periods(interval string, from, to time.Time) []Period {
	if interval == "" || interval == "none" {
		return []Period{{"", from, to}}
	}
	var out []Period
	for d := from; !d.After(to); {
		var end time.Time
		switch interval {
		case "day":
			end = d
		case "week":
			end = d.AddDate(0, 0, 7-isoWeekday(d))
		case "month":
			end = fin.MonthEnd(d)
		case "quarter":
			q := (int(d.Month()) - 1) / 3
			end = fin.MonthEnd(fin.Date(d.Year(), time.Month(q*3+3), 1))
		case "year":
			end = fin.Date(d.Year(), 12, 31)
		}
		if end.After(to) {
			end = to
		}
		out = append(out, Period{PeriodKey(interval, d), d, end})
		d = end.AddDate(0, 0, 1)
	}
	return out
}

type Period struct {
	Key        string
	Start, End time.Time
}

func isoWeekday(t time.Time) int {
	if wd := int(t.Weekday()); wd != 0 {
		return wd
	}
	return 7
}

var validIntervals = []string{"", "none", "day", "week", "month", "quarter", "year"}

func newRows(q Query) fin.Rows {
	return fin.Rows{Currency: q.Currency, From: fin.Fmt(q.From), To: fin.Fmt(q.To), Rows: []fin.Row{}, Warnings: []string{}}
}

func catLabel(cats map[uuid.UUID]fin.Category, id *uuid.UUID) (string, string) {
	if id == nil {
		return "uncategorized", "Uncategorized"
	}
	if c, ok := cats[*id]; ok {
		return id.String(), c.Name
	}
	return id.String(), "Unknown category"
}

// SpendingByCategory: groupBy "category" (default; each category's own spending, parentKey set)
// or "parent" (subcategories rolled up into their top-level category).
func SpendingByCategory(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	flows, err := loadFlows(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	cats, err := fin.Categories(ctx, db, q.P.ID)
	if err != nil {
		return res, err
	}
	type key struct{ period, cat string }
	sums := map[key]*fin.Accumulator{}
	counts := map[key]int{}
	var order []key
	var total fin.Accumulator
	for _, f := range flows {
		if f.Kind == "income" || !f.Valued {
			continue
		}
		cid := f.CategoryID
		if q.GroupBy == "parent" && cid != nil {
			root := fin.Root(cats, *cid)
			cid = &root
		}
		k, _ := catLabel(cats, cid)
		kk := key{PeriodKey(q.Interval, f.Date), k}
		if sums[kk] == nil {
			sums[kk] = &fin.Accumulator{}
			order = append(order, kk)
		}
		sums[kk].Add(f.Spend)
		counts[kk]++
		total.Add(f.Spend)
	}
	sort.SliceStable(order, func(i, j int) bool {
		if order[i].period != order[j].period {
			return order[i].period < order[j].period
		}
		return cmpM(sums[order[j]].Money(q.Currency), sums[order[i]].Money(q.Currency)) < 0
	})
	for _, k := range order {
		row := fin.Row{Key: k.cat, Amount: sums[k].Money(q.Currency), Count: counts[k], Period: k.period}
		if k.cat == "uncategorized" {
			row.Label = "Uncategorized"
		} else {
			id := uuid.MustParse(k.cat)
			_, row.Label = catLabel(cats, &id)
			if c, ok := cats[id]; ok && c.ParentID != nil && q.GroupBy != "parent" {
				p := c.ParentID.String()
				row.ParentKey = &p
			}
		}
		res.Rows = append(res.Rows, row)
	}
	res.Total = total.Money(q.Currency)
	res.Finish(conv)
	return res, nil
}

var digits = regexp.MustCompile(`[0-9#*/\\._-]+`)
var spaces = regexp.MustCompile(`\s+`)

// NormalizeMerchant derives a grouping key from a payee/description without a merchant: lower
// case, digits/reference noise removed, whitespace collapsed (e.g. "KONZUM 123 SARAJEVO" ->
// "konzum sarajevo").
func NormalizeMerchant(s string) string {
	s = strings.ToLower(s)
	s = digits.ReplaceAllString(s, " ")
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

// SpendingByMerchant groups spending by merchant (merchant aliases are merged by the merchants
// module into one merchant id); transactions without a merchant group by normalized payee or
// description ("name:<normalized>").
func SpendingByMerchant(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	flows, err := loadFlows(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	names, err := merchantNames(ctx, db, q.P.ID)
	if err != nil {
		return res, err
	}
	type key struct{ period, k string }
	sums := map[key]*fin.Accumulator{}
	counts := map[key]int{}
	labels := map[string]string{}
	var order []key
	var total fin.Accumulator
	for _, f := range flows {
		if f.Kind == "income" || !f.Valued {
			continue
		}
		var k, label string
		if f.MerchantID != nil {
			k, label = f.MerchantID.String(), names[*f.MerchantID]
		} else {
			src := f.Payee
			if src == "" {
				src = f.Description
			}
			n := NormalizeMerchant(src)
			if n == "" {
				n = "unknown"
			}
			k, label = "name:"+n, src
		}
		kk := key{PeriodKey(q.Interval, f.Date), k}
		if sums[kk] == nil {
			sums[kk] = &fin.Accumulator{}
			order = append(order, kk)
			labels[k] = label
		}
		sums[kk].Add(f.Spend)
		counts[kk]++
		total.Add(f.Spend)
	}
	sort.SliceStable(order, func(i, j int) bool {
		if order[i].period != order[j].period {
			return order[i].period < order[j].period
		}
		return cmpM(sums[order[j]].Money(q.Currency), sums[order[i]].Money(q.Currency)) < 0
	})
	for _, k := range order {
		res.Rows = append(res.Rows, fin.Row{Key: k.k, Label: labels[k.k], Amount: sums[k].Money(q.Currency), Count: counts[k], Period: k.period})
	}
	res.Total = total.Money(q.Currency)
	res.Finish(conv)
	return res, nil
}

func merchantNames(ctx context.Context, db fin.DB, profileID uuid.UUID) (map[uuid.UUID]string, error) {
	rows, err := db.Query(ctx, `SELECT id, name FROM merchants WHERE profile_id = $1`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uuid.UUID]string{}
	for rows.Next() {
		var id uuid.UUID
		var n string
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// Totals per period.
type periodTotals struct {
	Period
	Income, Spending money.Money
	Count            int
}

func totalsByPeriod(ctx context.Context, db fin.DB, q Query, conv *fin.Converter) ([]periodTotals, error) {
	flows, err := loadFlows(ctx, db, q, conv)
	if err != nil {
		return nil, err
	}
	periods := Periods(q.Interval, q.From, q.To)
	out := make([]periodTotals, len(periods))
	idx := map[string]int{}
	inc := make([]fin.Accumulator, len(periods))
	spd := make([]fin.Accumulator, len(periods))
	for i, p := range periods {
		out[i].Period = p
		idx[p.Key] = i
	}
	for _, f := range flows {
		if !f.Valued {
			continue
		}
		i := idx[PeriodKey(q.Interval, f.Date)]
		inc[i].Add(f.Income)
		spd[i].Add(f.Spend)
		out[i].Count++
	}
	for i := range out {
		out[i].Income, out[i].Spending = inc[i].Money(q.Currency), spd[i].Money(q.Currency)
	}
	return out, nil
}

// IncomeVsExpenses: rows "<period>:income", "<period>:expenses", "<period>:net" per interval
// (default month); total = net over the whole range.
func IncomeVsExpenses(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	if q.Interval == "" || q.Interval == "none" {
		q.Interval = "month"
	}
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	pts, err := totalsByPeriod(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	var net fin.Accumulator
	for _, p := range pts {
		n, _ := p.Income.Sub(p.Spending)
		net.Add(n)
		res.Rows = append(res.Rows,
			fin.Row{Key: p.Key + ":income", Label: "Income", Period: p.Key, Amount: p.Income},
			fin.Row{Key: p.Key + ":expenses", Label: "Expenses", Period: p.Key, Amount: p.Spending},
			fin.Row{Key: p.Key + ":net", Label: "Net cash flow", Period: p.Key, Amount: n, Count: p.Count})
	}
	res.Total = net.Money(q.Currency)
	res.Finish(conv)
	return res, nil
}

// SavingsRate: per period, amount = income - spending, value = savings rate (4 decimals) or
// absent when income is zero.
func SavingsRate(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	if q.Interval == "" {
		q.Interval = "month"
	}
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	pts, err := totalsByPeriod(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	var inc, spd fin.Accumulator
	for _, p := range pts {
		n, _ := p.Income.Sub(p.Spending)
		row := fin.Row{Key: p.Key, Label: "Savings", Period: p.Key, Amount: n, Count: p.Count, Actual: fin.Ptr(p.Income), Planned: nil}
		if r := fin.Ratio(n, p.Income, 4); r != "" && p.Income.Sign() > 0 {
			row.Value = &r
		}
		inc.Add(p.Income)
		spd.Add(p.Spending)
		res.Rows = append(res.Rows, row)
	}
	n, _ := inc.Money(q.Currency).Sub(spd.Money(q.Currency))
	res.Total = n
	if r := fin.Ratio(n, inc.Money(q.Currency), 4); r != "" && inc.Money(q.Currency).Sign() > 0 {
		res.Rows = append(res.Rows, fin.Row{Key: "total", Label: "Savings rate (whole range)", Amount: n, Value: &r, Actual: fin.Ptr(inc.Money(q.Currency))})
	}
	res.Finish(conv)
	return res, nil
}

// Trends: spending per interval (default month) with change vs the previous period; groupBy
// "category" splits the series per top-level category.
func Trends(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	if q.Interval == "" || q.Interval == "none" {
		q.Interval = "month"
	}
	if q.GroupBy == "category" {
		q.GroupBy = "parent"
		res, err := SpendingByCategory(ctx, db, q)
		if err != nil {
			return res, err
		}
		prev := map[string]money.Money{}
		for i := range res.Rows {
			r := &res.Rows[i]
			if p, ok := prev[r.Key]; ok {
				pp := p
				r.Previous = &pp
				r.Change = change(r.Amount, p)
			}
			prev[r.Key] = r.Amount
		}
		return res, nil
	}
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	pts, err := totalsByPeriod(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	var total fin.Accumulator
	for i, p := range pts {
		row := fin.Row{Key: p.Key, Label: "Spending", Period: p.Key, Amount: p.Spending, Count: p.Count}
		if i > 0 {
			prev := pts[i-1].Spending
			row.Previous = &prev
			row.Change = change(p.Spending, prev)
		}
		total.Add(p.Spending)
		res.Rows = append(res.Rows, row)
	}
	res.Total = total.Money(q.Currency)
	if len(pts) > 0 && pts[len(pts)-1].End.After(q.P.Today) {
		res.Warnings = append(res.Warnings, "the last period is not over yet")
	}
	res.Finish(conv)
	return res, nil
}

func change(cur, prev money.Money) *string {
	if prev.IsZero() {
		return nil
	}
	d, _ := cur.Sub(prev)
	r := fin.Ratio(d, prev.Abs(), 4)
	return &r
}

// Compare compares [from, to] with [compareFrom, compareTo] (default: the preceding period of
// the same length, or the same dates one year earlier with mode=year_ago), grouped by top-level
// category (groupBy=category, default), merchant, or as totals (groupBy=total).
func Compare(ctx context.Context, db fin.DB, q Query, prevFrom, prevTo time.Time) (fin.Rows, error) {
	run := func(from, to time.Time) (fin.Rows, error) {
		qq := q
		qq.From, qq.To, qq.Interval = from, to, "none"
		switch q.GroupBy {
		case "merchant":
			return SpendingByMerchant(ctx, db, qq)
		case "total":
			r, err := IncomeVsExpenses(ctx, db, Query{P: q.P, From: from, To: to, Currency: q.Currency, AccountIDs: q.AccountIDs, Interval: "none"})
			if err != nil {
				return r, err
			}
			var rows []fin.Row
			for _, x := range r.Rows {
				x.Key, x.Period = strings.TrimPrefix(x.Key, ":"), ""
				rows = append(rows, x)
			}
			r.Rows = rows
			return r, nil
		default:
			qq.GroupBy = "parent"
			return SpendingByCategory(ctx, db, qq)
		}
	}
	cur, err := run(q.From, q.To)
	if err != nil {
		return cur, err
	}
	prev, err := run(prevFrom, prevTo)
	if err != nil {
		return cur, err
	}
	prevBy := map[string]fin.Row{}
	for _, r := range prev.Rows {
		prevBy[r.Key] = r
	}
	seen := map[string]bool{}
	for i := range cur.Rows {
		r := &cur.Rows[i]
		seen[r.Key] = true
		p := fin.Zero(q.Currency)
		if pr, ok := prevBy[r.Key]; ok {
			p = pr.Amount
		}
		r.Previous = &p
		r.Change = change(r.Amount, p)
		r.Period = PeriodLabel(q.From, q.To)
	}
	for _, pr := range prev.Rows {
		if !seen[pr.Key] {
			p := pr.Amount
			cur.Rows = append(cur.Rows, fin.Row{Key: pr.Key, Label: pr.Label, Amount: fin.Zero(q.Currency), Previous: &p, Change: change(fin.Zero(q.Currency), p), Period: PeriodLabel(q.From, q.To)})
		}
	}
	cur.Warnings = append(cur.Warnings, prev.Warnings...)
	cur.MissingRates = append(cur.MissingRates, prev.MissingRates...)
	cur.Complete = cur.Complete && prev.Complete
	cur.Warnings = append(cur.Warnings, fmt.Sprintf("compared with %s..%s (previous total %s)", fin.Fmt(prevFrom), fin.Fmt(prevTo), prev.Total.Amount()))
	return cur, nil
}

func PeriodLabel(from, to time.Time) string { return fin.Fmt(from) + ".." + fin.Fmt(to) }

// RecurringCosts lists active recurring expense plans (including subscriptions) as monthly
// (amount) and annual equivalents, valued at today's rate; total = monthly total.
func RecurringCosts(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	plans, err := planning.ListPlans(ctx, db, q.P.ID, uuid.Nil, 100_000, []string{"active"})
	if err != nil {
		return res, err
	}
	var monthlyTotal, annualTotal fin.Accumulator
	for _, p := range plans {
		if p.Kind != "expense" || p.Recurrence == nil {
			continue
		}
		if p.Recurrence.EndDate != nil && fin.MustDate(*p.Recurrence.EndDate).Before(q.P.Today) {
			continue
		}
		annual, monthly, err := planning.Annualize(p.Amount, p.Recurrence.RRule)
		if err != nil {
			continue
		}
		m, _, err := conv.Convert(ctx, monthly, q.Currency, q.P.Today)
		if err != nil {
			return res, err
		}
		a, _, err := conv.Convert(ctx, annual, q.Currency, q.P.Today)
		if err != nil {
			return res, err
		}
		monthlyTotal.Add(m)
		annualTotal.Add(a)
		r, _ := recurrence.Parse(p.Recurrence.RRule)
		res.Rows = append(res.Rows, fin.Row{Key: p.ID.String(), Label: p.Description, Amount: m, Allocated: &a, Native: fin.Ptr(p.Amount),
			Period: strings.ToLower(r.Freq), Value: fin.Ptr(p.Priority)})
	}
	sort.SliceStable(res.Rows, func(i, j int) bool { return cmpM(res.Rows[j].Amount, res.Rows[i].Amount) < 0 })
	res.Total = monthlyTotal.Money(q.Currency)
	res.Rows = append(res.Rows, fin.Row{Key: "total", Label: "Total", Amount: res.Total, Allocated: fin.Ptr(annualTotal.Money(q.Currency)), Count: len(res.Rows)})
	res.Warnings = append(res.Warnings, "amount = monthly equivalent, allocated = annual equivalent; valued at today's exchange rate")
	res.Finish(conv)
	return res, nil
}

// NetWorth: at the end of each period (default month), assets (asset accounts) and liabilities
// (liability accounts, shown as the positive amount owed) of accounts included in net worth,
// valued at that date's rate. net = assets - liabilities. Ordinary spending is not involved.
func NetWorth(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	if q.Interval == "" || q.Interval == "none" {
		q.Interval = "month"
	}
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	accs, err := fin.Accounts(ctx, db, q.P.ID)
	if err != nil {
		return res, err
	}
	class := map[uuid.UUID]string{}
	for _, a := range accs {
		if a.IncludeNetWorth {
			class[a.ID] = a.Classification
		}
	}
	var last money.Money
	for _, p := range Periods(q.Interval, q.From, q.To) {
		bals, err := fin.Balances(ctx, db, q.P.ID, p.End)
		if err != nil {
			return res, err
		}
		var assets, liabilities fin.Accumulator
		for _, b := range bals {
			c, ok := class[b.AccountID]
			if !ok {
				continue
			}
			v, _, err := conv.Convert(ctx, b.Amount, q.Currency, p.End)
			if err != nil {
				return res, err
			}
			if c == "asset" {
				assets.Add(v)
			} else {
				liabilities.Sub(v)
			}
		}
		a, l := assets.Money(q.Currency), liabilities.Money(q.Currency)
		n, _ := a.Sub(l)
		last = n
		res.Rows = append(res.Rows,
			fin.Row{Key: p.Key + ":assets", Label: "Assets", Period: p.Key, Amount: a, Value: fin.Ptr(fin.Fmt(p.End))},
			fin.Row{Key: p.Key + ":liabilities", Label: "Liabilities", Period: p.Key, Amount: l, Value: fin.Ptr(fin.Fmt(p.End))},
			fin.Row{Key: p.Key + ":net", Label: "Net worth", Period: p.Key, Amount: n, Value: fin.Ptr(fin.Fmt(p.End))})
	}
	res.Total = last
	if res.Total.Currency() == "" {
		res.Total = fin.Zero(q.Currency)
	}
	res.Finish(conv)
	return res, nil
}

// CurrencyExposure: balances per currency on `to` (native), their value and share of the total.
func CurrencyExposure(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	accs, err := fin.Accounts(ctx, db, q.P.ID)
	if err != nil {
		return res, err
	}
	include := map[uuid.UUID]bool{}
	for _, a := range accs {
		include[a.ID] = a.IncludeNetWorth && a.Classification == "asset"
	}
	bals, err := fin.Balances(ctx, db, q.P.ID, q.To)
	if err != nil {
		return res, err
	}
	native := map[string]*fin.Accumulator{}
	var curs []string
	for _, b := range bals {
		if !include[b.AccountID] {
			continue
		}
		c := b.Amount.Currency()
		if native[c] == nil {
			native[c] = &fin.Accumulator{}
			curs = append(curs, c)
		}
		native[c].Add(b.Amount)
	}
	sort.Strings(curs)
	var total fin.Accumulator
	for _, c := range curs {
		n := native[c].Money(c)
		v, _, err := conv.Convert(ctx, n, q.Currency, q.To)
		if err != nil {
			return res, err
		}
		total.Add(v)
		res.Rows = append(res.Rows, fin.Row{Key: c, Label: c, Amount: v, Native: &n})
	}
	res.Total = total.Money(q.Currency)
	for i := range res.Rows {
		if s := fin.Ratio(res.Rows[i].Amount, res.Total, 4); s != "" {
			res.Rows[i].Value = &s
		}
	}
	res.Warnings = append(res.Warnings, "asset accounts included in net worth; value = share of total")
	res.Finish(conv)
	return res, nil
}

// MonthlySummary: income, expenses, net cash flow, savings rate and upcoming bills of a month.
func MonthlySummary(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	q.From, q.To = fin.MonthStart(q.From), fin.MonthEnd(q.From)
	q.Interval = "none"
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	pts, err := totalsByPeriod(ctx, db, q, conv)
	if err != nil {
		return res, err
	}
	p := pts[0]
	net, _ := p.Income.Sub(p.Spending)
	res.Rows = append(res.Rows,
		fin.Row{Key: "income", Label: "Income", Amount: p.Income},
		fin.Row{Key: "expenses", Label: "Expenses", Amount: p.Spending},
		fin.Row{Key: "net", Label: "Net cash flow", Amount: net, Count: p.Count})
	if r := fin.Ratio(net, p.Income, 4); r != "" && p.Income.Sign() > 0 {
		res.Rows = append(res.Rows, fin.Row{Key: "savingsRate", Label: "Savings rate", Amount: net, Value: &r})
	}
	// Remaining planned bills in the month (unmatched, from today).
	start := q.From
	if q.P.Today.After(start) {
		start = q.P.Today
	}
	if !start.After(q.To) {
		occ, err := planning.Expand(ctx, db, q.P.ID, start, q.To, q.P.Today, nil)
		if err != nil {
			return res, err
		}
		var bills fin.Accumulator
		n := 0
		for _, o := range occ {
			if o.Kind == "expense" && !o.Resolved() {
				v, _, err := conv.Convert(ctx, o.Amount, q.Currency, q.P.Today)
				if err != nil {
					return res, err
				}
				bills.Add(v)
				n++
			}
		}
		res.Rows = append(res.Rows, fin.Row{Key: "upcomingBills", Label: "Upcoming planned expenses", Amount: bills.Money(q.Currency), Count: n})
	}
	res.Total = net
	res.Finish(conv)
	return res, nil
}

// ConversionFees sums recorded currency-conversion fees (currency_conversions.fee_amount) per
// period, valued at the conversion date. Spreads hidden in bank rates are not estimated.
func ConversionFees(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	if q.Interval == "" {
		q.Interval = "month"
	}
	res := newRows(q)
	conv := fin.NewConverter(db, q.P.ID)
	rows, err := db.Query(ctx, `SELECT cc.rate_date, cc.fee_amount, cc.fee_currency, cc.from_currency || '/' || cc.to_currency
		FROM currency_conversions cc LEFT JOIN transactions t ON t.id = cc.transaction_id
		WHERE cc.profile_id = $1 AND cc.fee_amount IS NOT NULL AND cc.fee_amount <> 0 AND cc.rate_date BETWEEN $2 AND $3
		  AND (t.id IS NULL OR (t.deleted_at IS NULL AND t.status <> 'void'))
		ORDER BY cc.rate_date`, q.P.ID, q.From, q.To)
	if err != nil {
		return res, err
	}
	type item struct {
		d    time.Time
		m    money.Money
		pair string
	}
	var items []item
	for rows.Next() {
		var d time.Time
		var n pgtype.Numeric
		var cur *string
		var pair string
		if err := rows.Scan(&d, &n, &cur, &pair); err != nil {
			rows.Close()
			return res, err
		}
		if cur == nil {
			continue
		}
		m, err := fin.NumericMoney(n, *cur)
		if err != nil {
			rows.Close()
			return res, err
		}
		items = append(items, item{fin.AsDate(d), m, pair})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	type key struct{ period, pair string }
	sums := map[key]*fin.Accumulator{}
	counts := map[key]int{}
	var order []key
	var total fin.Accumulator
	for _, it := range items {
		v, ok, err := conv.Convert(ctx, it.m, q.Currency, it.d)
		if err != nil {
			return res, err
		}
		if !ok {
			continue
		}
		k := key{PeriodKey(q.Interval, it.d), it.pair}
		if sums[k] == nil {
			sums[k] = &fin.Accumulator{}
			order = append(order, k)
		}
		sums[k].Add(v)
		counts[k]++
		total.Add(v)
	}
	for _, k := range order {
		res.Rows = append(res.Rows, fin.Row{Key: k.pair, Label: k.pair + " conversion fees", Period: k.period, Amount: sums[k].Money(q.Currency), Count: counts[k]})
	}
	res.Total = total.Money(q.Currency)
	res.Finish(conv)
	return res, nil
}

// ImportCoverage reports, per account, which date ranges are covered by committed imports and
// the gaps between them (Feature 127): incomplete history is stated, never hidden.
func ImportCoverage(ctx context.Context, db fin.DB, q Query) (fin.Rows, error) {
	res := newRows(q)
	res.Total = fin.Zero(q.Currency)
	accs, err := fin.Accounts(ctx, db, q.P.ID)
	if err != nil {
		return res, err
	}
	rows, err := db.Query(ctx, `SELECT account_id, coverage_start, coverage_end FROM import_batches
		WHERE profile_id = $1 AND status = 'committed' AND deleted_at IS NULL AND account_id IS NOT NULL
		  AND coverage_start IS NOT NULL AND coverage_end IS NOT NULL
		ORDER BY account_id, coverage_start`, q.P.ID)
	if err != nil {
		return res, err
	}
	type span struct{ s, e time.Time }
	spans := map[uuid.UUID][]span{}
	for rows.Next() {
		var id uuid.UUID
		var s, e time.Time
		if err := rows.Scan(&id, &s, &e); err != nil {
			rows.Close()
			return res, err
		}
		spans[id] = append(spans[id], span{fin.AsDate(s), fin.AsDate(e)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}
	for _, a := range accs {
		ss := spans[a.ID]
		if len(ss) == 0 {
			res.Rows = append(res.Rows, fin.Row{Key: a.ID.String(), Label: a.Name, Amount: fin.Zero(q.Currency), Value: fin.Ptr("no imports")})
			continue
		}
		merged := []span{ss[0]}
		for _, s := range ss[1:] {
			last := &merged[len(merged)-1]
			if !s.s.After(last.e.AddDate(0, 0, 1)) {
				if s.e.After(last.e) {
					last.e = s.e
				}
				continue
			}
			res.Gap(fmt.Sprintf("%s: no statement covers %s..%s", a.Name, fin.Fmt(last.e.AddDate(0, 0, 1)), fin.Fmt(s.s.AddDate(0, 0, -1))))
			merged = append(merged, s)
		}
		var parts []string
		days := 0
		for _, m := range merged {
			parts = append(parts, PeriodLabel(m.s, m.e))
			days += fin.DaysBetween(m.s, m.e) + 1
		}
		res.Rows = append(res.Rows, fin.Row{Key: a.ID.String(), Label: a.Name, Amount: fin.Zero(q.Currency), Count: len(ss),
			Period: strings.Join(parts, ","), Value: fin.Ptr(fmt.Sprintf("%d", days))})
	}
	res.Finish(fin.NewConverter(db, q.P.ID))
	return res, nil
}

func cmpM(a, b money.Money) int {
	c, _ := a.Cmp(b)
	return c
}
