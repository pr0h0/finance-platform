// Package accounts: Financial accounts and account types.
//
// Owned routes under /api/v1: /accounts, /account-types
// See docs/api/openapi.yaml for the contract.
package accounts

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// Account is the API shape (OpenAPI Account). Balances are computed from postings (never stored);
// OpeningBalance is create-only input that records an opening_balance transaction.
type Account struct {
	ledger.Meta
	Name                 string        `json:"name"`
	AccountType          string        `json:"accountType"`
	Currency             string        `json:"currency"`
	IsMultiCurrency      bool          `json:"isMultiCurrency"`
	Institution          string        `json:"institution"`
	AccountNumberMasked  string        `json:"accountNumberMasked"`
	OpeningDate          *string       `json:"openingDate"`
	CreditLimit          *money.Money  `json:"creditLimit"`
	IncludeInNetWorth    bool          `json:"includeInNetWorth"`
	IncludeInSafeToSpend bool          `json:"includeInSafeToSpend"`
	IsArchived           bool          `json:"isArchived"`
	Color                string        `json:"color"`
	Icon                 string        `json:"icon"`
	SortOrder            int           `json:"sortOrder"`
	Notes                string        `json:"notes"`
	Classification       string        `json:"classification"`
	Balances             []money.Money `json:"balances"`
	OpeningBalance       *money.Money  `json:"openingBalance,omitempty"`
}

const cols = `name, account_type, currency, is_multi_currency, institution, account_number_masked, opening_date::text, credit_limit,
	include_in_net_worth, include_in_safe_to_spend, is_archived, color, icon, sort_order, notes,
	(SELECT classification FROM account_types WHERE code = account_type)`

func scan(row pgx.Row) (*Account, error) {
	a := &Account{Balances: []money.Money{}}
	var limit pgtype.Numeric
	err := row.Scan(append(a.Dest(), &a.Name, &a.AccountType, &a.Currency, &a.IsMultiCurrency, &a.Institution, &a.AccountNumberMasked,
		&a.OpeningDate, &limit, &a.IncludeInNetWorth, &a.IncludeInSafeToSpend, &a.IsArchived, &a.Color, &a.Icon, &a.SortOrder, &a.Notes,
		&a.Classification)...)
	if err == nil && limit.Valid {
		m, merr := money.FromNumeric(limit, a.Currency)
		a.CreditLimit, err = &m, merr
	}
	return a, err
}

