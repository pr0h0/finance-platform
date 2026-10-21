package imports

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Coverage statuses (Feature 127).
const (
	CovComplete    = "complete"    // statement balances reconcile with the file and with the ledger
	CovUnverified  = "unverified"  // imported, but no statement balances to verify against
	CovConflicting = "conflicting" // balances present but the file or the ledger does not reconcile
	CovPartial     = "partial"     // (months only) some days covered, some missing
	CovMissing     = "missing"     // no committed import covers the days
)

type DateRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type Segment struct {
	DateRange
	Status string `json:"status"`
}

type MonthStatus struct {
	Month  string `json:"month"` // YYYY-MM
	Status string `json:"status"`
}

type AccountCoverage struct {
	AccountID uuid.UUID     `json:"accountId"`
	Name      string        `json:"name"`
	From      string        `json:"from"`
	To        string        `json:"to"`
	Segments  []Segment     `json:"segments"`
	Months    []MonthStatus `json:"months"`
	Covered   []DateRange   `json:"covered"`
	Gaps      []DateRange   `json:"gaps"`
}

var statusRank = map[string]int{CovMissing: 0, CovUnverified: 1, CovComplete: 2, CovConflicting: 3}

// Coverage computes per-account import coverage between from and to (inclusive). Zero from means
// the account's opening date or first import; zero to means today. accountIDs nil = all accounts.
func Coverage(ctx context.Context, q Querier, profileID uuid.UUID, accountIDs []uuid.UUID, from, to time.Time) ([]AccountCoverage, error) {
	if to.IsZero() {
		to = time.Now().UTC().Truncate(24 * time.Hour)
	}
	rows, err := q.Query(ctx, `SELECT a.id, a.name, a.opening_date,
		coalesce(json_agg(json_build_object('s', b.coverage_start, 'e', b.coverage_end, 'stats', b.stats)) FILTER (WHERE b.id IS NOT NULL), '[]')
		FROM accounts a LEFT JOIN import_batches b ON b.account_id = a.id AND b.status = 'committed' AND b.deleted_at IS NULL
			AND b.coverage_start IS NOT NULL AND b.coverage_end IS NOT NULL
		WHERE a.profile_id = $1 AND a.deleted_at IS NULL AND ($2::uuid[] IS NULL OR a.id = ANY($2))
		GROUP BY a.id ORDER BY a.sort_order, a.name, a.id`, profileID, accountIDs)
	if err != nil {
		return nil, fmt.Errorf("coverage: %w", err)
	}
	defer rows.Close()
	out := []AccountCoverage{}
	for rows.Next() {
		var ac AccountCoverage
		var opening *time.Time
		var batchesJSON []byte
		if err := rows.Scan(&ac.AccountID, &ac.Name, &opening, &batchesJSON); err != nil {
			return nil, err
		}
		var batches []struct {
			S, E  string
			Stats Stats
		}
		if err := json.Unmarshal(batchesJSON, &batches); err != nil {
			return nil, err
		}
		start := from
		if start.IsZero() {
			if opening != nil {
				start = *opening
			}
			for _, b := range batches {
				if s, err := time.Parse(time.DateOnly, b.S); err == nil && (start.IsZero() || s.Before(start)) {
					start = s
				}
			}
		}
		ac.Segments, ac.Months, ac.Covered, ac.Gaps = []Segment{}, []MonthStatus{}, []DateRange{}, []DateRange{}
		if start.IsZero() || start.After(to) {
			out = append(out, ac) // nothing imported and no opening date: unknown range
			continue
		}
		if to.Sub(start) > 25*366*24*time.Hour {
			start = to.AddDate(-25, 0, 0)
		}
		ac.From, ac.To = start.Format(time.DateOnly), to.Format(time.DateOnly)
		days := int(to.Sub(start).Hours()/24) + 1
		status := make([]string, days)
		for i := range status {
			status[i] = CovMissing
		}
		for _, b := range batches {
			s, err1 := time.Parse(time.DateOnly, b.S)
			e, err2 := time.Parse(time.DateOnly, b.E)
			if err1 != nil || err2 != nil {
				continue
			}
			st := CovUnverified
			if b.Stats.Recon.HasBalances {
				st = CovComplete
				if !b.Stats.Recon.OK || (b.Stats.LedgerMatches != nil && !*b.Stats.LedgerMatches) {
					st = CovConflicting
				}
			} else if b.Stats.Recon.RunningBalanceMismatches > 0 {
				st = CovConflicting
			}
			for d := s; !d.After(e); d = d.AddDate(0, 0, 1) {
				i := int(d.Sub(start).Hours() / 24)
				if i >= 0 && i < days && statusRank[st] > statusRank[status[i]] {
					status[i] = st
				}
			}
		}
		day := func(i int) string { return start.AddDate(0, 0, i).Format(time.DateOnly) }
		for i := 0; i < days; {
			j := i
			for j+1 < days && status[j+1] == status[i] {
				j++
			}
			ac.Segments = append(ac.Segments, Segment{DateRange{day(i), day(j)}, status[i]})
			if status[i] == CovMissing {
				ac.Gaps = append(ac.Gaps, DateRange{day(i), day(j)})
			} else if n := len(ac.Covered); n > 0 && ac.Covered[n-1].To == day(i-1) {
				ac.Covered[n-1].To = day(j)
			} else {
				ac.Covered = append(ac.Covered, DateRange{day(i), day(j)})
			}
			i = j + 1
		}
		// Month roll-up.
		months := map[string][]string{}
		var order []string
		for i, s := range status {
			m := day(i)[:7]
			if _, ok := months[m]; !ok {
				order = append(order, m)
			}
			months[m] = append(months[m], s)
		}
		for _, m := range order {
			ac.Months = append(ac.Months, MonthStatus{m, monthStatus(months[m])})
		}
		out = append(out, ac)
	}
	return out, rows.Err()
}

