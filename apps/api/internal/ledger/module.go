// Package ledger: Balance reconstruction from postings, balance history, reconciliation, opening balances.
// It also owns the transaction write primitives (Create/Update/Delete) that keep the ledger invariants;
// the transactions, accounts and sync modules write through them.
//
// Owned routes under /api/v1: /balances, /accounts/{id}/balance-history, /reconciliations
// See docs/api/openapi.yaml for the contract.
package ledger

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// balanceWhere is THE definition of what counts towards a balance (financial invariant 6).
const balanceWhere = `p.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status <> 'void'`

// AccountBalance is one account's balance in one currency.
type AccountBalance struct {
	AccountID uuid.UUID
	Amount    money.Money
}

// Balances sums postings per account and currency for the profile, as of asOf ("" = all dates).
// accountIDs filters when non-empty. Accounts without postings are not returned.
func Balances(ctx context.Context, db DB, profileID uuid.UUID, asOf string, accountIDs []uuid.UUID) ([]AccountBalance, error) {
	rows, err := db.Query(ctx, `SELECT p.account_id, p.currency, SUM(p.amount)
		FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.profile_id = $1 AND `+balanceWhere+` AND ($2 = '' OR t.booking_date <= NULLIF($2, '')::date)
		  AND ($3::uuid[] IS NULL OR cardinality($3::uuid[]) = 0 OR p.account_id = ANY($3))
		GROUP BY 1, 2 ORDER BY 1, 2`, profileID, asOf, accountIDs)
	if err != nil {
		return nil, fmt.Errorf("balances: %w", err)
	}
	defer rows.Close()
	var out []AccountBalance
	for rows.Next() {
		var b AccountBalance
		var cur string
		var sum pgtype.Numeric
		if err := rows.Scan(&b.AccountID, &cur, &sum); err != nil {
			return nil, err
		}
		if b.Amount, err = money.FromNumeric(sum, cur); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// AccountBalanceIn is the balance of one account in one currency as of a date ("" = all).
func AccountBalanceIn(ctx context.Context, db DB, profileID, accountID uuid.UUID, currency, asOf string) (money.Money, error) {
	var sum pgtype.Numeric
	err := db.QueryRow(ctx, `SELECT COALESCE(SUM(p.amount), 0) FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.profile_id = $1 AND p.account_id = $2 AND p.currency = $3 AND `+balanceWhere+`
		  AND ($4 = '' OR t.booking_date <= NULLIF($4, '')::date)`, profileID, accountID, currency, asOf).Scan(&sum)
	if err != nil {
		return money.Money{}, err
	}
	return money.FromNumeric(sum, currency)
}

// Converter converts m into currency `to` on date using the profile's visible rates. ok=false when no
// rate is available. Implemented by exchangerates (which imports this package) and installed in its init.
type Converter func(ctx context.Context, db DB, profileID uuid.UUID, m money.Money, to, date string) (money.Money, bool, error)

type balanceItem struct {
	AccountID      uuid.UUID    `json:"accountId"`
	Amount         money.Money  `json:"amount"`
	Converted      *money.Money `json:"converted"`
	Classification string       `json:"classification"`
}

type balancesResponse struct {
	AsOf         string        `json:"asOf"`
	Currency     string        `json:"currency"`
	Balances     []balanceItem `json:"balances"`
	NetWorth     *money.Money  `json:"netWorth"`
	Assets       *money.Money  `json:"assets"`
	Liabilities  *money.Money  `json:"liabilities"`
	MissingRates []string      `json:"missingRates"`
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	r.Get("/balances", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		q := r.URL.Query()
		asOf := q.Get("asOf")
		if asOf == "" {
			if asOf, err = Today(r.Context(), deps.DB, profileID); err != nil {
				return err
			}
		} else if ValidDate(asOf) != nil {
			return httpx.Validation(map[string]string{"asOf": "expected YYYY-MM-DD"})
		}
		var ids []uuid.UUID
		for _, s := range q["accountId"] {
			id, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation(map[string]string{"accountId": "invalid uuid"})
			}
			ids = append(ids, id)
		}
		cur := q.Get("currency")
		if cur == "" {
			if err := deps.DB.QueryRow(r.Context(), `SELECT base_currency FROM profiles WHERE id = $1`, profileID).Scan(&cur); err != nil {
				return err
			}
		} else if _, ok := money.Scale(cur); !ok {
			return httpx.Validation(map[string]string{"currency": "unknown currency"})
		}
		res, err := BalanceSummary(r.Context(), deps.DB, profileID, asOf, cur, ids)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))

	r.Get("/accounts/{id}/balance-history", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleViewer)
		if err != nil {
			return err
		}
		id, err := IDParam(r, "id", "account")
		if err != nil {
			return err
		}
		var acctCur string
		err = deps.DB.QueryRow(r.Context(), `SELECT currency FROM accounts WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID).Scan(&acctCur)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.NotFound("account")
		}
		if err != nil {
			return err
		}
		q := r.URL.Query()
		cur := q.Get("currency")
		if cur == "" {
			cur = acctCur
		} else if _, ok := money.Scale(cur); !ok {
			return httpx.Validation(map[string]string{"currency": "unknown currency"})
		}
		to, from := q.Get("to"), q.Get("from")
		if to == "" {
			if to, err = Today(r.Context(), deps.DB, profileID); err != nil {
				return err
			}
		}
		toD, err1 := time.Parse(time.DateOnly, to)
		if from == "" {
			from = toD.AddDate(0, 0, -89).Format(time.DateOnly)
		}
		fromD, err2 := time.Parse(time.DateOnly, from)
		if err1 != nil || err2 != nil || fromD.After(toD) || toD.Sub(fromD) > 3700*24*time.Hour {
			return httpx.Validation(map[string]string{"from": "from/to must be YYYY-MM-DD, from <= to, at most ~10 years apart"})
		}
		points, err := History(r.Context(), deps.DB, profileID, id, cur, fromD, toD)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"currency": cur, "points": points})
		return nil
	}))

	r.With(httpx.Idempotent(deps.DB)).Post("/reconciliations", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)
		if err != nil {
			return err
		}
		var in struct {
			AccountID        uuid.UUID    `json:"accountId"`
			StatementDate    string       `json:"statementDate"`
			StatementBalance *money.Money `json:"statementBalance"`
			CreateAdjustment bool         `json:"createAdjustment"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		if in.StatementBalance == nil || ValidDate(in.StatementDate) != nil {
			return httpx.Validation(map[string]string{"statementBalance": "required", "statementDate": "required YYYY-MM-DD"})
		}
		tx, err := deps.DB.Begin(r.Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(context.WithoutCancel(r.Context()))
		res, err := Reconcile(r.Context(), tx, profileID, in.AccountID, in.StatementDate, *in.StatementBalance, in.CreateAdjustment)
		if err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, res)
		return nil
	}))
}

