package fin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Flow is one categorized income/expense/refund amount (a split, or the whole posting of a
// transaction without splits). Amount is a positive magnitude in the posting currency.
// Transfers, fx, opening balances and adjustments are never flows (financial invariant 9).
type Flow struct {
	TransactionID uuid.UUID
	Date          time.Time
	Kind          string // income | expense | refund
	CategoryID    *uuid.UUID
	MerchantID    *uuid.UUID
	AccountID     uuid.UUID
	Amount        money.Money
	Description   string
	Payee         string
}

// Spending is the signed contribution to spending: expense +, refund -, income 0.
func (f Flow) Spending() money.Money {
	switch f.Kind {
	case "expense":
		return f.Amount
	case "refund":
		return f.Amount.Neg()
	}
	return Zero(f.Amount.Currency())
}

// Flows returns income/expense/refund amounts with booking dates in [from, to]. Excluded, voided
// and deleted transactions never count. accountIDs nil = all accounts.
func Flows(ctx context.Context, db DB, profileID uuid.UUID, from, to time.Time, accountIDs []uuid.UUID) ([]Flow, error) {
	var accs any
	if accountIDs != nil {
		accs = accountIDs
	}
	rows, err := db.Query(ctx, `
		WITH tx AS (
		  SELECT t.id, t.booking_date, t.kind,
		         -- a refund without its own merchant nets against the refunded transaction's merchant
		         CASE WHEN o.id IS NULL THEN t.merchant_id ELSE o.merchant_id END AS merchant_id,
		         CASE WHEN o.id IS NULL THEN t.description ELSE o.description END AS description,
		         CASE WHEN o.id IS NULL THEN t.payee ELSE o.payee END AS payee,
		         (SELECT p.account_id FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL ORDER BY p.line_no, p.id LIMIT 1) AS account_id
		  FROM transactions t
		  LEFT JOIN transactions o ON t.kind = 'refund' AND t.merchant_id IS NULL AND o.id = t.related_transaction_id AND o.profile_id = t.profile_id
		  WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.status <> 'void' AND NOT t.exclude_from_reports
		    AND t.kind IN ('income','expense','refund') AND t.booking_date BETWEEN $2 AND $3)
		SELECT tx.id, tx.booking_date, tx.kind, s.category_id, tx.merchant_id, tx.account_id, s.amount, s.currency, tx.description, tx.payee
		FROM tx JOIN transaction_splits s ON s.transaction_id = tx.id AND s.deleted_at IS NULL AND s.profile_id = $1
		WHERE tx.account_id IS NOT NULL AND ($4::uuid[] IS NULL OR tx.account_id = ANY($4))
		UNION ALL
		SELECT tx.id, tx.booking_date, tx.kind, NULL, tx.merchant_id, p.account_id, abs(p.amount), p.currency, tx.description, tx.payee
		FROM tx JOIN postings p ON p.transaction_id = tx.id AND p.deleted_at IS NULL AND p.profile_id = $1
		WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = tx.id AND s.deleted_at IS NULL)
		  AND ($4::uuid[] IS NULL OR p.account_id = ANY($4))
		ORDER BY 2, 1`, profileID, from, to, accs)
	if err != nil {
		return nil, fmt.Errorf("flows: %w", err)
	}
	defer rows.Close()
	var out []Flow
	for rows.Next() {
		var f Flow
		var amt pgtype.Numeric
		var cur string
		if err := rows.Scan(&f.TransactionID, &f.Date, &f.Kind, &f.CategoryID, &f.MerchantID, &f.AccountID, &amt, &cur, &f.Description, &f.Payee); err != nil {
			return nil, err
		}
		if f.Amount, err = NumericMoney(amt, cur); err != nil {
			return nil, err
		}
		f.Date = AsDate(f.Date)
		out = append(out, f)
	}
	return out, rows.Err()
}

type Account struct {
	ID              uuid.UUID
	Name            string
	Type            string
	Classification  string // asset | liability
	Currency        string
	IncludeNetWorth bool
	IncludeSafe     bool
	Archived        bool
	CreditLimit     *money.Money // account currency; nil = no limit
}

// Accounts returns the profile's non-deleted accounts.
func Accounts(ctx context.Context, db DB, profileID uuid.UUID) ([]Account, error) {
	rows, err := db.Query(ctx, `SELECT a.id, a.name, a.account_type, t.classification, a.currency,
		a.include_in_net_worth, a.include_in_safe_to_spend, a.is_archived, a.credit_limit
		FROM accounts a JOIN account_types t ON t.code = a.account_type
		WHERE a.profile_id = $1 AND a.deleted_at IS NULL ORDER BY a.sort_order, a.name, a.id`, profileID)
	if err != nil {
		return nil, fmt.Errorf("accounts: %w", err)
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		var limit pgtype.Numeric
		if err := rows.Scan(&a.ID, &a.Name, &a.Type, &a.Classification, &a.Currency, &a.IncludeNetWorth, &a.IncludeSafe, &a.Archived, &limit); err != nil {
			return nil, err
		}
		a.Currency = strings.TrimSpace(a.Currency)
		if a.CreditLimit, err = OptMoney(limit, a.Currency); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type Balance struct {
	AccountID uuid.UUID
	Amount    money.Money
}

// Balances = sum of non-deleted postings of non-deleted, non-void transactions booked on or before
// asOf, per account and currency (financial invariant 6).
func Balances(ctx context.Context, db DB, profileID uuid.UUID, asOf time.Time) ([]Balance, error) {
	rows, err := db.Query(ctx, `SELECT p.account_id, p.currency, sum(p.amount)
		FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.profile_id = $1 AND t.profile_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
		  AND t.status <> 'void' AND t.booking_date <= $2
		GROUP BY 1, 2 ORDER BY 1, 2`, profileID, asOf)
	if err != nil {
		return nil, fmt.Errorf("balances: %w", err)
	}
	defer rows.Close()
	var out []Balance
	for rows.Next() {
		var b Balance
		var n pgtype.Numeric
		var cur string
		if err := rows.Scan(&b.AccountID, &cur, &n); err != nil {
			return nil, err
		}
		if b.Amount, err = NumericMoney(n, cur); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// FuturePosting is a posting booked after a date (scheduled/pending transactions already in the ledger).
type FuturePosting struct {
	TransactionID uuid.UUID
	AccountID     uuid.UUID
	Date          time.Time
	Amount        money.Money
	Description   string
	Kind          string
}

// FuturePostings returns postings of live transactions booked in (after, until].
func FuturePostings(ctx context.Context, db DB, profileID uuid.UUID, after, until time.Time) ([]FuturePosting, error) {
	rows, err := db.Query(ctx, `SELECT t.id, p.account_id, t.booking_date, p.amount, p.currency, CASE WHEN t.description <> '' THEN t.description ELSE t.payee END, t.kind
		FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.profile_id = $1 AND t.profile_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
		  AND t.status <> 'void' AND t.booking_date > $2 AND t.booking_date <= $3
		ORDER BY t.booking_date, t.id`, profileID, after, until)
	if err != nil {
		return nil, fmt.Errorf("future postings: %w", err)
	}
	defer rows.Close()
	var out []FuturePosting
	for rows.Next() {
		var f FuturePosting
		var n pgtype.Numeric
		var cur string
		if err := rows.Scan(&f.TransactionID, &f.AccountID, &f.Date, &n, &cur, &f.Description, &f.Kind); err != nil {
			return nil, err
		}
		if f.Amount, err = NumericMoney(n, cur); err != nil {
			return nil, err
		}
		f.Date = AsDate(f.Date)
		out = append(out, f)
	}
	return out, rows.Err()
}

type Category struct {
	ID       uuid.UUID
	ParentID *uuid.UUID
	Name     string
	Kind     string
}

// Categories returns all categories (including deleted ones, so history keeps its labels).
func Categories(ctx context.Context, db DB, profileID uuid.UUID) (map[uuid.UUID]Category, error) {
	rows, err := db.Query(ctx, `SELECT id, parent_id, name, kind FROM categories WHERE profile_id = $1`, profileID)
	if err != nil {
		return nil, fmt.Errorf("categories: %w", err)
	}
	defer rows.Close()
	out := map[uuid.UUID]Category{}
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.ParentID, &c.Name, &c.Kind); err != nil {
			return nil, err
		}
		out[c.ID] = c
	}
	return out, rows.Err()
}

// Root walks to the top-level ancestor (cycle-safe).
func Root(cats map[uuid.UUID]Category, id uuid.UUID) uuid.UUID {
	seen := map[uuid.UUID]bool{}
	for {
		c, ok := cats[id]
		if !ok || c.ParentID == nil || seen[id] {
			return id
		}
		seen[id] = true
		id = *c.ParentID
	}
}

// IsWithin reports whether id is ancestor or equal to the category id (cycle-safe).
func IsWithin(cats map[uuid.UUID]Category, id, ancestor uuid.UUID) bool {
	seen := map[uuid.UUID]bool{}
	for !seen[id] {
		if id == ancestor {
			return true
		}
		seen[id] = true
		c, ok := cats[id]
		if !ok || c.ParentID == nil {
			return false
		}
		id = *c.ParentID
	}
	return false
}

// Setting reads one key of the profile settings object (PUT/PATCH /profiles/{id}/settings, the
// settings row with key 'settings') into v; ok=false when unset or null.
func Setting(ctx context.Context, db DB, profileID uuid.UUID, key string, v any) (bool, error) {
	var raw []byte
	err := db.QueryRow(ctx, `SELECT value -> $2 FROM settings WHERE scope = 'profile' AND owner_id = $1 AND key = 'settings'`, profileID, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (raw == nil || string(raw) == "null")) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, v)
}

var ownedTables = map[string]bool{"accounts": true, "categories": true, "merchants": true, "transactions": true,
	"tags": true, "planned_transactions": true, "savings_goals": true, "budgets": true, "split_templates": true}

// Owned reports whether a non-deleted row with id exists in the profile (table from a fixed allowlist).
func Owned(ctx context.Context, db DB, table string, id, profileID uuid.UUID) (bool, error) {
	if !ownedTables[table] {
		return false, fmt.Errorf("fin.Owned: table %q not allowed", table)
	}
	var ok bool
	err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+table+` WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL)`, id, profileID).Scan(&ok)
	return ok, err
}

// CheckOwned adds a validation error when an optional reference is not in the profile.
func CheckOwned(ctx context.Context, db DB, v Validator, field, table string, id *uuid.UUID, profileID uuid.UUID) error {
	if id == nil {
		return nil
	}
	ok, err := Owned(ctx, db, table, *id, profileID)
	if err != nil {
		return err
	}
	v.Check(ok, field, "not found in this profile")
	return nil
}
