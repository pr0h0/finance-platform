package transactions

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// SplitInput is one requested category allocation (positive amount).
type SplitInput struct {
	ID          *uuid.UUID   `json:"id"`
	CategoryID  *uuid.UUID   `json:"categoryId"`
	Amount      *money.Money `json:"amount"`
	Description string       `json:"description"`
	Notes       string       `json:"notes"`
}

// Input is the simple-entry transaction request (OpenAPI TransactionInput). The server derives postings:
// expense/income/refund one posting on accountId (sign from kind); transfer/fx -amount on accountId and
// +toAmount on toAccountId; opening_balance one signed posting. Amounts other than opening balances are
// positive magnitudes.
type Input struct {
	ID                   *uuid.UUID   `json:"id"`
	Kind                 string       `json:"kind"`
	AccountID            uuid.UUID    `json:"accountId"`
	ToAccountID          *uuid.UUID   `json:"toAccountId"`
	Amount               *money.Money `json:"amount"`
	ToAmount             *money.Money `json:"toAmount"`       // amount received (fx); defaults to amount or a market conversion
	OriginalAmount       *money.Money `json:"originalAmount"` // foreign amount of a card spend abroad
	Fee                  *money.Money `json:"fee"`            // transfer/fx fee charged on the source account
	FeeCategoryID        *uuid.UUID   `json:"feeCategoryId"`
	BookingDate          string       `json:"bookingDate"`
	ValueDate            *string      `json:"valueDate"`
	OccurredAt           *time.Time   `json:"occurredAt"`
	Description          string       `json:"description"`
	Notes                string       `json:"notes"`
	MerchantID           *uuid.UUID   `json:"merchantId"`
	Payee                string       `json:"payee"`
	Reference            string       `json:"reference"`
	CategoryID           *uuid.UUID   `json:"categoryId"`
	Splits               []SplitInput `json:"splits"`
	TagIDs               []uuid.UUID  `json:"tagIds"`
	RelatedTransactionID *uuid.UUID   `json:"relatedTransactionId"`
	ExcludeFromReports   bool         `json:"excludeFromReports"`
	Status               string       `json:"status"`
}

func checkText(fields map[string]string, desc, notes, payee string) {
	if len(desc) > 500 {
		fields["description"] = "at most 500 characters"
	}
	if len(notes) > 5000 {
		fields["notes"] = "at most 5000 characters"
	}
	if len(payee) > 200 {
		fields["payee"] = "at most 200 characters"
	}
}

