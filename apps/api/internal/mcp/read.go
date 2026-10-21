package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/forecasting"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/imports"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/savings"
)

// Read tools (PLAN §28). Aggregates are computed by the analytics/forecasting engines on the server
// so agents receive totals, not raw transaction dumps. Every result carries `meta` (complete,
// warnings, missingRates, nextCursor).

var readTools = map[string]readFn{
	"get_financial_overview":         overview,
	"list_accounts":                  listAccounts,
	"get_account_balance":            accountBalance,
	"list_transactions":              listTransactions,
	"get_transaction":                getTransaction,
	"get_spending_by_category":       spendingByCategory,
	"get_spending_by_merchant":       spendingByMerchant,
	"compare_periods":                comparePeriods,
	"get_income_summary":             incomeSummary,
	"get_budget_status":              budgetStatus,
	"list_recurring_expenses":        recurringExpenses,
	"list_planned_expenses":          plannedExpenses,
	"get_cash_flow_forecast":         cashFlowForecast,
	"get_savings_goals":              savingsGoals,
	"get_currency_exposure":          currencyExposure,
	"get_import_coverage":            importCoverage,
	"get_uncategorized_transactions": uncategorized,
	"simulate_expense":               simulateExpense,
}

type scopeIn struct {
	ProfileID  *uuid.UUID  `json:"profileId"`
	AccountIDs []uuid.UUID `json:"accountIds"`
}

type amountRow struct {
	Key    string      `json:"key"`
	Label  string      `json:"label"`
	Amount money.Money `json:"amount"`
	Count  int         `json:"count"`
}

func reportCurrency(cur *string, p fin.Profile) (string, error) {
	if cur == nil || *cur == "" {
		return p.BaseCurrency, nil
	}
	c := strings.ToUpper(*cur)
	if _, ok := money.Scale(c); !ok {
		return "", httpx.Validation(map[string]string{"currency": "unknown currency"})
	}
	return c, nil
}

func dateOr(s *string, def time.Time) (time.Time, error) {
	if s == nil {
		return def, nil
	}
	t, err := fin.ParseDate(*s)
	if err != nil {
		return t, httpx.Validation(map[string]string{"date": err.Error()})
	}
	return t, nil
}

func rowsOf(r fin.Rows, keep func(fin.Row) bool) []amountRow {
	out := []amountRow{}
	for _, x := range r.Rows {
		if keep == nil || keep(x) {
			out = append(out, amountRow{x.Key, x.Label, x.Amount, x.Count})
		}
	}
	return out
}

// accountBalances: per included account, the balances (one per currency) as of a date.
func accountBalances(ctx context.Context, s *session, v view, accIDs []uuid.UUID, asOf time.Time) (map[uuid.UUID][]money.Money, error) {
	bals, err := ledger.Balances(ctx, s.db, v.P.ID, fin.Fmt(asOf), accIDs)
	if err != nil {
		return nil, err
	}
	out := map[uuid.UUID][]money.Money{}
	for _, b := range bals {
		out[b.AccountID] = append(out[b.AccountID], b.Amount)
	}
	return out, nil
}