// DefaultConverter is installed by the exchangerates package (init) so that net worth can be valued in
// the reporting currency without an import cycle. nil = only same-currency balances are converted.
var DefaultConverter Converter

// BalanceSummary returns every non-deleted account's balances as of asOf with values converted to cur,
// plus net worth (accounts included in net worth), assets and liabilities (by account type).
// If any rate is missing the totals are null and missingRates lists the pairs (never a guessed rate).
func BalanceSummary(ctx context.Context, db DB, profileID uuid.UUID, asOf, cur string, accountIDs []uuid.UUID) (*balancesResponse, error) {
	type acct struct {
		currency, class string
		inNetWorth      bool
	}
	accts := map[uuid.UUID]acct{}
	var order []uuid.UUID
	rows, err := db.Query(ctx, `SELECT a.id, a.currency, at.classification, a.include_in_net_worth FROM accounts a
		JOIN account_types at ON at.code = a.account_type
		WHERE a.profile_id = $1 AND a.deleted_at IS NULL AND ($2::uuid[] IS NULL OR cardinality($2::uuid[]) = 0 OR a.id = ANY($2))
		ORDER BY a.sort_order, a.name, a.id`, profileID, accountIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var a acct
		if err := rows.Scan(&id, &a.currency, &a.class, &a.inNetWorth); err != nil {
			rows.Close()
			return nil, err
		}
		accts[id] = a
		order = append(order, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	bals, err := Balances(ctx, db, profileID, asOf, accountIDs)
	if err != nil {
		return nil, err
	}
	byAcct := map[uuid.UUID][]money.Money{}
	for _, b := range bals {
		byAcct[b.AccountID] = append(byAcct[b.AccountID], b.Amount)
	}
	zero, _ := money.Zero(cur)
	net, assets, liab := zero, zero, zero
	res := &balancesResponse{AsOf: asOf, Currency: cur, Balances: []balanceItem{}, MissingRates: []string{}}
	missing := map[string]bool{}
	for _, id := range order {
		a := accts[id]
		amounts := byAcct[id]
		if len(amounts) == 0 {
			z, _ := money.Zero(a.currency)
			amounts = []money.Money{z}
		}
		for _, m := range amounts {
			item := balanceItem{AccountID: id, Amount: m, Classification: a.class}
			conv, ok := m, m.Currency() == cur
			if !ok && DefaultConverter != nil {
				conv, ok, err = DefaultConverter(ctx, db, profileID, m, cur, asOf)
				if err != nil {
					return nil, err
				}
			}
			if !ok {
				missing[m.Currency()+"/"+cur] = true
			} else {
				c := conv
				item.Converted = &c
				if a.inNetWorth {
					net, _ = net.Add(conv)
					if a.class == "liability" {
						liab, _ = liab.Add(conv)
					} else {
						assets, _ = assets.Add(conv)
					}
				}
			}
			res.Balances = append(res.Balances, item)
		}
	}
	for k := range missing {
		res.MissingRates = append(res.MissingRates, k)
	}
	if len(missing) == 0 {
		res.NetWorth, res.Assets, res.Liabilities = &net, &assets, &liab
	}
	return res, nil
}

// BalancePoint is the end-of-day balance.
type BalancePoint struct {
	Date    string      `json:"date"`
	Balance money.Money `json:"balance"`
}

// History returns one end-of-day point per calendar day in [from, to] for the account in currency cur.
func History(ctx context.Context, db DB, profileID, accountID uuid.UUID, cur string, from, to time.Time) ([]BalancePoint, error) {
	running, err := AccountBalanceIn(ctx, db, profileID, accountID, cur, from.AddDate(0, 0, -1).Format(time.DateOnly))
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `SELECT t.booking_date::text, SUM(p.amount) FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.profile_id = $1 AND p.account_id = $2 AND p.currency = $3 AND `+balanceWhere+`
		  AND t.booking_date BETWEEN $4::date AND $5::date GROUP BY 1`, profileID, accountID, cur,
		from.Format(time.DateOnly), to.Format(time.DateOnly))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	daily := map[string]money.Money{}
	for rows.Next() {
		var d string
		var sum pgtype.Numeric
		if err := rows.Scan(&d, &sum); err != nil {
			return nil, err
		}
		if daily[d], err = money.FromNumeric(sum, cur); err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var points []BalancePoint
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		key := d.Format(time.DateOnly)
		if m, ok := daily[key]; ok {
			running, _ = running.Add(m)
		}
		points = append(points, BalancePoint{Date: key, Balance: running})
	}
	return points, nil
}

// Reconciliation compares a statement balance with the ledger.
type Reconciliation struct {
	AccountID               uuid.UUID   `json:"accountId"`
	StatementDate           string      `json:"statementDate"`
	StatementBalance        money.Money `json:"statementBalance"`
	LedgerBalance           money.Money `json:"ledgerBalance"`
	Difference              money.Money `json:"difference"`
	AdjustmentTransactionID *uuid.UUID  `json:"adjustmentTransactionId"`
}

// Reconcile computes the difference between statement and ledger balance on statementDate and, when
// asked and non-zero, records an `adjustment` transaction for it (never touching existing postings).
func Reconcile(ctx context.Context, tx pgx.Tx, profileID, accountID uuid.UUID, date string, statement money.Money, adjust bool) (*Reconciliation, error) {
	if ok, err := Owned(ctx, tx, "accounts", profileID, []uuid.UUID{accountID}); err != nil || !ok {
		return nil, firstErr(err, httpx.NotFound("account"))
	}
	ledgerBal, err := AccountBalanceIn(ctx, tx, profileID, accountID, statement.Currency(), date)
	if err != nil {
		return nil, err
	}
	diff, _ := statement.Sub(ledgerBal)
	res := &Reconciliation{AccountID: accountID, StatementDate: date, StatementBalance: statement, LedgerBalance: ledgerBal, Difference: diff}
	if adjust && !diff.IsZero() {
		t, err := Create(ctx, tx, &Transaction{ProfileID: profileID, Kind: "adjustment", Status: "reconciled", BookingDate: date,
			Description: "Reconciliation adjustment (statement " + date + ")", Source: "manual",
			Postings: []Posting{{AccountID: accountID, Amount: diff, Memo: "reconciliation"}}},
			"transaction.reconciliation_adjustment", map[string]any{"statementBalance": statement.String(), "ledgerBalance": ledgerBal.String()})
		if err != nil {
			return nil, err
		}
		res.AdjustmentTransactionID = &t.ID
	}
	if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &profileID, Action: "account.reconcile", EntityType: "accounts",
		EntityID: &accountID, After: res}); err != nil {
		return nil, err
	}
	return res, nil
}
