package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// DB is satisfied by *pgxpool.Pool and pgx.Tx.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Posting is the API shape of one immutable money movement.
type Posting struct {
	ID             uuid.UUID    `json:"id"`
	AccountID      uuid.UUID    `json:"accountId"`
	Amount         money.Money  `json:"amount"`
	OriginalAmount *money.Money `json:"originalAmount"`
	ExchangeRateID *uuid.UUID   `json:"exchangeRateId"`
	LineNo         int          `json:"lineNo"`
	Memo           string       `json:"memo"`
}

// Split is a positive category allocation of the transaction's single posting.
type Split struct {
	ID          uuid.UUID   `json:"id"`
	CategoryID  *uuid.UUID  `json:"categoryId"`
	Amount      money.Money `json:"amount"`
	Description string      `json:"description"`
	Notes       string      `json:"notes"`
	SortOrder   int         `json:"sortOrder"`
}

// Conversion is the currency_conversions row of an fx transaction.
type Conversion struct {
	From           money.Money  `json:"from"`
	To             money.Money  `json:"to"`
	Rate           string       `json:"rate"` // to per 1 from
	RateDate       string       `json:"rateDate"`
	Method         string       `json:"method"` // market | manual | fixed | bank_actual
	ExchangeRateID *uuid.UUID   `json:"exchangeRateId"`
	Fee            *money.Money `json:"fee"`
}

// Transaction is the API (and sync snapshot) shape of a transaction with its children.
type Transaction struct {
	ID                    uuid.UUID   `json:"id"`
	ProfileID             uuid.UUID   `json:"profileId"`
	Version               int         `json:"version"`
	ServerVersion         int64       `json:"serverVersion"`
	CreatedAt             time.Time   `json:"createdAt"`
	UpdatedAt             time.Time   `json:"updatedAt"`
	DeletedAt             *time.Time  `json:"deletedAt"`
	Kind                  string      `json:"kind"`
	Status                string      `json:"status"`
	BookingDate           string      `json:"bookingDate"`
	ValueDate             *string     `json:"valueDate"`
	OccurredAt            *time.Time  `json:"occurredAt"`
	Description           string      `json:"description"`
	Notes                 string      `json:"notes"`
	MerchantID            *uuid.UUID  `json:"merchantId"`
	Payee                 string      `json:"payee"`
	Reference             string      `json:"reference"`
	ExcludeFromReports    bool        `json:"excludeFromReports"`
	Source                string      `json:"source"`
	ImportRecordID        *uuid.UUID  `json:"importRecordId"`
	RelatedTransactionID  *uuid.UUID  `json:"relatedTransactionId"`
	CorrectsTransactionID *uuid.UUID  `json:"correctsTransactionId"`
	CategorizationSource  string      `json:"categorizationSource"`
	Postings              []Posting   `json:"postings"`
	Splits                []Split     `json:"splits"`
	TagIDs                []uuid.UUID `json:"tagIds"`
	AttachmentIDs         []uuid.UUID `json:"attachmentIds"`
	Conversion            *Conversion `json:"conversion"`
}

const txCols = `t.id, t.profile_id, t.kind, t.status, t.booking_date::text, t.value_date::text, t.occurred_at,
	t.description, t.notes, t.merchant_id, t.payee, t.reference, t.exclude_from_reports, t.source, t.import_record_id,
	t.related_transaction_id, t.corrects_transaction_id, t.categorization_source, t.version, t.server_version,
	t.created_at, t.updated_at, t.deleted_at`

func scanTx(row pgx.Row) (*Transaction, error) {
	t := &Transaction{Postings: []Posting{}, Splits: []Split{}, TagIDs: []uuid.UUID{}, AttachmentIDs: []uuid.UUID{}}
	err := row.Scan(&t.ID, &t.ProfileID, &t.Kind, &t.Status, &t.BookingDate, &t.ValueDate, &t.OccurredAt,
		&t.Description, &t.Notes, &t.MerchantID, &t.Payee, &t.Reference, &t.ExcludeFromReports, &t.Source, &t.ImportRecordID,
		&t.RelatedTransactionID, &t.CorrectsTransactionID, &t.CategorizationSource, &t.Version, &t.ServerVersion,
		&t.CreatedAt, &t.UpdatedAt, &t.DeletedAt)
	return t, err
}