func overview(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		Currency *string `json:"currency"`
		AsOf     *string `json:"asOf"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	cur, err := reportCurrency(in.Currency, v.P)
	if err != nil {
		return nil, err
	}
	asOf, err := dateOr(in.AsOf, v.P.Today)
	if err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	accs, err := fin.Accounts(ctx, s.db, v.P.ID)
	if err != nil {
		return nil, err
	}
	bals, err := accountBalances(ctx, s, v, accIDs, asOf)
	if err != nil {
		return nil, err
	}
	conv := fin.NewConverter(s.db, v.P.ID)
	var assets, liabilities fin.Accumulator
	for _, a := range accs {
		if !a.IncludeNetWorth || (accIDs != nil && !slices.Contains(accIDs, a.ID)) {
			continue
		}
		for _, b := range bals[a.ID] {
			c, _, err := conv.Convert(ctx, b, cur, asOf)
			if err != nil {
				return nil, err
			}
			if a.Classification == "asset" {
				assets.Add(c)
			} else {
				liabilities.Sub(c)
			}
		}
	}
	ta, tl := assets.Money(cur), liabilities.Money(cur)
	nw, _ := ta.Sub(tl)
	ie, err := analytics.IncomeVsExpenses(ctx, s.db, analytics.Query{P: v.P, From: fin.MonthStart(asOf), To: asOf, Currency: cur, AccountIDs: accIDs, Interval: "month"})
	if err != nil {
		return nil, err
	}
	var inc, exp fin.Accumulator
	for _, r := range ie.Rows {
		switch {
		case strings.HasSuffix(r.Key, ":income"):
			inc.Add(r.Amount)
		case strings.HasSuffix(r.Key, ":expenses"):
			exp.Add(r.Amount)
		}
	}
	m.merge(ie.Complete, ie.Warnings, ie.MissingRates)
	occ, err := planning.Expand(ctx, s.db, v.P.ID, v.P.Today, v.P.Today.AddDate(0, 0, 30), v.P.Today, nil)
	if err != nil {
		return nil, err
	}
	type upcoming struct {
		Date        string      `json:"date"`
		Description string      `json:"description"`
		Amount      money.Money `json:"amount"`
	}
	up := []upcoming{}
	for _, o := range occ {
		if o.Resolved() || !v.allowsAccount(o.AccountID) || o.Kind == "transfer" {
			continue
		}
		a := o.Amount
		if o.Kind == "expense" {
			a = a.Neg()
		}
		if len(up) == 20 {
			m.warn("more than 20 upcoming items in the next 30 days; use list_planned_expenses")
			break
		}
		up = append(up, upcoming{o.Date, o.Description, a})
	}
	m.merge(conv.Complete(), nil, conv.Missing())
	return map[string]any{"netWorth": nw, "totalAssets": ta, "totalLiabilities": tl, "monthIncome": inc.Money(cur),
		"monthExpenses": exp.Money(cur), "upcoming": up, "meta": m}, nil
}

func listAccounts(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		IncludeArchived bool `json:"includeArchived"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	if err := v.current(); err != nil {
		return nil, err
	}
	accs, err := fin.Accounts(ctx, s.db, v.P.ID)
	if err != nil {
		return nil, err
	}
	bals, err := accountBalances(ctx, s, v, accIDs, v.P.Today)
	if err != nil {
		return nil, err
	}
	type acc struct {
		ID       uuid.UUID     `json:"id"`
		Name     string        `json:"name"`
		Type     string        `json:"type"`
		Currency string        `json:"currency"`
		Archived bool          `json:"archived"`
		Balances []money.Money `json:"balances"`
	}
	out := []acc{}
	for _, a := range accs {
		if (accIDs != nil && !slices.Contains(accIDs, a.ID)) || (a.Archived && !in.IncludeArchived) {
			continue
		}
		b := bals[a.ID]
		if b == nil {
			b = []money.Money{fin.Zero(a.Currency)}
		}
		out = append(out, acc{a.ID, a.Name, a.Type, a.Currency, a.Archived, b})
	}
	return map[string]any{"accounts": out, "meta": m}, nil
}