func monthStatus(days []string) string {
	count := map[string]int{}
	for _, d := range days {
		count[d]++
	}
	switch {
	case count[CovConflicting] > 0:
		return CovConflicting
	case count[CovMissing] == len(days):
		return CovMissing
	case count[CovMissing] > 0:
		return CovPartial
	case count[CovUnverified] > 0:
		return CovUnverified
	}
	return CovComplete
}

// InboxItem is a transaction that still needs a category (Feature 126).
type InboxItem struct {
	ID                  uuid.UUID  `json:"id"`
	BookingDate         string     `json:"bookingDate"`
	Kind                string     `json:"kind"`
	Description         string     `json:"description"`
	Payee               string     `json:"payee"`
	Amount              wireMoney  `json:"amount"`
	AccountID           uuid.UUID  `json:"accountId"`
	Source              string     `json:"source"`
	ImportRecordID      *uuid.UUID `json:"importRecordId"`
	SplitCount          int        `json:"splitCount"`
	UncategorizedAmount wireMoney  `json:"uncategorizedAmount"`
}

type InboxFilter struct {
	AccountIDs []uuid.UUID // nil = all
	From, To   *time.Time
	Limit      int
	After      *struct {
		Date string
		ID   uuid.UUID
	}
}

// Uncategorized lists live income/expense/refund transactions with no split or an uncategorized
// split, newest first. Transfers, opening balances and adjustments never need a category.
func Uncategorized(ctx context.Context, q Querier, profileID uuid.UUID, f InboxFilter) ([]InboxItem, bool, error) {
	var afterDate *string
	var afterID *uuid.UUID
	if f.After != nil {
		afterDate, afterID = &f.After.Date, &f.After.ID
	}
	rows, err := q.Query(ctx, `SELECT t.id, t.booking_date, t.kind, t.description, t.payee, p.amount::text, p.currency, p.account_id,
		t.source, t.import_record_id,
		(SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL),
		coalesce((SELECT sum(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IS NULL), abs(p.amount))::text
		FROM transactions t
		JOIN LATERAL (SELECT sum(amount) AS amount, min(currency) AS currency, (array_agg(account_id ORDER BY line_no))[1] AS account_id
			FROM postings WHERE transaction_id = t.id AND deleted_at IS NULL) p ON true
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.kind IN ('income','expense','refund') AND t.status <> 'void'
		  AND (NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL)
		       OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.deleted_at IS NULL AND s.category_id IS NULL))
		  AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM postings x WHERE x.transaction_id = t.id AND x.deleted_at IS NULL AND x.account_id = ANY($2)))
		  AND ($3::date IS NULL OR t.booking_date >= $3) AND ($4::date IS NULL OR t.booking_date <= $4)
		  AND ($5::date IS NULL OR (t.booking_date, t.id) < ($5::date, $6::uuid))
		  AND p.account_id IS NOT NULL
		ORDER BY t.booking_date DESC, t.id DESC LIMIT $7`, profileID, f.AccountIDs, f.From, f.To, afterDate, afterID, f.Limit+1)
	if err != nil {
		return nil, false, fmt.Errorf("inbox: %w", err)
	}
	defer rows.Close()
	items := []InboxItem{}
	for rows.Next() {
		var it InboxItem
		var bd time.Time
		var amt, cur, unc string
		if err := rows.Scan(&it.ID, &bd, &it.Kind, &it.Description, &it.Payee, &amt, &cur, &it.AccountID, &it.Source, &it.ImportRecordID,
			&it.SplitCount, &unc); err != nil {
			return nil, false, err
		}
		it.BookingDate, it.Amount, it.UncategorizedAmount = bd.Format(time.DateOnly), toWire(amt, cur), toWire(unc, cur)
		items = append(items, it)
	}
	more := len(items) > f.Limit
	if more {
		items = items[:f.Limit]
	}
	return items, more, rows.Err()
}