// Get loads one transaction (including tombstoned ones) of the profile, or httpx 404.
// forUpdate row-locks the header.
func Get(ctx context.Context, db DB, profileID, id uuid.UUID, forUpdate bool) (*Transaction, error) {
	q := `SELECT ` + txCols + ` FROM transactions t WHERE t.id = $1 AND t.profile_id = $2`
	if forUpdate {
		q += ` FOR UPDATE`
	}
	t, err := scanTx(db.QueryRow(ctx, q, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("transaction")
	}
	if err != nil {
		return nil, fmt.Errorf("load transaction: %w", err)
	}
	if err := LoadChildren(ctx, db, []*Transaction{t}); err != nil {
		return nil, err
	}
	return t, nil
}

// Query runs a header query whose select list is txCols (alias t) and loads children.
func Query(ctx context.Context, db DB, sql string, args ...any) ([]*Transaction, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("query transactions: %w", err)
	}
	defer rows.Close()
	var out []*Transaction
	for rows.Next() {
		t, err := scanTx(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, LoadChildren(ctx, db, out)
}

// TxCols is the select list Query expects (table alias t).
const TxCols = txCols

func numMoney(n pgtype.Numeric, cur string) (money.Money, error) { return money.FromNumeric(n, cur) }

// LoadChildren fills postings, splits, tags, attachments and fx conversion for txs in a few batch queries.
func LoadChildren(ctx context.Context, db DB, txs []*Transaction) error {
	if len(txs) == 0 {
		return nil
	}
	byID := make(map[uuid.UUID]*Transaction, len(txs))
	ids := make([]uuid.UUID, len(txs))
	for i, t := range txs {
		byID[t.ID], ids[i] = t, t.ID
	}
	rows, err := db.Query(ctx, `SELECT transaction_id, id, account_id, amount, currency, original_amount, original_currency,
		exchange_rate_id, line_no, memo FROM postings WHERE transaction_id = ANY($1) AND deleted_at IS NULL ORDER BY transaction_id, line_no, id`, ids)
	if err != nil {
		return fmt.Errorf("load postings: %w", err)
	}
	for rows.Next() {
		var tid uuid.UUID
		var p Posting
		var amt, orig pgtype.Numeric
		var cur string
		var ocur *string
		if err := rows.Scan(&tid, &p.ID, &p.AccountID, &amt, &cur, &orig, &ocur, &p.ExchangeRateID, &p.LineNo, &p.Memo); err != nil {
			rows.Close()
			return err
		}
		if p.Amount, err = numMoney(amt, cur); err != nil {
			rows.Close()
			return err
		}
		if orig.Valid && ocur != nil {
			o, err := numMoney(orig, *ocur)
			if err != nil {
				rows.Close()
				return err
			}
			p.OriginalAmount = &o
		}
		byID[tid].Postings = append(byID[tid].Postings, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	rows, err = db.Query(ctx, `SELECT transaction_id, id, category_id, amount, currency, description, notes, sort_order
		FROM transaction_splits WHERE transaction_id = ANY($1) AND deleted_at IS NULL ORDER BY transaction_id, sort_order, id`, ids)
	if err != nil {
		return fmt.Errorf("load splits: %w", err)
	}
	for rows.Next() {
		var tid uuid.UUID
		var s Split
		var amt pgtype.Numeric
		var cur string
		if err := rows.Scan(&tid, &s.ID, &s.CategoryID, &amt, &cur, &s.Description, &s.Notes, &s.SortOrder); err != nil {
			rows.Close()
			return err
		}
		if s.Amount, err = numMoney(amt, cur); err != nil {
			rows.Close()
			return err
		}
		byID[tid].Splits = append(byID[tid].Splits, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	link := func(sql string, add func(t *Transaction, id uuid.UUID)) error {
		rows, err := db.Query(ctx, sql, ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var tid, id uuid.UUID
			if err := rows.Scan(&tid, &id); err != nil {
				return err
			}
			add(byID[tid], id)
		}
		return rows.Err()
	}
	if err := link(`SELECT transaction_id, tag_id FROM transaction_tags WHERE transaction_id = ANY($1) ORDER BY transaction_id, tag_id`,
		func(t *Transaction, id uuid.UUID) { t.TagIDs = append(t.TagIDs, id) }); err != nil {
		return fmt.Errorf("load tags: %w", err)
	}
	if err := link(`SELECT transaction_id, id FROM attachments WHERE transaction_id = ANY($1) AND deleted_at IS NULL ORDER BY transaction_id, created_at, id`,
		func(t *Transaction, id uuid.UUID) { t.AttachmentIDs = append(t.AttachmentIDs, id) }); err != nil {
		return fmt.Errorf("load attachment links: %w", err)
	}

	rows, err = db.Query(ctx, `SELECT DISTINCT ON (transaction_id) transaction_id, from_amount, from_currency, to_amount, to_currency,
		rate::text, rate_date::text, method, exchange_rate_id, fee_amount, fee_currency
		FROM currency_conversions WHERE transaction_id = ANY($1) ORDER BY transaction_id, created_at DESC`, ids)
	if err != nil {
		return fmt.Errorf("load conversions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var tid uuid.UUID
		var c Conversion
		var fa, ta, fee pgtype.Numeric
		var fc, tc string
		var feeCur *string
		if err := rows.Scan(&tid, &fa, &fc, &ta, &tc, &c.Rate, &c.RateDate, &c.Method, &c.ExchangeRateID, &fee, &feeCur); err != nil {
			return err
		}
		if c.From, err = numMoney(fa, fc); err != nil {
			return err
		}
		if c.To, err = numMoney(ta, tc); err != nil {
			return err
		}
		if fee.Valid && feeCur != nil {
			f, err := numMoney(fee, *feeCur)
			if err != nil {
				return err
			}
			c.Fee = &f
		}
		c.Rate = TrimDecimal(c.Rate)
		byID[tid].Conversion = &c
	}
	return rows.Err()
}

// TrimDecimal drops trailing fraction zeros of a NUMERIC text ("1.955830000" -> "1.95583").
func TrimDecimal(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	for s[len(s)-1] == '0' {
		s = s[:len(s)-1]
	}
	if s[len(s)-1] == '.' {
		s = s[:len(s)-1]
	}
	return s
}

// Amount is the transaction's primary signed amount: the first posting (for transfers: the source leg).
func (t *Transaction) Amount() money.Money { return t.Postings[0].Amount }

// IsImported reports whether amounts/dates/accounts are protected imported evidence.
func (t *Transaction) IsImported() bool { return t.ImportRecordID != nil }

// SplitKinds are the kinds whose single posting is allocated to categories by splits.
func SplitKinds(kind string) bool { return kind == "expense" || kind == "income" || kind == "refund" }

// validate enforces the ledger invariants every write path must keep (ADR 0003,
// docs/architecture/financial-invariants.md 8, 11). Account/category references are checked against the profile.
func validate(ctx context.Context, db DB, t *Transaction) error {
	if len(t.Postings) == 0 {
		return httpx.Unprocessable("a transaction needs at least one posting")
	}
	for i, p := range t.Postings {
		var cur string
		var multi bool
		err := db.QueryRow(ctx, `SELECT currency, is_multi_currency FROM accounts WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`,
			p.AccountID, t.ProfileID).Scan(&cur, &multi)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpx.Validation(map[string]string{fmt.Sprintf("postings[%d].accountId", i): "unknown account"})
		}
		if err != nil {
			return err
		}
		if p.Amount.Currency() != cur && !multi {
			return httpx.Validation(map[string]string{"amount": fmt.Sprintf("account currency is %s; enable multi-currency on the account to post %s", cur, p.Amount.Currency())})
		}
		if p.Amount.IsZero() {
			return httpx.Validation(map[string]string{"amount": "must not be zero"})
		}
	}
	ps := t.Postings
	switch t.Kind {
	case "expense":
		if len(ps) != 1 || ps[0].Amount.Sign() >= 0 {
			return httpx.Unprocessable("expense must have exactly one negative posting")
		}
	case "income", "refund":
		if len(ps) != 1 || ps[0].Amount.Sign() <= 0 {
			return httpx.Unprocessable(t.Kind + " must have exactly one positive posting")
		}
	case "transfer":
		if len(ps) != 2 || ps[0].Amount.Currency() != ps[1].Amount.Currency() {
			return httpx.Unprocessable("transfer must have two postings in the same currency")
		}
		if s, _ := ps[0].Amount.Add(ps[1].Amount); !s.IsZero() || ps[0].AccountID == ps[1].AccountID {
			return httpx.Unprocessable("transfer postings must sum to zero across two different accounts")
		}
	case "fx":
		if len(ps) != 2 || ps[0].Amount.Currency() == ps[1].Amount.Currency() || ps[0].Amount.Sign() >= 0 || ps[1].Amount.Sign() <= 0 {
			return httpx.Unprocessable("fx must have one negative and one positive posting in different currencies")
		}
	case "opening_balance", "adjustment":
	default:
		return httpx.Validation(map[string]string{"kind": "unknown kind"})
	}
	if SplitKinds(t.Kind) {
		if len(t.Splits) == 0 {
			return httpx.Unprocessable("splits are required")
		}
	}
	if len(t.Splits) > 0 {
		if len(ps) != 1 {
			return httpx.Unprocessable("only single-posting transactions can have splits")
		}
		amts := make([]money.Money, len(t.Splits))
		for i, s := range t.Splits {
			amts[i] = s.Amount
		}
		if !money.SplitsBalance(ps[0].Amount, amts) {
			return httpx.Validation(map[string]string{"splits": "split amounts must be positive, in " + ps[0].Amount.Currency() + ", and sum exactly to " + ps[0].Amount.Abs().Amount()})
		}
		var cats []uuid.UUID
		for _, s := range t.Splits {
			if s.CategoryID != nil {
				cats = append(cats, *s.CategoryID)
			}
		}
		if ok, err := Owned(ctx, db, "categories", t.ProfileID, cats); err != nil || !ok {
			return firstErr(err, httpx.Validation(map[string]string{"splits": "unknown category"}))
		}
	}
	if t.MerchantID != nil {
		if ok, err := Owned(ctx, db, "merchants", t.ProfileID, []uuid.UUID{*t.MerchantID}); err != nil || !ok {
			return firstErr(err, httpx.Validation(map[string]string{"merchantId": "unknown merchant"}))
		}
	}
	if ok, err := Owned(ctx, db, "tags", t.ProfileID, t.TagIDs); err != nil || !ok {
		return firstErr(err, httpx.Validation(map[string]string{"tagIds": "unknown tag"}))
	}
	if err := ValidDate(t.BookingDate); err != nil {
		return httpx.Validation(map[string]string{"bookingDate": err.Error()})
	}
	if t.ValueDate != nil {
		if err := ValidDate(*t.ValueDate); err != nil {
			return httpx.Validation(map[string]string{"valueDate": err.Error()})
		}
	}
	switch t.Status {
	case "pending", "cleared", "reconciled", "void":
	default:
		return httpx.Validation(map[string]string{"status": "must be pending, cleared, reconciled or void"})
	}
	return nil
}

func firstErr(err error, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

// Owned reports whether every id is a non-deleted row of table in the profile. Empty ids = true.
func Owned(ctx context.Context, db DB, table string, profileID uuid.UUID, ids []uuid.UUID) (bool, error) {
	ids = uniq(ids)
	if len(ids) == 0 {
		return true, nil
	}
	var n int
	err := db.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE id = ANY($1) AND profile_id = $2 AND deleted_at IS NULL`,
		pgx.Identifier{table}.Sanitize()), ids, profileID).Scan(&n)
	return n == len(ids), err
}

func uniq(ids []uuid.UUID) []uuid.UUID {
	out := slices.Clone(ids)
	slices.SortFunc(out, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	return slices.Compact(out)
}

// AutoCategorize runs the profile's enabled categorization rules on transactions just created by a
// server write path (REST/MCP create, server-side import commit) and returns the ids it changed.
// The automation module sets it (it imports transactions, so the call cannot be direct); nil = no
// rules. Sync pushes do not call it: the device already ran its rules before pushing.
var AutoCategorize func(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, ids []uuid.UUID) ([]uuid.UUID, error)

// Create inserts t (header, postings, splits, tags) after validating the ledger invariants and records
// the sync change + audit entry. Zero ids are generated. Returns the stored snapshot.
func Create(ctx context.Context, tx pgx.Tx, t *Transaction, action string, meta map[string]any) (*Transaction, error) {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	if t.Status == "" {
		t.Status = "cleared"
	}
	if t.Source == "" {
		t.Source = "manual"
	}
	if t.CategorizationSource == "" {
		t.CategorizationSource = "none"
	}
	if err := validate(ctx, tx, t); err != nil {
		return nil, err
	}
	var createdBy *uuid.UUID
	if p, ok := authz.FromContext(ctx); ok && p.UserID != uuid.Nil {
		createdBy = &p.UserID
	}
	_, err := tx.Exec(ctx, `INSERT INTO transactions (id, profile_id, kind, status, booking_date, value_date, occurred_at, description,
		notes, merchant_id, payee, reference, exclude_from_reports, source, import_record_id, related_transaction_id,
		corrects_transaction_id, categorization_source, created_by)
		VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
		t.ID, t.ProfileID, t.Kind, t.Status, t.BookingDate, t.ValueDate, t.OccurredAt, t.Description, t.Notes, t.MerchantID,
		t.Payee, t.Reference, t.ExcludeFromReports, t.Source, t.ImportRecordID, t.RelatedTransactionID, t.CorrectsTransactionID,
		t.CategorizationSource, createdBy)
	if IsUnique(err) {
		return nil, httpx.Conflict("transaction id already exists")
	}
	if err != nil {
		return nil, fmt.Errorf("insert transaction: %w", err)
	}
	if err := insertPostings(ctx, tx, t); err != nil {
		return nil, err
	}
	if err := writeSplits(ctx, tx, t, nil); err != nil {
		return nil, err
	}
	if err := writeTags(ctx, tx, t); err != nil {
		return nil, err
	}
	if err := writeConversion(ctx, tx, t); err != nil {
		return nil, err
	}
	return record(ctx, tx, t.ProfileID, t.ID, nil, action, meta)
}

func insertPostings(ctx context.Context, tx pgx.Tx, t *Transaction) error {
	for i := range t.Postings {
		p := &t.Postings[i]
		p.ID = uuid.New()
		p.LineNo = i
		var orig pgtype.Numeric
		var ocur *string
		if p.OriginalAmount != nil {
			orig = p.OriginalAmount.Numeric()
			c := p.OriginalAmount.Currency()
			ocur = &c
		}
		if _, err := tx.Exec(ctx, `INSERT INTO postings (id, profile_id, transaction_id, account_id, amount, currency, original_amount,
			original_currency, exchange_rate_id, line_no, memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			p.ID, t.ProfileID, t.ID, p.AccountID, p.Amount.Numeric(), p.Amount.Currency(), orig, ocur, p.ExchangeRateID, p.LineNo, p.Memo); err != nil {
			return fmt.Errorf("insert posting: %w", err)
		}
	}
	return nil
}

// writeSplits makes the stored split set equal t.Splits. Splits whose id matches an existing split of
// `before` are updated in place (reorder/recategorize keeps ids); the rest are inserted; removed ones are
// soft-deleted. sort_order is the array index.
func writeSplits(ctx context.Context, tx pgx.Tx, t *Transaction, before *Transaction) error {
	existing := map[uuid.UUID]bool{}
	if before != nil {
		for _, s := range before.Splits {
			existing[s.ID] = true
		}
	}
	kept := map[uuid.UUID]bool{}
	for i := range t.Splits {
		s := &t.Splits[i]
		s.SortOrder = i
		if existing[s.ID] && !kept[s.ID] {
			kept[s.ID] = true
			if _, err := tx.Exec(ctx, `UPDATE transaction_splits SET category_id=$3, amount=$4, currency=$5, description=$6, notes=$7,
				sort_order=$8, version = version + 1 WHERE id=$1 AND transaction_id=$2`,
				s.ID, t.ID, s.CategoryID, s.Amount.Numeric(), s.Amount.Currency(), s.Description, s.Notes, s.SortOrder); err != nil {
				return fmt.Errorf("update split: %w", err)
			}
			continue
		}
		s.ID = uuid.New()
		if _, err := tx.Exec(ctx, `INSERT INTO transaction_splits (id, profile_id, transaction_id, category_id, amount, currency,
			description, notes, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			s.ID, t.ProfileID, t.ID, s.CategoryID, s.Amount.Numeric(), s.Amount.Currency(), s.Description, s.Notes, s.SortOrder); err != nil {
			return fmt.Errorf("insert split: %w", err)
		}
	}
	for id := range existing {
		if !kept[id] {
			if _, err := tx.Exec(ctx, `UPDATE transaction_splits SET deleted_at = now() WHERE id = $1`, id); err != nil {
				return fmt.Errorf("delete split: %w", err)
			}
		}
	}
	return nil
}

func writeTags(ctx context.Context, tx pgx.Tx, t *Transaction) error {
	if _, err := tx.Exec(ctx, `DELETE FROM transaction_tags WHERE transaction_id = $1`, t.ID); err != nil {
		return err
	}
	t.TagIDs = uniq(t.TagIDs)
	for _, id := range t.TagIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO transaction_tags (transaction_id, tag_id, profile_id) VALUES ($1,$2,$3)`, t.ID, id, t.ProfileID); err != nil {
			return fmt.Errorf("link tag: %w", err)
		}
	}
	return nil
}

func record(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before *Transaction, action string, meta map[string]any) (*Transaction, error) {
	after, err := Get(ctx, tx, profileID, id, false)
	if err != nil {
		return nil, err
	}
	op := changes.OpUpsert
	var data any = after
	if after.DeletedAt != nil {
		op, data = changes.OpDelete, nil
	}
	var b any
	if before != nil {
		b = before
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: id, Op: op,
		Data: data, Before: b, Action: action, Metadata: meta})
	if err != nil {
		return nil, err
	}
	after.ServerVersion = v
	return after, nil
}

func writeConversion(ctx context.Context, tx pgx.Tx, t *Transaction) error {
	c := t.Conversion
	if c == nil {
		return nil
	}
	var fee pgtype.Numeric
	var feeCur *string
	if c.Fee != nil {
		fee = c.Fee.Numeric()
		fc := c.Fee.Currency()
		feeCur = &fc
	}
	_, err := tx.Exec(ctx, `INSERT INTO currency_conversions (profile_id, transaction_id, from_amount, from_currency, to_amount,
		to_currency, rate, exchange_rate_id, rate_date, method, fee_amount, fee_currency)
		VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9::date,$10,$11,$12)`,
		t.ProfileID, t.ID, c.From.Numeric(), c.From.Currency(), c.To.Numeric(), c.To.Currency(), c.Rate, c.ExchangeRateID,
		c.RateDate, c.Method, fee, feeCur)
	if err != nil {
		return fmt.Errorf("insert conversion: %w", err)
	}
	return nil
}

func conversionEqual(a, b *Conversion) bool {
	if a == nil || b == nil {
		return a == b
	}
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func postingsEqual(a, b []Posting) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.AccountID != y.AccountID || x.Amount.String() != y.Amount.String() || x.Memo != y.Memo ||
			!ptrEq(x.ExchangeRateID, y.ExchangeRateID) || (x.OriginalAmount == nil) != (y.OriginalAmount == nil) ||
			(x.OriginalAmount != nil && x.OriginalAmount.String() != y.OriginalAmount.String()) {
			return false
		}
	}
	return true
}

func ptrEq[T comparable](a, b *T) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// Update persists `after` as the new state of `before` (which must have been loaded FOR UPDATE in tx):
// header columns, postings (soft-delete + reinsert when they differ — postings are immutable), splits
// and tags. Imported evidence (amounts, accounts, booking date) cannot change. Bumps version and records.
func Update(ctx context.Context, tx pgx.Tx, before, after *Transaction, action string, meta map[string]any) (*Transaction, error) {
	if after.ID != before.ID || after.ProfileID != before.ProfileID {
		return nil, errors.New("ledger: update must keep id and profile")
	}
	postingsChanged := !postingsEqual(before.Postings, after.Postings)
	if before.IsImported() && (after.BookingDate != before.BookingDate || !evidenceKept(before, after)) {
		return nil, httpx.NewError(http.StatusConflict, "imported_evidence",
			"amount, account, kind and booking date of imported transactions are evidence; record an adjustment instead")
	}
	if err := validate(ctx, tx, after); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `UPDATE transactions SET kind=$3, status=$4, booking_date=$5::date, value_date=$6::date, occurred_at=$7,
		description=$8, notes=$9, merchant_id=$10, payee=$11, reference=$12, exclude_from_reports=$13, related_transaction_id=$14,
		categorization_source=$15, deleted_at=$16, import_record_id=$17, version = version + 1
		WHERE id=$1 AND profile_id=$2`,
		after.ID, after.ProfileID, after.Kind, after.Status, after.BookingDate, after.ValueDate, after.OccurredAt, after.Description,
		after.Notes, after.MerchantID, after.Payee, after.Reference, after.ExcludeFromReports, after.RelatedTransactionID,
		after.CategorizationSource, after.DeletedAt, after.ImportRecordID)
	if err != nil {
		return nil, fmt.Errorf("update transaction: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, httpx.NotFound("transaction")
	}
	if postingsChanged {
		if _, err := tx.Exec(ctx, `UPDATE postings SET deleted_at = now() WHERE transaction_id = $1 AND deleted_at IS NULL`, after.ID); err != nil {
			return nil, fmt.Errorf("retire postings: %w", err)
		}
		if err := insertPostings(ctx, tx, after); err != nil {
			return nil, err
		}
	}
	if err := writeSplits(ctx, tx, after, before); err != nil {
		return nil, err
	}
	if !slices.Equal(uniq(before.TagIDs), uniq(after.TagIDs)) {
		if err := writeTags(ctx, tx, after); err != nil {
			return nil, err
		}
	}
	if !conversionEqual(before.Conversion, after.Conversion) {
		if _, err := tx.Exec(ctx, `DELETE FROM currency_conversions WHERE transaction_id = $1`, after.ID); err != nil {
			return nil, err
		}
		if err := writeConversion(ctx, tx, after); err != nil {
			return nil, err
		}
	}
	return record(ctx, tx, after.ProfileID, after.ID, before, action, meta)
}

// evidenceKept: the postings of an imported transaction are bank evidence and stay as they are, except
// that an imported income/expense may become one leg of a transfer (linking the two imported halves of a
// transfer between own accounts) and go back again (undo). Its own posting must survive unchanged.
func evidenceKept(before, after *Transaction) bool {
	if after.Kind == before.Kind {
		return postingsEqual(before.Postings, after.Postings)
	}
	single, pair := before, after
	if before.Kind == "transfer" {
		single, pair = after, before
	}
	if !SplitKinds(single.Kind) || pair.Kind != "transfer" || len(single.Postings) != 1 {
		return false
	}
	for _, p := range pair.Postings {
		if postingsEqual([]Posting{p}, single.Postings) {
			return true
		}
	}
	return false
}

// Delete tombstones a transaction (postings stay, but balances ignore deleted transactions).
func Delete(ctx context.Context, tx pgx.Tx, before *Transaction, action string) error {
	if _, err := tx.Exec(ctx, `UPDATE transactions SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`,
		before.ID, before.ProfileID); err != nil {
		return fmt.Errorf("delete transaction: %w", err)
	}
	_, err := record(ctx, tx, before.ProfileID, before.ID, before, action, nil)
	return err
}

// Clone deep-copies t (via its JSON shape) so callers can build an `after` state.
func (t *Transaction) Clone() *Transaction {
	b, _ := json.Marshal(t)
	var c Transaction
	_ = json.Unmarshal(b, &c)
	return &c
}

// ---- small helpers shared by the ledger-core modules ----

// ValidDate checks a YYYY-MM-DD local calendar date.
func ValidDate(s string) error {
	if _, err := time.Parse(time.DateOnly, s); err != nil || len(s) != 10 {
		return errors.New("expected a YYYY-MM-DD date")
	}
	return nil
}

// IDParam parses the {name} URL parameter; malformed ids are 404 (no oracle).
func IDParam(r *http.Request, name, what string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		return uuid.Nil, httpx.NotFound(what)
	}
	return id, nil
}

// IsUnique reports a unique-constraint violation.
func IsUnique(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}

// VersionConflict is the 409 for a stale optimistic-concurrency version.
func VersionConflict(current int) error {
	e := httpx.Conflict("the record was changed by someone else; reload and retry")
	e.Details = map[string]any{"currentVersion": current}
	return e
}

// DecodePatch decodes a JSON object onto dst (pre-filled with current values, giving merge semantics)
// and returns the set of keys present, so callers can tell "absent" from "null".
func DecodePatch(r *http.Request, dst any) (map[string]bool, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "request body too large")
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err := httpx.DecodeJSON(r, dst); err != nil {
		return nil, err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(body, &keys); err != nil {
		return nil, httpx.BadRequest("invalid JSON body")
	}
	set := make(map[string]bool, len(keys))
	for k := range keys {
		set[k] = true
	}
	return set, nil
}

// Today is the current local date in the profile's timezone (for defaults only; never for stored instants).
func Today(ctx context.Context, db DB, profileID uuid.UUID) (string, error) {
	var d string
	err := db.QueryRow(ctx, `SELECT (now() AT TIME ZONE timezone)::date::text FROM profiles WHERE id = $1`, profileID).Scan(&d)
	return d, err
}