func accountBalance(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		AccountID uuid.UUID `json:"accountId"`
		AsOf      *string   `json:"asOf"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	pid, err := s.entityProfile(ctx, "accounts", in.AccountID)
	if err != nil {
		return nil, err
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	if _, err := v.accounts([]uuid.UUID{in.AccountID}); err != nil {
		return nil, err
	}
	asOf, err := dateOr(in.AsOf, v.P.Today)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	if (v.From != nil && asOf.Before(*v.From)) || (v.To != nil && asOf.After(*v.To)) {
		return nil, toolErr("period_not_granted", "asOf is outside this client's granted period")
	}
	bals, err := accountBalances(ctx, s, v, []uuid.UUID{in.AccountID}, asOf)
	if err != nil {
		return nil, err
	}
	b := bals[in.AccountID]
	if b == nil {
		var cur string
		_ = s.db.QueryRow(ctx, `SELECT currency FROM accounts WHERE id = $1`, in.AccountID).Scan(&cur)
		b = []money.Money{fin.Zero(strings.TrimSpace(cur))}
	}
	return map[string]any{"accountId": in.AccountID, "asOf": fin.Fmt(asOf), "balances": b, "meta": m}, nil
}

// txFilter restricts transaction visibility to the view (accounts + period).
func txVisible(v view, t *ledger.Transaction) bool {
	if v.From != nil && t.BookingDate < fin.Fmt(*v.From) || v.To != nil && t.BookingDate > fin.Fmt(*v.To) {
		return false
	}
	if v.AccountIDs == nil {
		return true
	}
	for _, p := range t.Postings {
		if slices.Contains(v.AccountIDs, p.AccountID) {
			return true
		}
	}
	return false
}

// redact hides postings on accounts outside an account-restricted grant (e.g. the other leg of a transfer).
func redact(v view, t *ledger.Transaction) *ledger.Transaction {
	if v.AccountIDs == nil {
		return t
	}
	c := t.Clone()
	c.Postings = slices.DeleteFunc(c.Postings, func(p ledger.Posting) bool { return !slices.Contains(v.AccountIDs, p.AccountID) })
	return c
}

func likePattern(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s) + "%"
}

type txCursor struct {
	Date string    `json:"d"`
	ID   uuid.UUID `json:"i"`
}

func listTransactions(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		DateFrom          *string     `json:"dateFrom"`
		DateTo            *string     `json:"dateTo"`
		Limit             int         `json:"limit"`
		Cursor            string      `json:"cursor"`
		CategoryIDs       []uuid.UUID `json:"categoryIds"`
		Search            *string     `json:"search"`
		MinAmount         *string     `json:"minAmount"`
		MaxAmount         *string     `json:"maxAmount"`
		UncategorizedOnly bool        `json:"uncategorizedOnly"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	from, to, err := v.clamp(in.DateFrom, in.DateTo, fin.Date(1900, 1, 1), fin.Date(2999, 12, 31), m)
	if err != nil {
		return nil, err
	}
	var c *txCursor
	if in.Cursor != "" {
		c = &txCursor{}
		if err := httpx.DecodeCursor(in.Cursor, c); err != nil {
			return nil, err
		}
	}
	limit := min(in.Limit, s.maxRows)
	var search *string
	if in.Search != nil && *in.Search != "" {
		p := likePattern(*in.Search)
		search = &p
	}
	var cats []uuid.UUID
	if len(in.CategoryIDs) > 0 {
		cats = in.CategoryIDs
	}
	var cd *string
	var cid *uuid.UUID
	if c != nil {
		cd, cid = &c.Date, &c.ID
	}
	txs, err := ledger.Query(ctx, s.db, `SELECT `+ledger.TxCols+` FROM transactions t
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.booking_date BETWEEN $2 AND $3
		  AND ($4::uuid[] IS NULL OR EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.account_id = ANY($4)))
		  AND ($5::uuid[] IS NULL OR EXISTS (SELECT 1 FROM transaction_splits x WHERE x.transaction_id = t.id AND x.deleted_at IS NULL AND x.category_id = ANY($5)))
		  AND ($6::text IS NULL OR (t.description || ' ' || t.notes || ' ' || t.payee) ILIKE $6)
		  AND ($7::numeric IS NULL OR (SELECT abs(sum(p.amount)) FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.line_no = 0) >= $7)
		  AND ($8::numeric IS NULL OR (SELECT abs(sum(p.amount)) FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.line_no = 0) <= $8)
		  AND (NOT $9 OR (t.kind IN ('income','expense','refund') AND (NOT EXISTS (SELECT 1 FROM transaction_splits x WHERE x.transaction_id = t.id AND x.deleted_at IS NULL)
		       OR EXISTS (SELECT 1 FROM transaction_splits x WHERE x.transaction_id = t.id AND x.deleted_at IS NULL AND x.category_id IS NULL))))
		  AND ($10::date IS NULL OR (t.booking_date, t.id) < ($10::date, $11::uuid))
		ORDER BY t.booking_date DESC, t.id DESC LIMIT $12`,
		v.P.ID, from, to, accIDs, cats, search, in.MinAmount, in.MaxAmount, in.UncategorizedOnly, cd, cid, limit+1)
	if err != nil {
		return nil, err
	}
	out := []*ledger.Transaction{}
	for _, t := range txs {
		out = append(out, redact(v, t))
	}
	if len(out) > limit {
		out = out[:limit]
		last := out[limit-1]
		m.NextCursor = httpx.EncodeCursor(txCursor{last.BookingDate, last.ID})
		m.Complete = false
		m.warn("more transactions match; pass meta.nextCursor as cursor")
	}
	return map[string]any{"transactions": out, "meta": m}, nil
}

