package conformance_test

import (
	"context"
	"encoding/json"
	"math/big"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/analytics"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics/fin"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// aggregation.json against the REST/MCP analytics code (DB-bound): each case seeds the fixture
// ledger into a fresh profile and compares the Go result with the TS engine's expected output.
// Rows with equal amounts are compared without order (TS breaks ties by fixture key, Go by uuid).

type aggTxn struct {
	ID                   string  `json:"id"`
	Kind                 string  `json:"kind"`
	Status               string  `json:"status"`
	BookingDate          string  `json:"bookingDate"`
	ExcludeFromReports   bool    `json:"excludeFromReports"`
	DeletedAt            *string `json:"deletedAt"`
	MerchantID           *string `json:"merchantId"`
	Payee                string  `json:"payee"`
	Description          string  `json:"description"`
	RelatedTransactionID *string `json:"relatedTransactionId"`
	Postings             []struct {
		AccountID string `json:"accountId"`
		Amount    wire   `json:"amount"`
	} `json:"postings"`
	Splits []struct {
		CategoryID *string `json:"categoryId"`
		Amount     wire    `json:"amount"`
	} `json:"splits"`
}

type aggFixture struct {
	Categories []struct {
		ID       string  `json:"id"`
		ParentID *string `json:"parentId"`
		Name     string  `json:"name"`
	} `json:"categories"`
	Accounts []struct {
		ID          string `json:"id"`
		AccountType string `json:"accountType"`
	} `json:"accounts"`
	Merchants []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"merchants"`
	Transactions []aggTxn `json:"transactions"`
	Rates        []fxRate `json:"rates"`
	Cases        []struct {
		Name   string `json:"name"`
		Op     string `json:"op"`
		Params struct {
			From              string   `json:"from"`
			To                string   `json:"to"`
			Currency          string   `json:"currency"`
			Kind              string   `json:"kind"`
			Rollup            string   `json:"rollup"`
			AccountIDs        []string `json:"accountIds"`
			ExtraTransactions []aggTxn `json:"extraTransactions"`
			AsOf              string   `json:"asOf"`
			Income            *wire    `json:"income"`
			Expense           *wire    `json:"expense"`
			Granularity       string   `json:"granularity"`
		} `json:"params"`
		Expected json.RawMessage `json:"expected"`
	} `json:"cases"`
}

// seedAggregation writes the fixture ledger into a new profile. Ids are made unique per profile
// by hashing with the profile id; keyOf maps them back to fixture ids.
func seedAggregation(t *testing.T, pool *pgxpool.Pool, f aggFixture, txs []aggTxn) (uuid.UUID, func(string) string, func(string) uuid.UUID) {
	t.Helper()
	_, profile := testdb.SeedUserProfile(t, pool)
	ctx := context.Background()
	back := map[string]string{}
	id := func(s string) uuid.UUID {
		u := uuid.NewSHA1(profile, []byte(s))
		back[u.String()] = s
		return u
	}
	ptr := func(s *string) *uuid.UUID {
		if s == nil {
			return nil
		}
		u := id(*s)
		return &u
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, sql)
		}
	}
	for _, c := range f.Categories {
		exec(`INSERT INTO categories (id, profile_id, parent_id, name) VALUES ($1,$2,$3,$4)`, id(c.ID), profile, ptr(c.ParentID), c.Name)
	}
	for _, m := range f.Merchants {
		exec(`INSERT INTO merchants (id, profile_id, name, normalized_name) VALUES ($1,$2,$3,lower($3))`, id(m.ID), profile, m.Name)
	}
	types := map[string]string{}
	for _, a := range f.Accounts {
		types[a.ID] = a.AccountType
	}
	seen := map[string]bool{}
	for _, tx := range txs {
		for _, p := range tx.Postings {
			if seen[p.AccountID] {
				continue
			}
			seen[p.AccountID] = true
			typ := types[p.AccountID]
			if typ == "" {
				typ = "checking"
			}
			exec(`INSERT INTO accounts (id, profile_id, name, account_type, currency, is_multi_currency) VALUES ($1,$2,$3,$4,$5,true)`,
				id(p.AccountID), profile, p.AccountID, typ, p.Amount.Currency)
		}
	}
	for _, tx := range txs {
		exec(`INSERT INTO transactions (id, profile_id, kind, status, booking_date, description, payee, merchant_id, exclude_from_reports, deleted_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, id(tx.ID), profile, tx.Kind, tx.Status, tx.BookingDate, tx.Description, tx.Payee,
			ptr(tx.MerchantID), tx.ExcludeFromReports, tx.DeletedAt)
		for i, p := range tx.Postings {
			exec(`INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency, line_no) VALUES ($1,$2,$3,$4,$5,$6)`,
				profile, id(tx.ID), id(p.AccountID), p.Amount.Amount, p.Amount.Currency, i)
		}
		for _, s := range tx.Splits {
			exec(`INSERT INTO transaction_splits (profile_id, transaction_id, category_id, amount, currency) VALUES ($1,$2,$3,$4,$5)`,
				profile, id(tx.ID), ptr(s.CategoryID), s.Amount.Amount, s.Amount.Currency)
		}
	}
	for _, tx := range txs {
		if tx.RelatedTransactionID != nil {
			exec(`UPDATE transactions SET related_transaction_id = $1 WHERE id = $2`, id(*tx.RelatedTransactionID), id(tx.ID))
		}
	}
	keyOf := func(k string) string {
		if v, ok := back[k]; ok {
			return v
		}
		return k
	}
	return profile, keyOf, id
}