func accountCurrency(ctx context.Context, db ledger.DB, profileID, id uuid.UUID) (string, error) {
	var cur string
	err := db.QueryRow(ctx, `SELECT currency FROM accounts WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID).Scan(&cur)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", httpx.Validation(map[string]string{"accountId": "unknown account"})
	}
	return cur, err
}

// buildSplits turns split inputs (or the categoryId shorthand) into splits of total |amount|.
func buildSplits(in []SplitInput, categoryID *uuid.UUID, total money.Money) ([]ledger.Split, error) {
	if len(in) == 0 {
		return []ledger.Split{{CategoryID: categoryID, Amount: total.Abs()}}, nil
	}
	if categoryID != nil {
		return nil, httpx.Validation(map[string]string{"splits": "use either categoryId or splits"})
	}
	if len(in) > 500 {
		return nil, httpx.Validation(map[string]string{"splits": "at most 500 splits"})
	}
	out := make([]ledger.Split, len(in))
	for i, s := range in {
		if s.Amount == nil {
			return nil, httpx.Validation(map[string]string{fmt.Sprintf("splits[%d].amount", i): "required"})
		}
		if len(s.Description) > 500 || len(s.Notes) > 5000 {
			return nil, httpx.Validation(map[string]string{fmt.Sprintf("splits[%d]", i): "description/notes too long"})
		}
		out[i] = ledger.Split{CategoryID: s.CategoryID, Amount: *s.Amount, Description: s.Description, Notes: s.Notes}
		if s.ID != nil {
			out[i].ID = *s.ID // kept only if it is an existing split of the same transaction (ledger.writeSplits)
		}
	}
	return out, nil
}

// Create validates a simple-entry input, derives postings/splits and writes the transaction (plus a
// separate fee expense when a transfer fee is given). source is manual|mcp|sync|recurring|...
// It is the single create path for REST, MCP and sync push.
func Create(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in Input, source string) (*ledger.Transaction, error) {
	fields := map[string]string{}
	if in.Amount == nil {
		fields["amount"] = "required"
	}
	if ledger.ValidDate(in.BookingDate) != nil {
		fields["bookingDate"] = "required YYYY-MM-DD"
	}
	checkText(fields, in.Description, in.Notes, in.Payee)
	if len(in.TagIDs) > 50 {
		fields["tagIds"] = "at most 50 tags"
	}
	if len(fields) > 0 {
		return nil, httpx.Validation(fields)
	}
	if in.Status == "" {
		in.Status = "cleared"
	}
	if in.Status == "reconciled" {
		return nil, httpx.Validation(map[string]string{"status": "set by reconciliation"})
	}
	srcCur, err := accountCurrency(ctx, tx, profileID, in.AccountID)
	if err != nil {
		return nil, err
	}
	t := &ledger.Transaction{ProfileID: profileID, Kind: in.Kind, Status: in.Status, BookingDate: in.BookingDate, ValueDate: in.ValueDate,
		OccurredAt: in.OccurredAt, Description: in.Description, Notes: in.Notes, MerchantID: in.MerchantID, Payee: in.Payee,
		Reference: in.Reference, ExcludeFromReports: in.ExcludeFromReports, Source: source, TagIDs: in.TagIDs,
		RelatedTransactionID: in.RelatedTransactionID, CategorizationSource: "none"}
	if in.ID != nil {
		t.ID = *in.ID
	}
	if t.TagIDs == nil {
		t.TagIDs = []uuid.UUID{}
	}
	amt := *in.Amount
	if in.Kind != "opening_balance" && amt.Sign() <= 0 {
		return nil, httpx.Validation(map[string]string{"amount": "must be positive (the kind decides the direction)"})
	}
	if in.OriginalAmount != nil && (in.OriginalAmount.Currency() == amt.Currency() || in.OriginalAmount.Sign() <= 0) {
		return nil, httpx.Validation(map[string]string{"originalAmount": "must be a positive amount in another currency"})
	}
	if in.Fee != nil && in.Kind != "transfer" && in.Kind != "fx" {
		return nil, httpx.Validation(map[string]string{"fee": "only transfers carry a fee; record it as an expense"})
	}
	if (in.CategoryID != nil || len(in.Splits) > 0) && !ledger.SplitKinds(in.Kind) {
		return nil, httpx.Validation(map[string]string{"splits": in.Kind + " transactions are not categorized"})
	}
	if in.CategoryID != nil || len(in.Splits) > 0 {
		t.CategorizationSource = "user"
		if source == "mcp" {
			t.CategorizationSource = "mcp"
		}
	}

	switch in.Kind {
	case "expense", "income", "refund":
		if in.RelatedTransactionID != nil && in.Kind != "refund" {
			if ok, err := ledger.Owned(ctx, tx, "transactions", profileID, []uuid.UUID{*in.RelatedTransactionID}); err != nil || !ok {
				return nil, firstErr(err, httpx.Validation(map[string]string{"relatedTransactionId": "unknown transaction"}))
			}
		}
		signed := amt
		if in.Kind == "expense" {
			signed = amt.Neg()
		}
		t.Postings = []ledger.Posting{{AccountID: in.AccountID, Amount: signed, OriginalAmount: in.OriginalAmount}}
		if in.Kind == "refund" {
			if in.RelatedTransactionID == nil {
				return nil, httpx.Validation(map[string]string{"relatedTransactionId": "a refund must link the original transaction"})
			}
			if t.Splits, err = refundSplits(ctx, tx, profileID, *in.RelatedTransactionID, amt, in); err != nil {
				return nil, err
			}
			break
		}
		if t.Splits, err = buildSplits(in.Splits, in.CategoryID, amt); err != nil {
			return nil, err
		}
	case "transfer", "fx":
		if err := buildTransfer(ctx, tx, profileID, t, in, srcCur); err != nil {
			return nil, err
		}
	case "opening_balance":
		if amt.IsZero() {
			return nil, httpx.Validation(map[string]string{"amount": "must not be zero"})
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM transactions t JOIN postings p ON p.transaction_id = t.id
			WHERE t.profile_id = $1 AND t.kind = 'opening_balance' AND t.deleted_at IS NULL AND p.deleted_at IS NULL
			AND p.account_id = $2 AND p.currency = $3)`, profileID, in.AccountID, amt.Currency()).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			return nil, httpx.Conflict("the account already has an opening balance in " + amt.Currency() + "; edit it instead")
		}
		t.Postings = []ledger.Posting{{AccountID: in.AccountID, Amount: amt, Memo: "opening balance"}}
	case "adjustment":
		return nil, httpx.Validation(map[string]string{"kind": "use POST /transactions/{id}/adjustments or /reconciliations"})
	default:
		return nil, httpx.Validation(map[string]string{"kind": "must be expense, income, transfer, fx, refund or opening_balance"})
	}

	created, err := ledger.Create(ctx, tx, t, "transaction.create", nil)
	if err != nil {
		return nil, err
	}
	if in.Fee != nil {
		if err := createFee(ctx, tx, created, in); err != nil {
			return nil, err
		}
	}
	return created, nil
}