func getTransaction(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		TransactionID uuid.UUID `json:"transactionId"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	pid, err := s.entityProfile(ctx, "transactions", in.TransactionID)
	if err != nil {
		return nil, err
	}
	v, err := s.view(ctx, &pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	t, err := ledger.Get(ctx, s.db, pid, in.TransactionID, false)
	if err != nil {
		return nil, err
	}
	if !txVisible(v, t) {
		return nil, httpx.NotFound("transaction")
	}
	out := map[string]any{"transaction": redact(v, t), "meta": newMeta()}
	if t.ImportRecordID != nil {
		var src struct {
			Description, Currency, Reference, Counterparty, Importer, Amount, Date string
			Batch                                                                  uuid.UUID
		}
		if err := s.db.QueryRow(ctx, `SELECT source_description, posting_date::text, amount::text, currency, bank_reference, counterparty, importer_id, import_batch_id
			FROM imported_raw_records WHERE id = $1 AND profile_id = $2`, *t.ImportRecordID, pid).Scan(&src.Description, &src.Date, &src.Amount,
			&src.Currency, &src.Reference, &src.Counterparty, &src.Importer, &src.Batch); err == nil {
			amt, _ := imports.Money(src.Amount, src.Currency)
			out["sourceRecord"] = map[string]any{"sourceDescription": src.Description, "postingDate": src.Date, "amount": amt,
				"bankReference": src.Reference, "counterparty": src.Counterparty, "importerId": src.Importer, "importBatchId": src.Batch}
		}
	}
	return out, nil
}

type periodIn struct {
	scopeIn
	DateFrom *string `json:"dateFrom"`
	DateTo   *string `json:"dateTo"`
	Currency *string `json:"currency"`
}

// analyticsQuery builds an analytics.Query honoring the view. Default period: current month.
func analyticsQuery(ctx context.Context, s *session, def *toolDef, in periodIn) (analytics.Query, *meta, error) {
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return analytics.Query{}, nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return analytics.Query{}, nil, err
	}
	m := newMeta()
	from, to, err := v.clamp(in.DateFrom, in.DateTo, fin.MonthStart(v.P.Today), v.P.Today, m)
	if err != nil {
		return analytics.Query{}, nil, err
	}
	if to.Sub(from) > 20*366*24*time.Hour {
		return analytics.Query{}, nil, httpx.Validation(map[string]string{"dateFrom": "range longer than 20 years"})
	}
	cur, err := reportCurrency(in.Currency, v.P)
	return analytics.Query{P: v.P, From: from, To: to, Currency: cur, AccountIDs: accIDs, Interval: "none"}, m, err
}

func spendingByCategory(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		periodIn
		IncludeSubcategories bool `json:"includeSubcategories"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	q, m, err := analyticsQuery(ctx, s, def, in.periodIn)
	if err != nil {
		return nil, err
	}
	r, err := analytics.SpendingByCategory(ctx, s.db, q)
	if err != nil {
		return nil, err
	}
	m.merge(r.Complete, r.Warnings, r.MissingRates)
	rows := rowsOf(r, func(x fin.Row) bool { return in.IncludeSubcategories || x.ParentKey == nil })
	return map[string]any{"rows": rows, "total": r.Total, "from": r.From, "to": r.To, "meta": m}, nil
}

