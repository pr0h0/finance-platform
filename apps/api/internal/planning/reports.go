package planning

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
)

// MatchedAmounts returns the amount each transaction moved in the direction of the plan kind
// (expense/transfer: |negative postings|, income: positive postings), keyed by transaction id.
func MatchedAmounts(ctx context.Context, db fin.DB, profileID uuid.UUID, ids []uuid.UUID) (map[uuid.UUID]TxnAmount, error) {
	out := map[uuid.UUID]TxnAmount{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := db.Query(ctx, `SELECT t.id, t.kind, t.booking_date, p.amount, p.currency
		FROM transactions t JOIN postings p ON p.transaction_id = t.id AND p.deleted_at IS NULL
		WHERE t.profile_id = $1 AND t.id = ANY($2) AND t.deleted_at IS NULL AND t.status <> 'void'
		ORDER BY t.id, p.line_no`, profileID, ids)
	if err != nil {
		return nil, fmt.Errorf("matched amounts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var kind, cur string
		var day time.Time
		var n pgtype.Numeric
		if err := rows.Scan(&id, &kind, &day, &n, &cur); err != nil {
			return nil, err
		}
		m, err := fin.NumericMoney(n, cur)
		if err != nil {
			return nil, err
		}
		if (kind == "income") != (m.Sign() > 0) {
			continue
		}
		if _, ok := out[id]; !ok {
			out[id] = TxnAmount{Date: fin.AsDate(day), Amount: m.Abs()}
		}
	}
	return out, rows.Err()
}

type TxnAmount struct {
	Date   time.Time
	Amount money.Money
}

// PlannedVsActual compares each occurrence in [from, to] with what was actually recorded.
// actual = matched transaction amount; paid_manual = the planned amount (assumed paid as planned);
// pending past due = 0 (missed or not yet recorded); pending future = no actual yet. Skipped
// occurrences are omitted. Values are in the reporting currency at each date's rate.
func PlannedVsActual(ctx context.Context, db fin.DB, p fin.Profile, from, to time.Time, cur string) (fin.Rows, error) {
	res := fin.Rows{Currency: cur, From: fin.Fmt(from), To: fin.Fmt(to)}
	conv := fin.NewConverter(db, p.ID)
	occ, err := Expand(ctx, db, p.ID, from, to, p.Today, []string{"active", "paused", "completed", "cancelled"})
	if err != nil {
		return res, err
	}
	var ids []uuid.UUID
	for _, o := range occ {
		if o.MatchedTransactionID != nil {
			ids = append(ids, *o.MatchedTransactionID)
		}
	}
	matched, err := MatchedAmounts(ctx, db, p.ID, ids)
	if err != nil {
		return res, err
	}
	var plannedTotal, actualTotal fin.Accumulator
	for _, o := range occ {
		if o.Status == "skipped" || o.Kind == "transfer" {
			continue
		}
		planned, _, err := conv.Convert(ctx, o.Amount, cur, o.Day)
		if err != nil {
			return res, err
		}
		row := fin.Row{Key: o.PlannedTransactionID.String() + "/" + o.NominalDate, Label: o.Description, Period: o.Date, Count: 1,
			Planned: fin.Ptr(planned), Amount: fin.Zero(cur), Value: fin.Ptr(o.Kind)}
		var actual *money.Money
		switch {
		case o.Status == "matched" && o.MatchedTransactionID != nil:
			if t, ok := matched[*o.MatchedTransactionID]; ok {
				a, _, err := conv.Convert(ctx, t.Amount, cur, t.Date)
				if err != nil {
					return res, err
				}
				actual = &a
			} else {
				res.Gap(fmt.Sprintf("matched transaction for %q on %s is deleted or void", o.Description, o.Date))
			}
		case o.Status == "paid_manual":
			actual = &planned
		case o.Day.Before(p.Today):
			z := fin.Zero(cur)
			actual = &z
		}
		plannedTotal.Add(planned)
		if actual != nil {
			v, _ := actual.Sub(planned)
			row.Actual, row.Variance, row.Amount = actual, &v, *actual
			actualTotal.Add(*actual)
		}
		res.Rows = append(res.Rows, row)
	}
	res.Total = actualTotal.Money(cur)
	res.Rows = append(res.Rows, fin.Row{Key: "total", Label: "Total", Amount: res.Total, Count: len(res.Rows), Planned: fin.Ptr(plannedTotal.Money(cur))})
	res.Finish(conv)
	return res, nil
}

// Annual returns per-month scheduled income and expenses for a year plus a smoothed expense
// allocation (Feature 38): plans recurring less often than monthly (yearly, quarterly, one-off)
// are spread evenly over the 12 months (largest-remainder, exact), so annual bills can be reserved
// for monthly. Rows: key "YYYY-MM:expense" (amount = scheduled, allocated = smoothed) and
// "YYYY-MM:income".
func Annual(ctx context.Context, db fin.DB, p fin.Profile, year int, cur string) (fin.Rows, error) {
	from, to := fin.Date(year, 1, 1), fin.Date(year, 12, 31)
	res := fin.Rows{Currency: cur, From: fin.Fmt(from), To: fin.Fmt(to)}
	conv := fin.NewConverter(db, p.ID)
	plans, err := ListPlans(ctx, db, p.ID, uuid.Nil, 100_000, []string{"active", "completed"})
	if err != nil {
		return res, err
	}
	occ, err := ExpandPlans(ctx, db, p.ID, plans, from, to, p.Today)
	if err != nil {
		return res, err
	}
	irregular := map[uuid.UUID]bool{}
	for _, pl := range plans {
		irregular[pl.ID] = true
		if pl.Recurrence != nil {
			if r, err := recurrence.Parse(pl.Recurrence.RRule); err == nil {
				n, d := recurrence.PerYear(r)
				irregular[pl.ID] = n < 12*d
			}
		}
	}
	var sched, smooth, income [12]fin.Accumulator
	var counts [12]int
	var pool fin.Accumulator
	var total fin.Accumulator
	for _, o := range occ {
		if o.Status == "skipped" || o.Kind == "transfer" {
			continue
		}
		m := int(o.Day.Month()) - 1
		v, _, err := conv.Convert(ctx, o.Amount, cur, o.Day)
		if err != nil {
			return res, err
		}
		if o.Kind == "income" {
			income[m].Add(v)
			continue
		}
		sched[m].Add(v)
		counts[m]++
		total.Add(v)
		if irregular[o.PlannedTransactionID] {
			pool.Add(v)
		} else {
			smooth[m].Add(v)
		}
	}
	weights := make([]string, 12)
	for i := range weights {
		weights[i] = "1"
	}
	spread, err := pool.Money(cur).Allocate(weights)
	if err != nil {
		return res, err
	}
	for m := 0; m < 12; m++ {
		smooth[m].Add(spread[m])
		period := fmt.Sprintf("%04d-%02d", year, m+1)
		res.Rows = append(res.Rows,
			fin.Row{Key: period + ":expense", Label: "Planned expenses", Period: period, Amount: sched[m].Money(cur), Count: counts[m], Allocated: fin.Ptr(smooth[m].Money(cur))},
			fin.Row{Key: period + ":income", Label: "Planned income", Period: period, Amount: income[m].Money(cur)})
	}
	res.Total = total.Money(cur)
	res.Finish(conv)
	return res, nil
}