func firstErr(err, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

// buildTransfer derives the two legs. Different currencies make it an `fx` transaction with a
// currency_conversions row: the actual received amount (toAmount, bank_actual) or a market conversion
// from the rate snapshot on the booking date.
func buildTransfer(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, t *ledger.Transaction, in Input, srcCur string) error {
	if in.ToAccountID == nil || *in.ToAccountID == in.AccountID {
		return httpx.Validation(map[string]string{"toAccountId": "required and different from accountId"})
	}
	dstCur, err := accountCurrency(ctx, tx, profileID, *in.ToAccountID)
	if err != nil {
		return httpx.Validation(map[string]string{"toAccountId": "unknown account"})
	}
	amt := *in.Amount
	if in.Fee != nil && in.Fee.Sign() <= 0 {
		return httpx.Validation(map[string]string{"fee": "must be positive"})
	}
	to := in.ToAmount
	if to == nil && dstCur == amt.Currency() {
		to = &amt
	}
	var conv *ledger.Conversion
	var rateID *uuid.UUID
	if to == nil {
		r, err := exchangerates.Lookup(ctx, tx, profileID, amt.Currency(), dstCur, in.BookingDate)
		if errors.Is(err, exchangerates.ErrNoRate) {
			return httpx.NewError(http.StatusUnprocessableEntity, "rate_unavailable", err.Error()+"; send toAmount (the amount actually received)")
		}
		if err != nil {
			return err
		}
		m, err := r.Convert(amt, money.DefaultRounding)
		if err != nil {
			return err
		}
		to, rateID = &m, r.ID
		method := map[string]string{"provider": "market", "manual": "manual", "fixed": "fixed"}[r.Source]
		conv = &ledger.Conversion{From: amt, To: m, Rate: r.Value(), RateDate: r.RateDate, Method: method, ExchangeRateID: r.ID}
	}
	if to.Sign() <= 0 {
		return httpx.Validation(map[string]string{"toAmount": "must be positive"})
	}
	if to.Currency() == amt.Currency() {
		if in.Kind == "fx" {
			return httpx.Validation(map[string]string{"kind": "fx needs two different currencies; use transfer"})
		}
		if c, _ := to.Cmp(amt); c != 0 {
			return httpx.Validation(map[string]string{"toAmount": "a same-currency transfer moves the same amount; record the fee separately"})
		}
		t.Kind = "transfer"
	} else {
		t.Kind = "fx"
		if conv == nil {
			conv = &ledger.Conversion{From: amt, To: *to, Rate: impliedRate(amt, *to), RateDate: in.BookingDate, Method: "bank_actual"}
		}
		if in.Fee != nil {
			f := *in.Fee
			conv.Fee = &f
		}
	}
	t.Conversion = conv
	t.Postings = []ledger.Posting{
		{AccountID: in.AccountID, Amount: amt.Neg()},
		{AccountID: *in.ToAccountID, Amount: *to, ExchangeRateID: rateID},
	}
	return nil
}

// impliedRate = to / from with 18 fraction digits (the bank's effective settlement rate).
func impliedRate(from, to money.Money) string {
	f, _ := new(big.Rat).SetString(from.Amount())
	t, _ := new(big.Rat).SetString(to.Amount())
	return ledger.TrimDecimal(new(big.Rat).Quo(t, f).FloatString(18))
}

// createFee records a transfer/conversion fee as its own expense on the source account, linked to the
// transfer, so fees show up in spending (feature 22) while the transfer itself never does.
func createFee(ctx context.Context, tx pgx.Tx, transfer *ledger.Transaction, in Input) error {
	fee := *in.Fee
	_, err := ledger.Create(ctx, tx, &ledger.Transaction{ProfileID: transfer.ProfileID, Kind: "expense", Status: transfer.Status,
		BookingDate: transfer.BookingDate, Description: "Fee: " + firstNonEmpty(transfer.Description, "transfer"), Source: transfer.Source,
		RelatedTransactionID: &transfer.ID, TagIDs: []uuid.UUID{}, CategorizationSource: "none",
		Postings: []ledger.Posting{{AccountID: in.AccountID, Amount: fee.Neg(), Memo: "fee"}},
		Splits:   []ledger.Split{{CategoryID: in.FeeCategoryID, Amount: fee}}}, "transaction.create", map[string]any{"feeFor": transfer.ID.String()})
	return err
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// refundSplits validates the link to the original expense (same currency, refunds never exceed it) and
// returns the refund's splits: explicit ones, the categoryId shorthand, or the original's categories
// allocated proportionally (largest remainder, exact).
func refundSplits(ctx context.Context, tx pgx.Tx, profileID, originalID uuid.UUID, amt money.Money, in Input) ([]ledger.Split, error) {
	orig, err := ledger.Get(ctx, tx, profileID, originalID, true)
	if err != nil {
		return nil, httpx.Validation(map[string]string{"relatedTransactionId": "unknown transaction"})
	}
	if orig.DeletedAt != nil || orig.Kind != "expense" {
		return nil, httpx.Validation(map[string]string{"relatedTransactionId": "refunds link to an existing expense"})
	}
	origAmt := orig.Amount().Abs()
	if origAmt.Currency() != amt.Currency() {
		return nil, httpx.Validation(map[string]string{"amount": "refund currency must match the original (" + origAmt.Currency() + ")"})
	}
	refunded, err := refundedTotal(ctx, tx, profileID, originalID, in.ID, origAmt.Currency())
	if err != nil {
		return nil, err
	}
	total, _ := refunded.Add(amt)
	if c, _ := total.Cmp(origAmt); c > 0 {
		left, _ := origAmt.Sub(refunded)
		e := httpx.Unprocessable("refunds would exceed the original amount")
		e.Details = map[string]any{"refundable": left}
		return nil, e
	}
	if len(in.Splits) > 0 || in.CategoryID != nil {
		return buildSplits(in.Splits, in.CategoryID, amt)
	}
	weights := make([]string, len(orig.Splits))
	for i, s := range orig.Splits {
		weights[i] = s.Amount.Amount()
	}
	parts, err := amt.Allocate(weights)
	if err != nil {
		return nil, err
	}
	var out []ledger.Split
	for i, p := range parts {
		if p.Sign() > 0 {
			out = append(out, ledger.Split{CategoryID: orig.Splits[i].CategoryID, Amount: p, Description: orig.Splits[i].Description})
		}
	}
	return out, nil
}

func refundedTotal(ctx context.Context, db ledger.DB, profileID, originalID uuid.UUID, exclude *uuid.UUID, cur string) (money.Money, error) {
	var sum pgtype.Numeric
	ex := uuid.Nil
	if exclude != nil {
		ex = *exclude
	}
	err := db.QueryRow(ctx, `SELECT COALESCE(SUM(p.amount), 0) FROM transactions t JOIN postings p ON p.transaction_id = t.id
		WHERE t.profile_id = $1 AND t.related_transaction_id = $2 AND t.kind = 'refund' AND t.deleted_at IS NULL
		  AND t.status <> 'void' AND p.deleted_at IS NULL AND t.id <> $3`, profileID, originalID, ex).Scan(&sum)
	if err != nil {
		return money.Money{}, err
	}
	return money.FromNumeric(sum, cur)
}

// Patch is the editable part of a transaction (OpenAPI TransactionPatch). Handlers pre-fill it from the
// current state, so absent JSON fields keep their value.
type Patch struct {
	Version            int          `json:"version"`
	Description        string       `json:"description"`
	Notes              string       `json:"notes"`
	MerchantID         *uuid.UUID   `json:"merchantId"`
	Payee              string       `json:"payee"`
	Reference          string       `json:"reference"`
	BookingDate        string       `json:"bookingDate"`
	ValueDate          *string      `json:"valueDate"`
	OccurredAt         *time.Time   `json:"occurredAt"`
	Amount             *money.Money `json:"amount"`
	ToAmount           *money.Money `json:"toAmount"`
	Status             string       `json:"status"`
	ExcludeFromReports bool         `json:"excludeFromReports"`
	TagIDs             []uuid.UUID  `json:"tagIds"`
	CategoryID         *uuid.UUID   `json:"categoryId"`
}

// PatchFrom pre-fills a Patch with the current state. Amount is a positive magnitude except for
// opening_balance/adjustment, which are signed.
func PatchFrom(t *ledger.Transaction) Patch {
	p := Patch{Description: t.Description, Notes: t.Notes, MerchantID: t.MerchantID, Payee: t.Payee, Reference: t.Reference,
		BookingDate: t.BookingDate, ValueDate: t.ValueDate, OccurredAt: t.OccurredAt, Status: t.Status,
		ExcludeFromReports: t.ExcludeFromReports, TagIDs: t.TagIDs}
	if len(t.Postings) > 0 {
		a := t.Postings[0].Amount
		if t.Kind != "opening_balance" && t.Kind != "adjustment" {
			a = a.Abs()
		}
		p.Amount = &a
	}
	if len(t.Postings) == 2 {
		b := t.Postings[1].Amount
		p.ToAmount = &b
	}
	if len(t.Splits) == 1 {
		p.CategoryID = t.Splits[0].CategoryID
	}
	return p
}

// ApplyPatch computes the new state of cur. keys = JSON keys present in the request.
func ApplyPatch(ctx context.Context, tx pgx.Tx, cur *ledger.Transaction, p Patch, keys map[string]bool) (*ledger.Transaction, error) {
	fields := map[string]string{}
	checkText(fields, p.Description, p.Notes, p.Payee)
	if len(fields) > 0 {
		return nil, httpx.Validation(fields)
	}
	after := cur.Clone()
	after.Description, after.Notes, after.MerchantID, after.Payee, after.Reference = p.Description, p.Notes, p.MerchantID, p.Payee, p.Reference
	after.BookingDate, after.ValueDate, after.OccurredAt, after.Status = p.BookingDate, p.ValueDate, p.OccurredAt, p.Status
	after.ExcludeFromReports, after.TagIDs = p.ExcludeFromReports, p.TagIDs
	if after.TagIDs == nil {
		after.TagIDs = []uuid.UUID{}
	}
	if keys["amount"] || keys["toAmount"] {
		if p.Amount == nil {
			return nil, httpx.Validation(map[string]string{"amount": "required"})
		}
		if err := applyAmount(after, *p.Amount, p.ToAmount, keys); err != nil {
			return nil, err
		}
	}
	if keys["categoryId"] {
		if !ledger.SplitKinds(after.Kind) {
			return nil, httpx.Validation(map[string]string{"categoryId": after.Kind + " transactions are not categorized"})
		}
		s := ledger.Split{CategoryID: p.CategoryID, Amount: after.Amount().Abs()}
		if len(cur.Splits) > 0 {
			s.ID, s.Description, s.Notes = cur.Splits[0].ID, cur.Splits[0].Description, cur.Splits[0].Notes
		}
		after.Splits = []ledger.Split{s}
		after.CategorizationSource = "user"
	}
	if after.Kind == "refund" && after.RelatedTransactionID != nil && keys["amount"] {
		orig, err := ledger.Get(ctx, tx, cur.ProfileID, *after.RelatedTransactionID, false)
		if err != nil {
			return nil, err
		}
		refunded, err := refundedTotal(ctx, tx, cur.ProfileID, orig.ID, &cur.ID, after.Amount().Currency())
		if err != nil {
			return nil, err
		}
		total, err := refunded.Add(after.Amount())
		if err != nil {
			return nil, httpx.Validation(map[string]string{"amount": "refund currency must match the original"})
		}
		if c, _ := total.Cmp(orig.Amount().Abs()); c > 0 {
			return nil, httpx.Unprocessable("refunds would exceed the original amount")
		}
	}
	return after, nil
}

// applyAmount rewrites the postings of a manual transaction for a new amount; single-split transactions
// follow the amount, multi-split ones must be re-split explicitly (the split sum must stay exact).
func applyAmount(t *ledger.Transaction, amt money.Money, toAmt *money.Money, keys map[string]bool) error {
	switch t.Kind {
	case "expense", "income", "refund":
		if amt.Sign() <= 0 {
			return httpx.Validation(map[string]string{"amount": "must be positive"})
		}
		signed := amt
		if t.Kind == "expense" {
			signed = amt.Neg()
		}
		t.Postings[0].Amount = signed
		if len(t.Splits) == 1 && !keys["categoryId"] {
			t.Splits[0].Amount = amt
		} else if len(t.Splits) > 1 && !keys["categoryId"] {
			return httpx.NewError(http.StatusUnprocessableEntity, "splits_mismatch",
				"this transaction has several splits; replace them with PUT /transactions/{id}/splits (or send categoryId to collapse)")
		}
	case "opening_balance", "adjustment":
		if len(t.Postings) != 1 || amt.IsZero() {
			return httpx.Validation(map[string]string{"amount": "must not be zero"})
		}
		t.Postings[0].Amount = amt
	case "transfer", "fx":
		if amt.Sign() <= 0 {
			return httpx.Validation(map[string]string{"amount": "must be positive"})
		}
		to := amt
		if t.Kind == "fx" || (toAmt != nil && keys["toAmount"]) {
			if toAmt == nil || toAmt.Sign() <= 0 {
				return httpx.Validation(map[string]string{"toAmount": "required and positive"})
			}
			to = *toAmt
		}
		t.Postings[0].Amount, t.Postings[1].Amount = amt.Neg(), to
		if t.Kind == "fx" {
			t.Postings[1].ExchangeRateID = nil
			var fee *money.Money
			if t.Conversion != nil {
				fee = t.Conversion.Fee
			}
			t.Conversion = &ledger.Conversion{From: amt, To: to, Rate: impliedRate(amt, to), RateDate: t.BookingDate, Method: "bank_actual", Fee: fee}
		}
	}
	return nil
}

// Adjust records a correcting `adjustment` transaction for cur (typically imported evidence that must
// not be rewritten): a signed posting on one of cur's accounts, linked via corrects_transaction_id and a
// transaction_adjustments row.
func Adjust(ctx context.Context, tx pgx.Tx, cur *ledger.Transaction, accountID *uuid.UUID, amt money.Money, date, reason string) (*ledger.Transaction, error) {
	if reason == "" || len(reason) > 1000 {
		return nil, httpx.Validation(map[string]string{"reason": "required, at most 1000 characters"})
	}
	if cur.DeletedAt != nil {
		return nil, httpx.NotFound("transaction")
	}
	acct := cur.Postings[0].AccountID
	if accountID != nil {
		found := false
		for _, p := range cur.Postings {
			found = found || p.AccountID == *accountID
		}
		if !found {
			return nil, httpx.Validation(map[string]string{"accountId": "must be one of the corrected transaction's accounts"})
		}
		acct = *accountID
	}
	if ledger.ValidDate(date) != nil {
		return nil, httpx.Validation(map[string]string{"bookingDate": "required YYYY-MM-DD"})
	}
	adj, err := ledger.Create(ctx, tx, &ledger.Transaction{ProfileID: cur.ProfileID, Kind: "adjustment", BookingDate: date,
		Description: "Correction: " + reason, CorrectsTransactionID: &cur.ID, TagIDs: []uuid.UUID{},
		Postings: []ledger.Posting{{AccountID: acct, Amount: amt, Memo: "correction"}}},
		"transaction.adjust", map[string]any{"corrects": cur.ID.String(), "reason": reason})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO transaction_adjustments (profile_id, transaction_id, adjustment_transaction_id, reason, created_by)
		VALUES ($1,$2,$3,$4,(SELECT created_by FROM transactions WHERE id = $3))`, cur.ProfileID, cur.ID, adj.ID, reason); err != nil {
		return nil, fmt.Errorf("link adjustment: %w", err)
	}
	return adj, nil
}

// InputFrom rebuilds a create input from an existing transaction (duplicate).
func InputFrom(t *ledger.Transaction, bookingDate string) (Input, error) {
	if t.Kind == "adjustment" || t.Kind == "opening_balance" {
		return Input{}, httpx.Validation(map[string]string{"kind": t.Kind + " transactions cannot be duplicated"})
	}
	amt := t.Amount().Abs()
	in := Input{Kind: t.Kind, AccountID: t.Postings[0].AccountID, Amount: &amt, BookingDate: bookingDate,
		Description: t.Description, Notes: t.Notes, MerchantID: t.MerchantID, Payee: t.Payee, TagIDs: t.TagIDs,
		RelatedTransactionID: t.RelatedTransactionID, ExcludeFromReports: t.ExcludeFromReports, OriginalAmount: t.Postings[0].OriginalAmount}
	if len(t.Postings) == 2 {
		to := t.Postings[1].Amount
		in.ToAccountID, in.ToAmount = &t.Postings[1].AccountID, &to
	}
	for _, s := range t.Splits {
		a := s.Amount
		in.Splits = append(in.Splits, SplitInput{CategoryID: s.CategoryID, Amount: &a, Description: s.Description, Notes: s.Notes})
	}
	return in, nil
}