func spendingByMerchant(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		periodIn
		Limit int `json:"limit"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	q, m, err := analyticsQuery(ctx, s, def, in.periodIn)
	if err != nil {
		return nil, err
	}
	r, err := analytics.SpendingByMerchant(ctx, s.db, q)
	if err != nil {
		return nil, err
	}
	m.merge(r.Complete, r.Warnings, r.MissingRates)
	rows := rowsOf(r, nil)
	if len(rows) > in.Limit {
		m.warn(fmt.Sprintf("%d merchants; showing the top %d (total covers all)", len(rows), in.Limit))
		rows = rows[:in.Limit]
	}
	return map[string]any{"rows": rows, "total": r.Total, "from": r.From, "to": r.To, "meta": m}, nil
}

func comparePeriods(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	type rng struct {
		DateFrom string `json:"dateFrom"`
		DateTo   string `json:"dateTo"`
	}
	var in struct {
		scopeIn
		Currency *string `json:"currency"`
		A        rng     `json:"a"`
		B        rng     `json:"b"`
		GroupBy  string  `json:"groupBy"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	qa, m, err := analyticsQuery(ctx, s, def, periodIn{scopeIn: in.scopeIn, DateFrom: &in.A.DateFrom, DateTo: &in.A.DateTo, Currency: in.Currency})
	if err != nil {
		return nil, err
	}
	qb, mb, err := analyticsQuery(ctx, s, def, periodIn{scopeIn: in.scopeIn, DateFrom: &in.B.DateFrom, DateTo: &in.B.DateTo, Currency: in.Currency})
	if err != nil {
		return nil, err
	}
	m.merge(true, mb.Warnings, nil)
	type row struct {
		Key       string      `json:"key"`
		Label     string      `json:"label"`
		A         money.Money `json:"a"`
		B         money.Money `json:"b"`
		Change    money.Money `json:"change"`
		ChangePct *string     `json:"changePct"`
	}
	sum := func(q analytics.Query) (map[string]fin.Row, []string, error) {
		var r fin.Rows
		var err error
		switch in.GroupBy {
		case "merchant":
			r, err = analytics.SpendingByMerchant(ctx, s.db, q)
		case "account":
			r.Rows = []fin.Row{}
			accs, aerr := fin.Accounts(ctx, s.db, q.P.ID)
			if aerr != nil {
				return nil, nil, aerr
			}
			r.Complete = true
			for _, a := range accs {
				if q.AccountIDs != nil && !slices.Contains(q.AccountIDs, a.ID) {
					continue
				}
				qq := q
				qq.AccountIDs = []uuid.UUID{a.ID}
				x, err := analytics.SpendingByCategory(ctx, s.db, qq)
				if err != nil {
					return nil, nil, err
				}
				r.Complete = r.Complete && x.Complete
				r.MissingRates = append(r.MissingRates, x.MissingRates...)
				r.Rows = append(r.Rows, fin.Row{Key: a.ID.String(), Label: a.Name, Amount: x.Total})
			}
		default:
			r, err = analytics.SpendingByCategory(ctx, s.db, q)
			if err == nil {
				r.Rows = slices.DeleteFunc(r.Rows, func(x fin.Row) bool { return x.ParentKey != nil })
			}
		}
		if err != nil {
			return nil, nil, err
		}
		m.merge(r.Complete, nil, r.MissingRates)
		out := map[string]fin.Row{}
		var keys []string
		for _, x := range r.Rows {
			out[x.Key] = x
			keys = append(keys, x.Key)
		}
		return out, keys, nil
	}
	ra, ka, err := sum(qa)
	if err != nil {
		return nil, err
	}
	rb, kb, err := sum(qb)
	if err != nil {
		return nil, err
	}
	keys := ka
	for _, k := range kb {
		if !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	rows := []row{}
	for _, k := range keys {
		a, b := fin.Zero(qa.Currency), fin.Zero(qa.Currency)
		label := k
		if x, ok := ra[k]; ok {
			a, label = x.Amount, x.Label
		}
		if x, ok := rb[k]; ok {
			b, label = x.Amount, x.Label
		}
		ch, _ := b.Sub(a)
		var pct *string
		if !a.IsZero() {
			if p := fin.Ratio(ch, a.Abs(), 4); p != "" {
				pct = &p
			}
		}
		rows = append(rows, row{k, label, a, b, ch, pct})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		c, _ := rows[i].B.Cmp(rows[j].B)
		return c > 0
	})
	return map[string]any{"rows": rows, "meta": m}, nil
}

func incomeSummary(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in periodIn
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	q, m, err := analyticsQuery(ctx, s, def, in)
	if err != nil {
		return nil, err
	}
	if in.DateFrom == nil {
		q.From = fin.MonthStart(q.To.AddDate(0, -11, 0)) // default: last 12 months
	}
	q.Interval = "month"
	r, err := analytics.IncomeVsExpenses(ctx, s.db, q)
	if err != nil {
		return nil, err
	}
	m.merge(r.Complete, r.Warnings, r.MissingRates)
	var total fin.Accumulator
	rows := []amountRow{}
	for _, x := range r.Rows {
		if strings.HasSuffix(x.Key, ":income") {
			rows = append(rows, amountRow{x.Period, x.Period, x.Amount, x.Count})
			total.Add(x.Amount)
		}
	}
	return map[string]any{"rows": rows, "total": total.Money(q.Currency), "from": fin.Fmt(q.From), "to": fin.Fmt(q.To), "meta": m}, nil
}