func write(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, in, cur *Account) error {
	in.Name = strings.TrimSpace(in.Name)
	bad := map[string]string{}
	if in.Name == "" || len(in.Name) > 200 {
		bad["name"] = "required, at most 200 characters"
	}
	if _, ok := money.Scale(in.Currency); !ok {
		bad["currency"] = "unknown currency"
	}
	if in.CreditLimit != nil && (in.CreditLimit.Currency() != in.Currency || in.CreditLimit.Sign() < 0) {
		bad["creditLimit"] = "non-negative, in the account currency"
	}
	if in.OpeningDate != nil && ledger.ValidDate(*in.OpeningDate) != nil {
		bad["openingDate"] = "expected YYYY-MM-DD"
	}
	if len(in.Institution) > 200 || len(in.AccountNumberMasked) > 64 || len(in.Notes) > 5000 || len(in.Color) > 32 || len(in.Icon) > 64 {
		bad["notes"] = "a text field is too long"
	}
	if cur != nil && in.OpeningBalance != nil {
		bad["openingBalance"] = "only on create; edit the opening balance transaction instead"
	}
	var typeOK bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM account_types WHERE code = $1)`, in.AccountType).Scan(&typeOK); err != nil {
		return err
	}
	if !typeOK {
		bad["accountType"] = "unknown account type"
	}
	if len(bad) > 0 {
		return httpx.Validation(bad)
	}
	var limit pgtype.Numeric
	if in.CreditLimit != nil {
		limit = in.CreditLimit.Numeric()
	}
	args := []any{id, profileID, in.Name, in.AccountType, in.Currency, in.IsMultiCurrency, in.Institution, in.AccountNumberMasked,
		in.OpeningDate, limit, in.IncludeInNetWorth, in.IncludeInSafeToSpend, in.IsArchived, in.Color, in.Icon, in.SortOrder, in.Notes}
	if cur != nil {
		if in.Currency != cur.Currency || (cur.IsMultiCurrency && !in.IsMultiCurrency) {
			var used bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM postings WHERE account_id = $1 AND deleted_at IS NULL
				AND (currency <> $2 OR $3))`, id, in.Currency, in.Currency != cur.Currency).Scan(&used); err != nil {
				return err
			}
			if used {
				return httpx.Conflict("the account has postings in another currency; its currency cannot change")
			}
		}
		_, err := tx.Exec(ctx, `UPDATE accounts SET name=$3, account_type=$4, currency=$5, is_multi_currency=$6, institution=$7,
			account_number_masked=$8, opening_date=$9::date, credit_limit=$10, include_in_net_worth=$11, include_in_safe_to_spend=$12,
			is_archived=$13, color=$14, icon=$15, sort_order=$16, notes=$17, version = version + 1 WHERE id=$1 AND profile_id=$2`, args...)
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO accounts (id, profile_id, name, account_type, currency, is_multi_currency, institution,
		account_number_masked, opening_date, credit_limit, include_in_net_worth, include_in_safe_to_spend, is_archived, color, icon,
		sort_order, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16,$17)`, args...)
	if ledger.IsUnique(err) {
		return httpx.Conflict("account id already exists")
	}
	if err != nil || in.OpeningBalance == nil || in.OpeningBalance.IsZero() {
		return err
	}
	date := ""
	if in.OpeningDate != nil {
		date = *in.OpeningDate
	} else if date, err = ledger.Today(ctx, tx, profileID); err != nil {
		return err
	}
	_, err = ledger.Create(ctx, tx, &ledger.Transaction{ProfileID: profileID, Kind: "opening_balance", BookingDate: date,
		Description: "Opening balance", TagIDs: []uuid.UUID{},
		Postings: []ledger.Posting{{AccountID: id, Amount: *in.OpeningBalance, Memo: "opening balance"}}},
		"transaction.create", map[string]any{"openingBalanceFor": id.String()})
	return err
}

// Entity is the account CRUD definition (exported for the sync module's push handler).
var Entity = ledger.Entity[Account]{
	Table: "accounts", Path: "/accounts", Name: "account", Cols: cols, Order: "is_archived, sort_order, lower(name), id",
	GetMeta: func(a *Account) *ledger.Meta { return &a.Meta },
	Scan:    scan,
	Write:   write,
	New:     func() *Account { return &Account{IncludeInNetWorth: true, IncludeInSafeToSpend: true} },
	ListWhere: func(q url.Values) (string, []any) {
		if b, _ := strconv.ParseBool(q.Get("includeArchived")); b {
			return "", nil
		}
		return "NOT is_archived", nil
	},
	Decorate: func(ctx context.Context, db ledger.DB, profileID uuid.UUID, items []*Account) error {
		ids := make([]uuid.UUID, len(items))
		byID := map[uuid.UUID]*Account{}
		for i, a := range items {
			ids[i], byID[a.ID] = a.ID, a
			a.OpeningBalance = nil
		}
		bals, err := ledger.Balances(ctx, db, profileID, "", ids)
		if err != nil {
			return err
		}
		for _, b := range bals {
			byID[b.AccountID].Balances = append(byID[b.AccountID].Balances, b.Amount)
		}
		for _, a := range items {
			if len(a.Balances) == 0 {
				z, _ := money.Zero(a.Currency)
				a.Balances = []money.Money{z}
			}
		}
		return nil
	},
	// Accounts with ledger history are archived, not deleted, so balances stay reconstructible.
	BeforeDelete: func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, cur *Account) error {
		var used bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM postings p JOIN transactions t ON t.id = p.transaction_id
			WHERE p.account_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL)`, cur.ID).Scan(&used); err != nil {
			return err
		}
		if used {
			return httpx.Conflict("the account has transactions; archive it instead")
		}
		return nil
	},
}

type accountType struct {
	Code           string `json:"code"`
	Name           string `json:"name"`
	Classification string `json:"classification"`
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	Entity.Mount(r, deps.DB)
	sync.RegisterEntity(Entity.Table, Entity.Sync("currency", "creditLimit"))
	r.Get("/account-types", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := authz.Require(r.Context()); err != nil {
			return err
		}
		rows, err := deps.DB.Query(r.Context(), `SELECT code, name, classification FROM account_types ORDER BY sort_order, code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[accountType]{Items: []accountType{}}
		for rows.Next() {
			var t accountType
			if err := rows.Scan(&t.Code, &t.Name, &t.Classification); err != nil {
				return err
			}
			out.Items = append(out.Items, t)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))
}