type aggRow struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Amount wire   `json:"amount"`
	Count  int    `json:"count"`
}

type aggRows struct {
	Rows     []aggRow `json:"rows"`
	Total    wire     `json:"total"`
	Complete bool     `json:"complete"`
	Missing  []any    `json:"-"`
}

// canon sorts rows by amount desc, then key, so ties compare without order.
func canon(r []aggRow) []aggRow {
	out := append([]aggRow(nil), r...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].Amount, out[j].Amount
		if c := cmpWire(a, b); c != 0 {
			return c > 0
		}
		return out[i].Key < out[j].Key
	})
	return out
}

func cmpWire(a, b wire) int {
	ra, _ := new(big.Rat).SetString(a.Amount)
	rb, _ := new(big.Rat).SetString(b.Amount)
	return ra.Cmp(rb)
}

func TestAggregation(t *testing.T) {
	var f aggFixture
	load(t, "aggregation", &f)
	pool := testdb.New(t)
	ctx := context.Background()
	for _, c := range f.Cases {
		t.Run(c.Op+"/"+c.Name, func(t *testing.T) {
			p := c.Params
			switch c.Op {
			case "savingsRate":
				inc, exp := p.Income.money(t), p.Expense.money(t)
				var got *string
				if inc.Sign() > 0 {
					n, _ := inc.Sub(exp)
					r := fin.Ratio(n, inc, 4)
					got = &r
				}
				var want *string
				if err := json.Unmarshal(c.Expected, &want); err != nil {
					t.Fatal(err)
				}
				if (got == nil) != (want == nil) || (got != nil && *got != *want) {
					t.Errorf("got %v want %v", deref(got), deref(want))
				}
				return
			}
			txs := append(append([]aggTxn(nil), f.Transactions...), p.ExtraTransactions...)
			profile, keyOf, id := seedAggregation(t, pool, f, txs)
			insertRates(t, pool, profile, f.Rates)
			compareJSON := func(got any) {
				t.Helper()
				gj, _ := json.Marshal(got)
				var w any
				if err := json.Unmarshal(c.Expected, &w); err != nil {
					t.Fatal(err)
				}
				wj, _ := json.Marshal(w)
				var g any
				_ = json.Unmarshal(gj, &g)
				gj, _ = json.Marshal(g) // canonical key order on both sides
				if string(gj) != string(wj) {
					t.Errorf("got  %s\nwant %s", gj, wj)
				}
			}
			switch c.Op {
			case "cashflow":
				gran := p.Granularity
				if gran == "" {
					gran = "month"
				}
				r, err := analytics.Cashflow(ctx, pool, analytics.Query{P: fin.Profile{ID: profile, BaseCurrency: "BAM", Timezone: "UTC", Today: day(t, p.To)},
					From: day(t, p.From), To: day(t, p.To), Currency: p.Currency, Interval: gran})
				if err != nil {
					t.Fatal(err)
				}
				type per struct {
					Period      string  `json:"period,omitempty"`
					Income      wire    `json:"income"`
					Expense     wire    `json:"expense"`
					Net         wire    `json:"net"`
					SavingsRate *string `json:"savingsRate"`
				}
				w := func(m analytics.CashflowPeriod) per {
					return per{m.Period, wire{m.Income.Amount(), m.Income.Currency()}, wire{m.Expense.Amount(), m.Expense.Currency()},
						wire{m.Net.Amount(), m.Net.Currency()}, m.SavingsRate}
				}
				out := struct {
					Periods      []per `json:"periods"`
					Totals       per   `json:"totals"`
					Complete     bool  `json:"complete"`
					MissingRates []any `json:"missingRates"`
				}{Periods: []per{}, Totals: w(r.Totals), Complete: r.Complete, MissingRates: []any{}}
				for _, x := range r.Periods {
					out.Periods = append(out.Periods, w(x))
				}
				for _, m := range r.MissingRates {
					out.MissingRates = append(out.MissingRates, m)
				}
				compareJSON(out)
				return
			case "netWorth":
				r, err := analytics.NetWorthAt(ctx, pool, profile, day(t, p.AsOf), p.Currency)
				if err != nil {
					t.Fatal(err)
				}
				compareJSON(r)
				return
			}
			if c.Op == "balances" {
				asOf := time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
				if p.AsOf != "" {
					asOf = day(t, p.AsOf)
				}
				bal, err := fin.Balances(ctx, pool, profile, asOf)
				if err != nil {
					t.Fatal(err)
				}
				type b struct {
					AccountID string `json:"accountId"`
					Amount    string `json:"amount"`
					Currency  string `json:"currency"`
				}
				var got, want []b
				for _, x := range bal {
					got = append(got, b{keyOf(x.AccountID.String()), x.Amount.Amount(), x.Amount.Currency()})
				}
				sort.Slice(got, func(i, j int) bool { return got[i].AccountID+got[i].Currency < got[j].AccountID+got[j].Currency })
				if err := json.Unmarshal(c.Expected, &want); err != nil {
					t.Fatal(err)
				}
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(want)
				if string(gj) != string(wj) {
					t.Errorf("got %s\nwant %s", gj, wj)
				}
				return
			}
			q := analytics.Query{P: fin.Profile{ID: profile, BaseCurrency: "BAM", Timezone: "UTC", Today: day(t, p.To)},
				From: day(t, p.From), To: day(t, p.To), Currency: p.Currency, Interval: "none"}
			if p.Rollup == "parent" {
				q.GroupBy = "parent"
			}
			for _, a := range p.AccountIDs {
				q.AccountIDs = append(q.AccountIDs, id(a))
			}
			var res fin.Rows
			var err error
			switch c.Op {
			case "byCategory":
				if p.Kind == "income" {
					res, err = analytics.IncomeByCategory(ctx, pool, q)
				} else {
					res, err = analytics.SpendingByCategory(ctx, pool, q)
				}
			case "byMerchant":
				res, err = analytics.SpendingByMerchant(ctx, pool, q)
			default:
				t.Fatalf("unknown op %s", c.Op)
			}
			if err != nil {
				t.Fatal(err)
			}
			var got, want aggRows
			got.Total, got.Complete = wire{res.Total.Amount(), res.Total.Currency()}, res.Complete
			got.Missing = make([]any, len(res.MissingRates))
			for _, r := range res.Rows {
				got.Rows = append(got.Rows, aggRow{keyOf(r.Key), r.Label, wire{r.Amount.Amount(), r.Amount.Currency()}, r.Count})
			}
			if err := json.Unmarshal(c.Expected, &want); err != nil {
				t.Fatal(err)
			}
			var wm struct {
				M []any `json:"missingRates"`
			}
			_ = json.Unmarshal(c.Expected, &wm)
			want.Missing = wm.M
			got.Rows, want.Rows = canon(got.Rows), canon(want.Rows)
			gj, _ := json.Marshal(got)
			wj, _ := json.Marshal(want)
			// missing rates: compare the count only (TS lists from/to/date, Go the same fields)
			if string(gj) != string(wj) || len(got.Missing) != len(want.Missing) {
				t.Errorf("got  %s\nwant %s", gj, wj)
			}
		})
	}
}

func deref(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}