func budgetStatus(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID *uuid.UUID `json:"profileId"`
		BudgetID  *uuid.UUID `json:"budgetId"`
		Date      *string    `json:"date"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.unrestricted("budget status"); err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	d, err := dateOr(in.Date, v.P.Today)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	list, err := budgets.List(ctx, s.db, v.P.ID, uuid.Nil, 500)
	if err != nil {
		return nil, err
	}
	type line struct {
		ID          uuid.UUID   `json:"id"`
		Name        string      `json:"name"`
		PeriodStart string      `json:"periodStart"`
		PeriodEnd   string      `json:"periodEnd"`
		Limit       money.Money `json:"limit"`
		Actual      money.Money `json:"actual"`
		Planned     money.Money `json:"planned"`
		Remaining   money.Money `json:"remaining"`
	}
	out := []line{}
	for _, b := range list {
		if b.IsTemplate || b.IsArchived || (in.BudgetID != nil && b.ID != *in.BudgetID) {
			continue
		}
		st, err := budgets.ComputeStatus(ctx, s.db, b, d, v.P.Today)
		if err != nil {
			m.warn(fmt.Sprintf("budget %q has no period on %s", b.Name, fin.Fmt(d)))
			continue
		}
		m.merge(st.Complete, nil, st.MissingRates)
		out = append(out, line{b.ID, b.Name, st.PeriodStart, st.PeriodEnd, st.Totals.Limit, st.Totals.Actual, st.Totals.Planned, st.Totals.Remaining})
	}
	if in.BudgetID != nil && len(out) == 0 {
		return nil, httpx.NotFound("budget")
	}
	return map[string]any{"budgets": out, "meta": m}, nil
}

func recurringExpenses(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID *uuid.UUID `json:"profileId"`
		Currency  *string    `json:"currency"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	cur, err := reportCurrency(in.Currency, v.P)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	plans, err := planning.ListPlans(ctx, s.db, v.P.ID, uuid.Nil, 10_000, []string{"active"})
	if err != nil {
		return nil, err
	}
	conv := fin.NewConverter(s.db, v.P.ID)
	type item struct {
		ID          uuid.UUID   `json:"id"`
		Description string      `json:"description"`
		Amount      money.Money `json:"amount"`
		RRule       string      `json:"rrule"`
		Annualized  money.Money `json:"annualized"`
		NextDate    *string     `json:"nextDate"`
	}
	out := []item{}
	var total fin.Accumulator
	for _, p := range plans {
		if p.Kind != "expense" || p.Recurrence == nil || !v.allowsAccount(p.AccountID) {
			continue
		}
		annual, _, err := planning.Annualize(p.Amount, p.Recurrence.RRule)
		if err != nil {
			m.warn("cannot annualize " + p.Description + ": " + err.Error())
			continue
		}
		if annual.Currency() != cur {
			c, ok, err := conv.Convert(ctx, annual, cur, v.P.Today)
			if err != nil {
				return nil, err
			}
			if ok {
				annual = c
			}
		}
		total.Add(annual)
		var next *string
		occ, err := planning.ExpandPlans(ctx, s.db, v.P.ID, []planning.Plan{p}, v.P.Today, v.P.Today.AddDate(1, 1, 0), v.P.Today)
		if err != nil {
			return nil, err
		}
		for _, o := range occ {
			if !o.Resolved() {
				d := o.Date
				next = &d
				break
			}
		}
		out = append(out, item{p.ID, p.Description, p.Amount, p.Recurrence.RRule, annual, next})
		if len(out) >= s.maxRows {
			m.Complete = false
			m.warn("result truncated")
			break
		}
	}
	m.merge(conv.Complete(), nil, conv.Missing())
	return map[string]any{"items": out, "annualTotal": total.Money(cur), "meta": m}, nil
}

