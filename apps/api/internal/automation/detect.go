package automation

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
)

// ===== category suggestions (Feature 77) =====

type Suggestion struct {
	TransactionID uuid.UUID `json:"transactionId"`
	Field         string    `json:"field"` // category | merchant
	Value         string    `json:"value"`
	Confidence    string    `json:"confidence"`
	Reason        string    `json:"reason"`
}

type histRow struct {
	merchant *uuid.UUID
	norm     string
	cat      uuid.UUID
}

// Suggest proposes categories (and merchants) for transactions from the profile's own history:
//  1. an enabled rule with set_category that matches (confidence 0.95);
//  2. the most frequent category of the same merchant (share of its categorized transactions);
//  3. the most frequent category of transactions with the same normalized description;
//  4. a merchant whose normalized name occurs in the description (merchant field, 0.6).
//
// Only user-, rule- or MCP-categorized history counts. Suggestions never change data.
func Suggest(ctx context.Context, db fin.DB, profileID uuid.UUID, txs []*ledger.Transaction) ([]Suggestion, error) {
	out := []Suggestion{}
	if len(txs) == 0 {
		return out, nil
	}
	rules, err := ListRules(ctx, db, profileID, true)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `SELECT t.merchant_id, t.payee || ' ' || t.description, s.category_id
		FROM transactions t JOIN transaction_splits s ON s.transaction_id = t.id AND s.deleted_at IS NULL
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND s.category_id IS NOT NULL
		  AND t.categorization_source IN ('user','rule','mcp') AND t.booking_date > now() - interval '2 years'
		ORDER BY t.booking_date DESC LIMIT 20000`, profileID)
	if err != nil {
		return nil, err
	}
	var hist []histRow
	for rows.Next() {
		var h histRow
		var text string
		if err := rows.Scan(&h.merchant, &text, &h.cat); err != nil {
			rows.Close()
			return nil, err
		}
		h.norm = analytics.NormalizeMerchant(text)
		hist = append(hist, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	merchants := map[uuid.UUID]string{}
	mrows, err := db.Query(ctx, `SELECT id, normalized_name, name FROM merchants WHERE profile_id = $1 AND deleted_at IS NULL`, profileID)
	if err != nil {
		return nil, err
	}
	names := map[uuid.UUID]string{}
	for mrows.Next() {
		var id uuid.UUID
		var n, name string
		if err := mrows.Scan(&id, &n, &name); err != nil {
			mrows.Close()
			return nil, err
		}
		merchants[id] = strings.ToLower(strings.TrimSpace(n))
		names[id] = name
	}
	mrows.Close()

	for _, t := range txs {
		if !ledger.SplitKinds(t.Kind) {
			continue
		}
		seen := map[string]bool{}
		add := func(s Suggestion) {
			k := s.Field + s.Value
			if !seen[k] {
				seen[k] = true
				out = append(out, s)
			}
		}
		cp, err := counterparty(ctx, db, t)
		if err != nil {
			return nil, err
		}
		for _, r := range rules {
			if !r.Matches(Facts{Txn: t, Counterparty: cp}) {
				continue
			}
			for _, a := range r.Actions {
				if a.Type == "set_category" {
					add(Suggestion{TransactionID: t.ID, Field: "category", Value: a.CategoryID.String(), Confidence: "0.95", Reason: "matches rule \"" + r.Name + "\""})
				}
			}
		}
		norm := analytics.NormalizeMerchant(t.Payee + " " + t.Description)
		vote := func(match func(histRow) bool, what string) {
			counts := map[uuid.UUID]int{}
			total := 0
			for _, h := range hist {
				if match(h) {
					counts[h.cat]++
					total++
				}
			}
			if total == 0 {
				return
			}
			best, n := uuid.Nil, 0
			for c, k := range counts {
				if k > n || (k == n && c.String() < best.String()) {
					best, n = c, k
				}
			}
			conf := new(big.Rat).SetFrac64(int64(n), int64(total))
			if total < 3 { // little evidence: cap confidence
				conf.Mul(conf, big.NewRat(7, 10))
			}
			add(Suggestion{TransactionID: t.ID, Field: "category", Value: best.String(), Confidence: conf.FloatString(2),
				Reason: fmt.Sprintf("%d of %d earlier transactions with %s", n, total, what)})
		}
		if t.MerchantID != nil {
			m := *t.MerchantID
			vote(func(h histRow) bool { return h.merchant != nil && *h.merchant == m }, "this merchant")
		}
		if norm != "" {
			vote(func(h histRow) bool { return h.norm == norm }, "the same description")
		}
		if t.MerchantID == nil && norm != "" {
			ids := make([]uuid.UUID, 0, len(merchants))
			for id := range merchants {
				ids = append(ids, id)
			}
			sort.Slice(ids, func(i, j int) bool { return len(merchants[ids[i]]) > len(merchants[ids[j]]) })
			for _, id := range ids {
				if n := merchants[id]; len(n) >= 3 && strings.Contains(" "+norm+" ", " "+n+" ") {
					add(Suggestion{TransactionID: t.ID, Field: "merchant", Value: id.String(), Confidence: "0.60", Reason: "description mentions " + names[id]})
					break
				}
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].TransactionID != out[j].TransactionID {
			return out[i].TransactionID.String() < out[j].TransactionID.String()
		}
		return out[i].Confidence > out[j].Confidence
	})
	return out, nil
}

// ===== duplicate detection (Feature 78) =====

type DuplicateGroup struct {
	TransactionIDs []uuid.UUID `json:"transactionIds"`
	Score          string      `json:"score"`
	Reasons        []string    `json:"reasons"`
}

type dupTxn struct {
	id          uuid.UUID
	account     uuid.UUID
	amount      money.Money
	date        time.Time
	norm        string
	fingerprint *string
	batch       *uuid.UUID
	source      string
}

// Duplicates finds pairs of transactions on the same account with the same signed amount booked
// within 3 days. Score: 0.5 base, +0.2 same day, +0.2 same normalized description, +0.3 same import
// fingerprint, -0.3 when both rows come from the same import file (repeated real purchases are
// common there). Pairs scoring below 0.6 are not reported. Suggestions only; nothing is merged.
func Duplicates(ctx context.Context, db fin.DB, profileID uuid.UUID, from, to time.Time) ([]DuplicateGroup, error) {
	rows, err := db.Query(ctx, `SELECT t.id, p.account_id, p.amount, p.currency, t.booking_date, t.payee || ' ' || t.description,
		r.dedupe_fingerprint, r.import_batch_id, t.source
		FROM transactions t JOIN postings p ON p.transaction_id = t.id AND p.deleted_at IS NULL AND p.line_no = 0
		LEFT JOIN imported_raw_records r ON r.id = t.import_record_id
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.status <> 'void' AND t.booking_date BETWEEN $2 AND $3
		ORDER BY p.account_id, p.amount, t.booking_date, t.id`, profileID, from.AddDate(0, 0, -3), to)
	if err != nil {
		return nil, err
	}
	type key struct {
		acc uuid.UUID
		amt string
	}
	groups := map[key][]dupTxn{}
	var keys []key
	for rows.Next() {
		var d dupTxn
		var n pgtype.Numeric
		var cur, text string
		if err := rows.Scan(&d.id, &d.account, &n, &cur, &d.date, &text, &d.fingerprint, &d.batch, &d.source); err != nil {
			rows.Close()
			return nil, err
		}
		if d.amount, err = fin.NumericMoney(n, cur); err != nil {
			rows.Close()
			return nil, err
		}
		d.date, d.norm = fin.AsDate(d.date), analytics.NormalizeMerchant(text)
		k := key{d.account, d.amount.String()}
		if _, ok := groups[k]; !ok {
			keys = append(keys, k)
		}
		groups[k] = append(groups[k], d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []DuplicateGroup{}
	for _, k := range keys {
		g := groups[k]
		for i := 0; i < len(g); i++ {
			for j := i + 1; j < len(g) && fin.DaysBetween(g[i].date, g[j].date) <= 3; j++ {
				a, b := g[i], g[j]
				if b.date.After(to) || (a.date.Before(from) && b.date.Before(from)) {
					continue
				}
				score := 50
				reasons := []string{"same account and amount", fmt.Sprintf("%d day(s) apart", fin.DaysBetween(a.date, b.date))}
				if a.date.Equal(b.date) {
					score += 20
				}
				if a.norm != "" && a.norm == b.norm {
					score += 20
					reasons = append(reasons, "same description")
				}
				if a.fingerprint != nil && b.fingerprint != nil && *a.fingerprint == *b.fingerprint {
					score += 30
					reasons = append(reasons, "same import fingerprint")
				}
				if a.batch != nil && b.batch != nil && *a.batch == *b.batch {
					score -= 30
					reasons = append(reasons, "both from the same import file")
				} else if (a.source == "manual") != (b.source == "manual") {
					reasons = append(reasons, "manual entry and imported row")
				}
				if score < 60 {
					continue
				}
				out = append(out, DuplicateGroup{TransactionIDs: []uuid.UUID{a.id, b.id}, Score: fmt.Sprintf("%d.%02d", min(score, 100)/100, min(score, 100)%100), Reasons: reasons})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out, nil
}

// ===== recurring payment detection (Feature 80) =====

type RecurringCandidate struct {
	MerchantID     *uuid.UUID  `json:"merchantId"`
	Description    string      `json:"description"`
	Amount         money.Money `json:"amount"`
	RRule          string      `json:"rrule"`
	TransactionIDs []uuid.UUID `json:"transactionIds"`
	Confidence     string      `json:"confidence"`
	NextDate       string      `json:"nextDate"`
	Cadence        string      `json:"cadence"`
}

type cadence struct {
	name     string
	lo, hi   int // accepted gap in days
	minCount int
}

var cadences = []cadence{
	{"weekly", 6, 8, 4}, {"biweekly", 13, 16, 3}, {"monthly", 27, 34, 3}, {"quarterly", 85, 97, 3}, {"yearly", 355, 375, 2},
}

// RecurringCandidates looks at 400 days of expenses grouped by merchant (or normalized
// description) in one currency: members within ±15% of the group's median amount; the median gap
// between payments picks a cadence; confidence = share of gaps inside that cadence's window
// (>= 0.75 required). Groups already covered by an active plan of the same merchant are skipped.
func RecurringCandidates(ctx context.Context, db fin.DB, p fin.Profile) ([]RecurringCandidate, error) {
	flows, err := fin.Flows(ctx, db, p.ID, p.Today.AddDate(0, 0, -400), p.Today, nil)
	if err != nil {
		return nil, err
	}
	type item struct {
		id   uuid.UUID
		date time.Time
		amt  money.Money
		desc string
		m    *uuid.UUID
	}
	groups := map[string][]item{}
	var order []string
	seenTxn := map[uuid.UUID]bool{}
	for _, f := range flows {
		if f.Kind != "expense" || seenTxn[f.TransactionID] {
			continue
		}
		seenTxn[f.TransactionID] = true
		k := "name:" + analytics.NormalizeMerchant(f.Payee+" "+f.Description)
		if f.MerchantID != nil {
			k = f.MerchantID.String()
		}
		k += "|" + f.Amount.Currency()
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], item{f.TransactionID, f.Date, f.Amount, f.Description, f.MerchantID})
	}
	planned := map[uuid.UUID]bool{}
	plans, err := planning.ListPlans(ctx, db, p.ID, uuid.Nil, 100_000, []string{"active"})
	if err != nil {
		return nil, err
	}
	for _, pl := range plans {
		if pl.MerchantID != nil && pl.Recurrence != nil {
			planned[*pl.MerchantID] = true
		}
	}
	out := []RecurringCandidate{}
	for _, k := range order {
		g := groups[k]
		if len(g) < 2 || (g[0].m != nil && planned[*g[0].m]) {
			continue
		}
		amts := make([]*big.Int, len(g))
		for i, x := range g {
			amts[i] = x.amt.Minor()
		}
		sort.Slice(amts, func(i, j int) bool { return amts[i].Cmp(amts[j]) < 0 })
		med := amts[len(amts)/2]
		tol := new(big.Int).Div(new(big.Int).Mul(med, big.NewInt(15)), big.NewInt(100))
		var members []item
		for _, x := range g {
			d := new(big.Int).Sub(x.amt.Minor(), med)
			if d.Abs(d).Cmp(tol) <= 0 {
				members = append(members, x)
			}
		}
		sort.Slice(members, func(i, j int) bool { return members[i].date.Before(members[j].date) })
		if len(members) < 2 {
			continue
		}
		gaps := make([]int, 0, len(members)-1)
		for i := 1; i < len(members); i++ {
			gaps = append(gaps, fin.DaysBetween(members[i-1].date, members[i].date))
		}
		sorted := append([]int(nil), gaps...)
		sort.Ints(sorted)
		mg := sorted[len(sorted)/2]
		var c *cadence
		for i := range cadences {
			if mg >= cadences[i].lo && mg <= cadences[i].hi {
				c = &cadences[i]
			}
		}
		if c == nil || len(members) < c.minCount {
			continue
		}
		in := 0
		for _, gp := range gaps {
			if gp >= c.lo && gp <= c.hi {
				in++
			}
		}
		if in*4 < len(gaps)*3 {
			continue
		}
		last := members[len(members)-1]
		cur := last.amt.Currency()
		medMoney, _ := money.FromMinor(med, cur)
		var rrule string
		var next time.Time
		switch c.name {
		case "weekly":
			rrule, next = "FREQ=WEEKLY;BYDAY="+[]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}[last.date.Weekday()], last.date.AddDate(0, 0, 7)
		case "biweekly":
			rrule, next = "FREQ=WEEKLY;INTERVAL=2;BYDAY="+[]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}[last.date.Weekday()], last.date.AddDate(0, 0, 14)
		case "monthly":
			rrule, next = fmt.Sprintf("FREQ=MONTHLY;BYMONTHDAY=%d", last.date.Day()), fin.AddMonthsClamped(last.date, 1, last.date.Day())
		case "quarterly":
			rrule, next = fmt.Sprintf("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=%d", last.date.Day()), fin.AddMonthsClamped(last.date, 3, last.date.Day())
		case "yearly":
			rrule, next = "FREQ=YEARLY", fin.AddMonthsClamped(last.date, 12, last.date.Day())
		}
		ids := make([]uuid.UUID, len(members))
		for i, m := range members {
			ids[i] = m.id
		}
		conf := new(big.Rat).SetFrac64(int64(in), int64(len(gaps)))
		if len(members) < 4 {
			conf.Mul(conf, big.NewRat(8, 10))
		}
		out = append(out, RecurringCandidate{MerchantID: last.m, Description: last.desc, Amount: medMoney, RRule: rrule, TransactionIDs: ids,
			Confidence: conf.FloatString(2), NextDate: fin.Fmt(next), Cadence: c.name})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Confidence > out[j].Confidence })
	return out, nil
}