func plannedExpenses(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID *uuid.UUID `json:"profileId"`
		DateFrom  *string    `json:"dateFrom"`
		DateTo    *string    `json:"dateTo"`
		Limit     int        `json:"limit"`
		Cursor    string     `json:"cursor"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	from, to, err := v.clamp(in.DateFrom, in.DateTo, v.P.Today, v.P.Today.AddDate(0, 0, 90), m)
	if err != nil {
		return nil, err
	}
	if to.Sub(from) > 3*366*24*time.Hour {
		return nil, httpx.Validation(map[string]string{"dateTo": "at most 3 years of occurrences per call"})
	}
	var offset struct{ N int }
	if err := httpx.DecodeCursor(in.Cursor, &offset); err != nil {
		return nil, err
	}
	occ, err := planning.Expand(ctx, s.db, v.P.ID, from, to, v.P.Today, nil)
	if err != nil {
		return nil, err
	}
	type item struct {
		PlannedTransactionID uuid.UUID   `json:"plannedTransactionId"`
		Date                 string      `json:"date"`
		Description          string      `json:"description"`
		Amount               money.Money `json:"amount"`
		Priority             string      `json:"priority"`
		Confidence           string      `json:"confidence"`
		Status               string      `json:"status"`
	}
	var all []item
	for _, o := range occ {
		if o.Kind == "expense" && v.allowsAccount(o.AccountID) {
			all = append(all, item{o.PlannedTransactionID, o.Date, o.Description, o.Amount, o.Priority, o.Confidence, o.Status})
		}
	}
	limit := min(in.Limit, s.maxRows)
	out := []item{}
	if offset.N < len(all) {
		out = all[offset.N:min(len(all), offset.N+limit)]
	}
	if offset.N+limit < len(all) {
		m.NextCursor = httpx.EncodeCursor(struct{ N int }{offset.N + limit})
		m.Complete = false
	}
	return map[string]any{"items": out, "meta": m}, nil
}

func forecastFor(ctx context.Context, s *session, v view, accIDs []uuid.UUID, cur string, days int, adj []forecasting.Adjustment) (forecasting.Forecast, error) {
	return forecasting.Build(ctx, s.db, v.P, forecasting.Options{Days: days, Currency: cur, AccountIDs: accIDs, Adjustments: adj})
}

func cashFlowForecast(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		Currency *string `json:"currency"`
		Days     int     `json:"days"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	cur, err := reportCurrency(in.Currency, v.P)
	if err != nil {
		return nil, err
	}
	f, err := forecastFor(ctx, s, v, accIDs, cur, in.Days, nil)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	m.merge(f.Complete, f.Warnings, f.MissingRates)
	type day struct {
		Date         string      `json:"date"`
		Expected     money.Money `json:"expected"`
		Conservative money.Money `json:"conservative"`
		Optimistic   money.Money `json:"optimistic"`
	}
	days := make([]day, len(f.Days))
	for i, d := range f.Days {
		days[i] = day{d.Date, d.Expected, d.Conservative, d.Optimistic}
	}
	return map[string]any{"days": days, "lowest": f.Lowest, "lowestConservative": f.LowestConservative, "shortfalls": f.Shortfalls,
		"safeToSpend": f.SafeToSpend, "safeToSpendUntil": f.SafeToSpendUntil, "assumptions": f.Assumptions, "meta": m}, nil
}

func savingsGoals(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID *uuid.UUID `json:"profileId"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.unrestricted("savings goal progress"); err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	goals, err := savings.List(ctx, s.db, v.P, uuid.Nil, 1000)
	if err != nil {
		return nil, err
	}
	type goal struct {
		ID                  uuid.UUID   `json:"id"`
		Name                string      `json:"name"`
		Kind                string      `json:"kind"`
		Status              string      `json:"status"`
		Target              money.Money `json:"target"`
		Saved               money.Money `json:"saved"`
		Progress            string      `json:"progress"`
		TargetDate          *string     `json:"targetDate"`
		EstimatedCompletion *string     `json:"estimatedCompletion"`
		OnTrack             bool        `json:"onTrack"`
	}
	out := []goal{}
	for _, g := range goals {
		out = append(out, goal{g.ID, g.Name, g.Kind, g.Status, g.TargetAmount, g.Saved, g.Progress, g.TargetDate, g.EstimatedCompletion, g.OnTrack})
	}
	return map[string]any{"goals": out, "meta": newMeta()}, nil
}

func currencyExposure(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		Currency *string `json:"currency"`
		AsOf     *string `json:"asOf"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	cur, err := reportCurrency(in.Currency, v.P)
	if err != nil {
		return nil, err
	}
	asOf, err := dateOr(in.AsOf, v.P.Today)
	if err != nil {
		return nil, err
	}
	accs, err := fin.Accounts(ctx, s.db, v.P.ID)
	if err != nil {
		return nil, err
	}
	bals, err := accountBalances(ctx, s, v, accIDs, asOf)
	if err != nil {
		return nil, err
	}
	native := map[string]*fin.Accumulator{}
	var curs []string
	for _, a := range accs {
		if !a.IncludeNetWorth || a.Classification != "asset" {
			continue
		}
		for _, b := range bals[a.ID] {
			if native[b.Currency()] == nil {
				native[b.Currency()] = &fin.Accumulator{}
				curs = append(curs, b.Currency())
			}
			native[b.Currency()].Add(b)
		}
	}
	sort.Strings(curs)
	conv := fin.NewConverter(s.db, v.P.ID)
	type row struct {
		Currency  string       `json:"currency"`
		Amount    money.Money  `json:"amount"`
		Converted *money.Money `json:"converted"`
		Rate      *string      `json:"rate"`
	}
	rows := []row{}
	var total fin.Accumulator
	for _, c := range curs {
		n := native[c].Money(c)
		r := row{Currency: c, Amount: n}
		if conv1, ok, err := conv.Convert(ctx, n, cur, asOf); err != nil {
			return nil, err
		} else if ok {
			r.Converted = &conv1
			total.Add(conv1)
			if rat, ok, err := conv.Rate(ctx, c, cur, asOf); err == nil && ok {
				rs := strings.TrimRight(strings.TrimRight(rat.FloatString(10), "0"), ".")
				r.Rate = &rs
			}
		}
		rows = append(rows, r)
	}
	m := newMeta()
	m.merge(conv.Complete(), nil, conv.Missing())
	m.warn("asset accounts included in net worth; liabilities are not part of currency exposure")
	return map[string]any{"rows": rows, "total": total.Money(cur), "meta": m}, nil
}

func importCoverage(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in scopeIn
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	var from, to time.Time
	if v.From != nil {
		from = *v.From
	}
	if v.To != nil {
		to = *v.To
	}
	cov, err := imports.Coverage(ctx, s.db, v.P.ID, accIDs, from, to)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	m.warn("statuses: complete = statement balances reconcile; unverified = no balances to check; conflicting = balances disagree; missing = no import")
	return map[string]any{"accounts": cov, "meta": m}, nil
}

func uncategorized(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		scopeIn
		DateFrom *string `json:"dateFrom"`
		DateTo   *string `json:"dateTo"`
		Limit    int     `json:"limit"`
		Cursor   string  `json:"cursor"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	accIDs, err := v.accounts(in.AccountIDs)
	if err != nil {
		return nil, err
	}
	m := newMeta()
	from, to, err := v.clamp(in.DateFrom, in.DateTo, fin.Date(1900, 1, 1), fin.Date(2999, 12, 31), m)
	if err != nil {
		return nil, err
	}
	f := imports.InboxFilter{AccountIDs: accIDs, From: &from, To: &to, Limit: min(in.Limit, s.maxRows)}
	if in.Cursor != "" {
		f.After = &struct {
			Date string
			ID   uuid.UUID
		}{}
		if err := httpx.DecodeCursor(in.Cursor, f.After); err != nil {
			return nil, err
		}
	}
	items, more, err := imports.Uncategorized(ctx, s.db, v.P.ID, f)
	if err != nil {
		return nil, err
	}
	if more {
		last := items[len(items)-1]
		m.NextCursor = httpx.EncodeCursor(struct {
			Date string
			ID   uuid.UUID
		}{last.BookingDate, last.ID})
		m.Complete = false
	}
	return map[string]any{"transactions": items, "meta": m}, nil
}

func simulateExpense(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID  *uuid.UUID  `json:"profileId"`
		AccountID  *uuid.UUID  `json:"accountId"`
		Amount     money.Money `json:"amount"`
		Date       string      `json:"date"`
		Recurrence *string     `json:"recurrence"`
		Days       int         `json:"days"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	if in.Amount.Sign() <= 0 {
		return nil, httpx.Validation(map[string]string{"amount": "must be positive"})
	}
	v, err := s.view(ctx, in.ProfileID, def.Scopes)
	if err != nil {
		return nil, err
	}
	if err := v.current(); err != nil {
		return nil, err
	}
	var accIDs []uuid.UUID
	if in.AccountID != nil {
		accIDs = []uuid.UUID{*in.AccountID}
	}
	if accIDs, err = v.accounts(accIDs); err != nil {
		return nil, err
	}
	cur := v.P.BaseCurrency
	base, err := forecastFor(ctx, s, v, accIDs, cur, in.Days, nil)
	if err != nil {
		return nil, err
	}
	neg := in.Amount.Neg()
	adj := forecasting.Adjustment{Description: "What-if expense (MCP simulation)", Amount: &neg, Date: in.Date, AccountID: in.AccountID}
	if in.Recurrence != nil {
		adj.RRule = *in.Recurrence
	}
	after, err := forecastFor(ctx, s, v, accIDs, cur, in.Days, []forecasting.Adjustment{adj})
	if err != nil {
		return nil, err
	}
	m := newMeta()
	m.merge(after.Complete, after.Warnings, after.MissingRates)
	var first *string
	for _, sf := range after.Shortfalls {
		if sf.Scenario == "expected" || sf.Scenario == "" {
			d := sf.Date
			first = &d
			break
		}
	}
	return map[string]any{"lowestBefore": base.Lowest.Amount, "lowestAfter": after.Lowest.Amount, "lowestAfterDate": after.Lowest.Date,
		"firstShortfallDate": first, "safeToSpendBefore": base.SafeToSpend, "safeToSpendAfter": after.SafeToSpend, "meta": m}, nil
}
