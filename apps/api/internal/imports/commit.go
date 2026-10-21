package imports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// OptUUID distinguishes an absent field from an explicit null.
type OptUUID struct {
	Set   bool
	Value *uuid.UUID
}

func (o *OptUUID) UnmarshalJSON(b []byte) error {
	o.Set = true
	if bytes.Equal(b, []byte("null")) {
		return nil
	}
	var id uuid.UUID
	if err := json.Unmarshal(b, &id); err != nil {
		return err
	}
	o.Value = &id
	return nil
}

type CommitRow struct {
	RawRecordID uuid.UUID `json:"rawRecordId"`
	Selected    *bool     `json:"selected,omitempty"`
	CategoryID  OptUUID   `json:"categoryId"`
	Description *string   `json:"description,omitempty"`
}

type CommitInput struct {
	Rows                 []CommitRow `json:"rows"`
	Version              *int        `json:"version,omitempty"`
	AllowUnreconciled    bool        `json:"allowUnreconciled,omitempty"`
	CreateOpeningBalance bool        `json:"createOpeningBalance,omitempty"`
}

type stagedRecord struct {
	id                    uuid.UUID
	posting               time.Time
	valueDate             *time.Time
	amount, currency      string
	direction, desc       string
	ref, counterparty, fp string
	origAmount, origCur   *string
	outcome               string
	matchTx               *uuid.UUID
	details               map[string]any
	selected, explicitSel bool
	category              *uuid.UUID
	catSource             string
	descOverride          *string
	signed                money.Money
	signedOK              bool
	finalTx               *uuid.UUID
	finalOutcome          string
}

func loadStaged(ctx context.Context, q Querier, profileID, batchID uuid.UUID) ([]*stagedRecord, error) {
	rows, err := q.Query(ctx, `SELECT r.id, r.posting_date, r.value_date, r.amount::text, r.currency, r.direction, r.source_description,
		r.bank_reference, r.counterparty, r.dedupe_fingerprint, r.original_amount::text, r.original_currency, rr.outcome, rr.transaction_id, rr.details
		FROM imported_raw_records r JOIN import_reconciliation_results rr ON rr.raw_record_id = r.id AND rr.import_batch_id = r.import_batch_id
		WHERE r.import_batch_id = $1 AND r.profile_id = $2 ORDER BY r.row_number, r.id`, batchID, profileID)
	if err != nil {
		return nil, fmt.Errorf("load staged rows: %w", err)
	}
	defer rows.Close()
	var out []*stagedRecord
	for rows.Next() {
		s := &stagedRecord{}
		var details []byte
		if err := rows.Scan(&s.id, &s.posting, &s.valueDate, &s.amount, &s.currency, &s.direction, &s.desc, &s.ref, &s.counterparty,
			&s.fp, &s.origAmount, &s.origCur, &s.outcome, &s.matchTx, &details); err != nil {
			return nil, err
		}
		s.currency = strings.TrimSpace(s.currency)
		if s.origCur != nil {
			c := strings.TrimSpace(*s.origCur)
			s.origCur = &c
		}
		_ = json.Unmarshal(details, &s.details)
		s.selected, _ = s.details["selected"].(bool)
		if v, ok := s.details["suggestedCategoryId"].(string); ok {
			if id, err := uuid.Parse(v); err == nil {
				s.category, s.catSource = &id, "import"
			}
		}
		if m, err := Money(s.amount, s.currency); err == nil {
			s.signed, s.signedOK = m, true
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Commit turns the selected staged rows into ledger transactions atomically (all or nothing).
// An interrupted commit leaves the batch staged, so it can simply be retried.
func Commit(ctx context.Context, db *pgxpool.Pool, profileID, userID, batchID uuid.UUID, in CommitInput) (Batch, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return Batch{}, err
	}
	defer tx.Rollback(ctx)
	b, err := getBatch(ctx, tx, profileID, batchID, true)
	if err != nil {
		return b, err
	}
	if b.Status != "staged" {
		return b, httpx.Conflict("batch is " + b.Status + "; only staged batches can be committed")
	}
	if in.Version != nil && *in.Version != b.Version {
		return b, httpx.Conflict("batch version changed; reload the preview")
	}
	if !b.Stats.Recon.OK && !in.AllowUnreconciled {
		return b, &httpx.Error{Status: 422, Code: "reconciliation_failed",
			Message: "statement balances do not reconcile with its transactions; review the file or commit with allowUnreconciled",
			Details: map[string]any{"reconciliation": b.Stats.Recon}}
	}
	acc, err := loadAccount(ctx, tx, profileID, *b.AccountID)
	if err != nil {
		return b, err
	}
	recs, err := loadStaged(ctx, tx, profileID, batchID)
	if err != nil {
		return b, err
	}
	byID := map[uuid.UUID]*stagedRecord{}
	for _, r := range recs {
		byID[r.id] = r
	}
	fieldErrs := map[string]string{}
	var catIDs []uuid.UUID
	for i, cr := range in.Rows {
		r, ok := byID[cr.RawRecordID]
		if !ok {
			fieldErrs[fmt.Sprintf("rows[%d].rawRecordId", i)] = "not a record of this batch"
			continue
		}
		if cr.Selected != nil {
			r.selected, r.explicitSel = *cr.Selected, *cr.Selected
		}
		if cr.CategoryID.Set {
			r.category, r.catSource = cr.CategoryID.Value, "user"
			if r.category != nil {
				catIDs = append(catIDs, *r.category)
			}
		}
		if cr.Description != nil {
			if len(*cr.Description) > 1000 {
				fieldErrs[fmt.Sprintf("rows[%d].description", i)] = "too long"
			}
			r.descOverride = cr.Description
		}
		if r.selected && !r.signedOK || r.selected && r.outcome == "error" {
			fieldErrs[fmt.Sprintf("rows[%d].selected", i)] = "row has errors and cannot be imported"
		}
	}
	if len(catIDs) > 0 {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(DISTINCT id) FROM categories WHERE profile_id = $1 AND deleted_at IS NULL AND id = ANY($2)`,
			profileID, catIDs).Scan(&n); err != nil {
			return b, err
		}
		if n != len(uniq(catIDs)) {
			fieldErrs["rows.categoryId"] = "unknown category"
		}
	}
	if len(fieldErrs) > 0 {
		return b, httpx.Validation(fieldErrs)
	}
	// Re-check duplicates: another overlapping batch may have been committed since staging.
	var fps []string
	for _, r := range recs {
		if r.selected && (r.outcome == "new" || r.outcome == "conflict") {
			fps = append(fps, r.fp)
		}
	}
	if len(fps) > 0 {
		q, err := tx.Query(ctx, `SELECT DISTINCT r.dedupe_fingerprint FROM imported_raw_records r
			JOIN transactions t ON t.import_record_id = r.id AND t.deleted_at IS NULL
			WHERE r.profile_id = $1 AND r.account_id = $2 AND r.dedupe_fingerprint = ANY($3) AND r.import_batch_id <> $4`,
			profileID, acc.ID, fps, batchID)
		if err != nil {
			return b, err
		}
		dups, err := pgx.CollectRows(q, pgx.RowTo[string])
		if err != nil {
			return b, err
		}
		dupSet := map[string]bool{}
		for _, d := range dups {
			dupSet[d] = true
		}
		for _, r := range recs {
			if r.selected && dupSet[r.fp] && !r.explicitSel {
				r.selected, r.finalOutcome = false, "duplicate"
			}
		}
	}

	now := time.Now().UTC()
	var txRows, postRows, splitRows [][]any
	type created struct {
		id   uuid.UUID
		snap map[string]any
	}
	var newTx []created
	st := b.Stats
	st.Committed, st.Linked, st.Skipped = 0, 0, 0
	for _, r := range recs {
		if r.finalOutcome == "" {
			r.finalOutcome = r.outcome
		}
		if !r.selected {
			st.Skipped++
			continue
		}
		if r.outcome == "matched" && r.matchTx != nil {
			if err := linkExisting(ctx, tx, profileID, r); err != nil {
				return b, err
			}
			r.finalTx = r.matchTx
			st.Linked++
			continue
		}
		id := uuid.New()
		r.finalTx, r.finalOutcome = &id, map[string]string{"duplicate": "duplicate", "conflict": "conflict"}[r.outcome]
		if r.finalOutcome == "" {
			r.finalOutcome = "new"
		}
		kind := "income"
		if r.signed.Sign() < 0 {
			kind = "expense"
		}
		desc := r.desc
		if r.descOverride != nil {
			desc = *r.descOverride
		}
		catSrc := "none"
		if r.category != nil {
			catSrc = r.catSource
		}
		pid, sid := uuid.New(), uuid.New()
		var vd any
		var vds *string
		if r.valueDate != nil {
			vd, vds = *r.valueDate, dateStr(r.valueDate)
		}
		var origAmt, origCur any
		var origMoney *money.Money
		if r.origAmount != nil && r.origCur != nil {
			if m, err := Money(*r.origAmount, *r.origCur); err == nil {
				if r.signed.Sign() < 0 {
					m = m.Neg()
				}
				origAmt, origCur, origMoney = m.Numeric(), *r.origCur, &m
			}
		}
		txRows = append(txRows, []any{id, profileID, kind, "cleared", r.posting, vd, desc, r.counterparty, r.ref, "import", r.id, catSrc, userID, now, now})
		postRows = append(postRows, []any{pid, profileID, id, acc.ID, r.signed.Numeric(), r.currency, origAmt, origCur, 0, now})
		splitRows = append(splitRows, []any{sid, profileID, id, r.category, r.signed.Abs().Numeric(), r.currency, 0, now, now})
		newTx = append(newTx, created{id, map[string]any{
			"id": id, "profileId": profileID, "version": 1, "serverVersion": 0, "createdAt": now, "updatedAt": now, "deletedAt": nil,
			"kind": kind, "status": "cleared", "bookingDate": r.posting.Format(time.DateOnly), "valueDate": vds, "occurredAt": nil,
			"description": desc, "notes": "", "merchantId": nil, "payee": r.counterparty, "reference": r.ref, "excludeFromReports": false,
			"source": "import", "importRecordId": r.id, "relatedTransactionId": nil, "correctsTransactionId": nil, "categorizationSource": catSrc,
			"postings":      []map[string]any{{"id": pid, "accountId": acc.ID, "amount": r.signed, "originalAmount": origMoney, "exchangeRateId": nil, "lineNo": 0, "memo": ""}},
			"splits":        []map[string]any{{"id": sid, "categoryId": r.category, "amount": r.signed.Abs(), "description": "", "notes": "", "sortOrder": 0}},
			"tagIds":        []uuid.UUID{},
			"attachmentIds": []uuid.UUID{},
		}})
	}
	if len(txRows) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"transactions"}, []string{"id", "profile_id", "kind", "status", "booking_date", "value_date",
			"description", "payee", "reference", "source", "import_record_id", "categorization_source", "created_by", "created_at", "updated_at"},
			pgx.CopyFromRows(txRows)); err != nil {
			return b, fmt.Errorf("insert transactions: %w", err)
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"postings"}, []string{"id", "profile_id", "transaction_id", "account_id", "amount", "currency",
			"original_amount", "original_currency", "line_no", "created_at"}, pgx.CopyFromRows(postRows)); err != nil {
			return b, fmt.Errorf("insert postings: %w", err)
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"transaction_splits"}, []string{"id", "profile_id", "transaction_id", "category_id", "amount",
			"currency", "sort_order", "created_at", "updated_at"}, pgx.CopyFromRows(splitRows)); err != nil {
			return b, fmt.Errorf("insert splits: %w", err)
		}
	}
	for _, c := range newTx {
		v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: c.id, Op: changes.OpUpsert,
			Data: c.snap, Action: "transaction.import", Metadata: map[string]any{"import_batch_id": batchID.String()}})
		if err != nil {
			return b, err
		}
		c.snap["serverVersion"] = v
		st.Committed++
	}
	// Persist final outcomes on the reconciliation rows.
	var rids, tids []uuid.UUID
	var outs []string
	var sels []bool
	for _, r := range recs {
		rids, outs, sels = append(rids, r.id), append(outs, r.finalOutcome), append(sels, r.selected)
		if r.finalTx != nil {
			tids = append(tids, *r.finalTx)
		} else {
			tids = append(tids, uuid.Nil)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE import_reconciliation_results rr SET transaction_id = NULLIF(u.tid, '00000000-0000-0000-0000-000000000000'::uuid),
		outcome = CASE WHEN u.tid <> '00000000-0000-0000-0000-000000000000'::uuid OR rr.outcome = 'error' THEN u.outcome ELSE 'skipped' END,
		details = rr.details || jsonb_build_object('selected', u.sel), resolved_by = $3, resolved_at = now()
		FROM unnest($1::uuid[], $2::uuid[], $4::text[], $5::bool[]) AS u(rid, tid, outcome, sel)
		WHERE rr.raw_record_id = u.rid AND rr.import_batch_id = $6`, rids, tids, userID, outs, sels, batchID); err != nil {
		return b, fmt.Errorf("update results: %w", err)
	}
	if in.CreateOpeningBalance {
		if err := openingBalance(ctx, tx, profileID, userID, acc, &b, &st); err != nil {
			return b, err
		}
	}
	if err := ledgerCheck(ctx, tx, acc, &b, &st); err != nil {
		return b, err
	}
	b.Stats, b.Status, b.CommittedAt = st, "committed", &now
	if err := saveBatch(ctx, tx, &b, "import.commit"); err != nil {
		return b, err
	}
	return b, tx.Commit(ctx)
}

func uniq(ids []uuid.UUID) map[uuid.UUID]bool {
	m := map[uuid.UUID]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}

// linkExisting attaches the bank evidence to an existing transaction (manual entry, or the
// previous import's transaction when reprocessing). User classifications stay untouched.
func linkExisting(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, r *stagedRecord) error {
	var prev *uuid.UUID
	if v, ok := r.details["previousImportRecordId"].(string); ok {
		if id, err := uuid.Parse(v); err == nil {
			prev = &id
		}
	}
	before, err := TransactionSnapshot(ctx, tx, profileID, *r.matchTx)
	if err != nil {
		return err
	}
	set := `import_record_id = $3, version = version + 1`
	args := []any{*r.matchTx, profileID, r.id, prev}
	if r.descOverride != nil {
		set += `, description = $5`
		args = append(args, *r.descOverride)
	}
	tag, err := tx.Exec(ctx, `UPDATE transactions SET `+set+` WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL
		AND import_record_id IS NOT DISTINCT FROM $4`, args...)
	if err != nil {
		return fmt.Errorf("link transaction: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return httpx.Conflict(fmt.Sprintf("transaction %s changed since the preview; reprocess or restage the batch", r.matchTx))
	}
	snap, err := TransactionSnapshot(ctx, tx, profileID, *r.matchTx)
	if err != nil {
		return err
	}
	_, err = changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: *r.matchTx, Op: changes.OpUpsert,
		Data: snap, Before: before, Action: "transaction.import_link"})
	return err
}

func ledgerBalance(ctx context.Context, tx pgx.Tx, acc account, cond string, date string) (money.Money, bool, error) {
	var sum *string
	var n int
	err := tx.QueryRow(ctx, `SELECT sum(p.amount)::text, count(*) FROM postings p JOIN transactions t ON t.id = p.transaction_id
		WHERE p.account_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND p.currency = $2 AND t.booking_date `+cond+` $3::date`,
		acc.ID, acc.Currency, date).Scan(&sum, &n)
	if err != nil {
		return money.Money{}, false, err
	}
	if sum == nil {
		z, err := money.Zero(acc.Currency)
		return z, false, err
	}
	m, err := Money(*sum, acc.Currency)
	return m, n > 0, err
}

// openingBalance (Feature 129) books the difference between the statement opening balance and the
// ledger balance the day before the statement starts: opening_balance when the account has no
// earlier history, otherwise a reconciliation adjustment.
func openingBalance(ctx context.Context, tx pgx.Tx, profileID, userID uuid.UUID, acc account, b *Batch, st *Stats) error {
	if st.Recon.OpeningBalance == nil || b.CoverageStart == nil {
		return httpx.Unprocessable("the statement has no opening balance; enter the opening balance manually")
	}
	ledger, hasHistory, err := ledgerBalance(ctx, tx, acc, "<", *b.CoverageStart)
	if err != nil {
		return err
	}
	diff, err := st.Recon.OpeningBalance.Sub(ledger)
	if err != nil || diff.IsZero() {
		return err
	}
	kind, desc := "opening_balance", "Opening balance"
	if hasHistory {
		kind, desc = "adjustment", "Reconciliation adjustment"
	}
	desc += " (statement " + b.FileName + ")"
	start, _ := time.Parse(time.DateOnly, *b.CoverageStart)
	day := start.AddDate(0, 0, -1)
	id, pid := uuid.New(), uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO transactions (id, profile_id, kind, status, booking_date, description, source, created_by)
		VALUES ($1,$2,$3,'reconciled',$4,$5,'import',$6)`, id, profileID, kind, day, desc, userID); err != nil {
		return fmt.Errorf("opening balance: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO postings (id, profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,$4,$5,$6)`,
		pid, profileID, id, acc.ID, diff.Numeric(), acc.Currency); err != nil {
		return fmt.Errorf("opening balance posting: %w", err)
	}
	snap, err := TransactionSnapshot(ctx, tx, profileID, id)
	if err != nil {
		return err
	}
	if _, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: id, Op: changes.OpUpsert,
		Data: snap, Action: "transaction.opening_balance", Metadata: map[string]any{"import_batch_id": b.ID.String()}}); err != nil {
		return err
	}
	st.OpeningTxID = &id
	return nil
}

// ledgerCheck compares the account ledger at the statement end with the statement closing balance.
func ledgerCheck(ctx context.Context, tx pgx.Tx, acc account, b *Batch, st *Stats) error {
	st.LedgerMatches, st.LedgerDiff = nil, nil
	if st.Recon.ClosingBalance == nil || b.CoverageEnd == nil {
		return nil
	}
	ledger, _, err := ledgerBalance(ctx, tx, acc, "<=", *b.CoverageEnd)
	if err != nil {
		return err
	}
	diff, err := ledger.Sub(*st.Recon.ClosingBalance)
	if err != nil {
		return err
	}
	ok := diff.IsZero()
	st.LedgerMatches, st.LedgerDiff = &ok, &diff
	return nil
}

// Rollback removes exactly the transactions this batch created (soft delete, synced as tombstones)
// and restores links it changed. Unrelated transactions are never touched.
func Rollback(ctx context.Context, db *pgxpool.Pool, profileID, batchID uuid.UUID) (Batch, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return Batch{}, err
	}
	defer tx.Rollback(ctx)
	b, err := getBatch(ctx, tx, profileID, batchID, true)
	if err != nil {
		return b, err
	}
	if b.Status != "committed" {
		return b, httpx.Conflict("batch is " + b.Status + "; only committed batches can be rolled back")
	}
	type link struct {
		tx      uuid.UUID
		outcome string
		prev    *uuid.UUID
	}
	q, err := tx.Query(ctx, `SELECT t.id, rr.outcome, (rr.details->>'previousImportRecordId')::uuid
		FROM transactions t JOIN imported_raw_records r ON r.id = t.import_record_id
		JOIN import_reconciliation_results rr ON rr.raw_record_id = r.id
		WHERE r.import_batch_id = $1 AND t.profile_id = $2 AND t.deleted_at IS NULL
		ORDER BY t.id FOR UPDATE OF t`, batchID, profileID)
	if err != nil {
		return b, fmt.Errorf("rollback lookup: %w", err)
	}
	var links []link
	for q.Next() {
		var l link
		if err := q.Scan(&l.tx, &l.outcome, &l.prev); err != nil {
			q.Close()
			return b, err
		}
		links = append(links, l)
	}
	q.Close()
	if err := q.Err(); err != nil {
		return b, err
	}
	st := b.Stats
	st.RolledBack, st.Unlinked = 0, 0
	for _, l := range links {
		before, err := TransactionSnapshot(ctx, tx, profileID, l.tx)
		if err != nil {
			return b, err
		}
		if l.outcome == "matched" { // existed before this batch: restore its previous evidence link
			if _, err := tx.Exec(ctx, `UPDATE transactions SET import_record_id = $3, version = version + 1 WHERE id = $1 AND profile_id = $2`,
				l.tx, profileID, l.prev); err != nil {
				return b, fmt.Errorf("unlink: %w", err)
			}
			snap, err := TransactionSnapshot(ctx, tx, profileID, l.tx)
			if err != nil {
				return b, err
			}
			if _, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: l.tx,
				Op: changes.OpUpsert, Data: snap, Before: before, Action: "transaction.import_unlink"}); err != nil {
				return b, err
			}
			st.Unlinked++
			continue
		}
		if err := softDeleteTx(ctx, tx, profileID, l.tx, before); err != nil {
			return b, err
		}
		st.RolledBack++
	}
	if st.OpeningTxID != nil {
		before, err := TransactionSnapshot(ctx, tx, profileID, *st.OpeningTxID)
		if err == nil && before["deletedAt"] == (*time.Time)(nil) {
			if err := softDeleteTx(ctx, tx, profileID, *st.OpeningTxID, before); err != nil {
				return b, err
			}
			st.RolledBack++
		}
	}
	now := time.Now().UTC()
	b.Stats, b.Status, b.RolledBackAt = st, "rolled_back", &now
	if err := saveBatch(ctx, tx, &b, "import.rollback"); err != nil {
		return b, err
	}
	return b, tx.Commit(ctx)
}

func softDeleteTx(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, before map[string]any) error {
	if _, err := tx.Exec(ctx, `UPDATE transactions SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2`, id, profileID); err != nil {
		return fmt.Errorf("delete transaction: %w", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE postings SET deleted_at = now() WHERE transaction_id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE transaction_splits SET deleted_at = now(), version = version + 1 WHERE transaction_id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID); err != nil {
		return err
	}
	_, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "transactions", EntityID: id, Op: changes.OpDelete,
		Before: before, Action: "transaction.import_rollback"})
	return err
}

// ---------- preview ----------

type wireMoney struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

func toWire(text, cur string) wireMoney {
	if m, err := Money(text, cur); err == nil {
		return wireMoney{m.Amount(), m.Currency()}
	}
	return wireMoney{trimZeros(text), strings.TrimSpace(cur)} // unnormalizable (error row): shown as stored
}

type RawRecord struct {
	ID                uuid.UUID      `json:"id"`
	ImportBatchID     uuid.UUID      `json:"importBatchId"`
	AccountID         *uuid.UUID     `json:"accountId"`
	RowNumber         int            `json:"rowNumber"`
	SourceDescription string         `json:"sourceDescription"`
	PostingDate       string         `json:"postingDate"`
	ValueDate         *string        `json:"valueDate"`
	Amount            wireMoney      `json:"amount"`
	Direction         string         `json:"direction"`
	OriginalAmount    *wireMoney     `json:"originalAmount"`
	ExchangeRate      *string        `json:"exchangeRate"`
	RunningBalance    *wireMoney     `json:"runningBalance"`
	BankReference     string         `json:"bankReference"`
	StatementRef      string         `json:"statementRef"`
	SourceAccount     string         `json:"sourceAccount"`
	Counterparty      string         `json:"counterparty"`
	Raw               map[string]any `json:"raw"`
	DedupeFingerprint string         `json:"dedupeFingerprint"`
	ImporterID        string         `json:"importerId"`
	ImporterVersion   string         `json:"importerVersion"`
	Warnings          []string       `json:"warnings"`
	CreatedAt         time.Time      `json:"createdAt"`
}

const rawCols = `r.id, r.import_batch_id, r.account_id, r.row_number, r.source_description, r.posting_date, r.value_date, r.amount::text,
	r.currency, r.direction, r.original_amount::text, r.original_currency, r.exchange_rate::text, r.running_balance::text, r.bank_reference,
	r.statement_ref, r.source_account, r.counterparty, r.raw, r.dedupe_fingerprint, r.importer_id, r.importer_version, r.warnings, r.created_at`

func scanRaw(row pgx.Row, extra ...any) (RawRecord, error) {
	var r RawRecord
	var pd time.Time
	var vd *time.Time
	var amt, cur string
	var oAmt, oCur, rate, run *string
	var raw, warn []byte
	err := row.Scan(append([]any{&r.ID, &r.ImportBatchID, &r.AccountID, &r.RowNumber, &r.SourceDescription, &pd, &vd, &amt, &cur, &r.Direction,
		&oAmt, &oCur, &rate, &run, &r.BankReference, &r.StatementRef, &r.SourceAccount, &r.Counterparty, &raw, &r.DedupeFingerprint,
		&r.ImporterID, &r.ImporterVersion, &warn, &r.CreatedAt}, extra...)...)
	if err != nil {
		return r, err
	}
	r.PostingDate, r.ValueDate = pd.Format(time.DateOnly), dateStr(vd)
	r.Amount = toWire(amt, cur)
	if oAmt != nil && oCur != nil {
		w := toWire(*oAmt, *oCur)
		r.OriginalAmount = &w
	}
	if rate != nil {
		s := trimZeros(*rate)
		r.ExchangeRate = &s
	}
	if run != nil {
		w := toWire(*run, cur)
		r.RunningBalance = &w
	}
	_ = json.Unmarshal(raw, &r.Raw)
	var issues []Issue
	_ = json.Unmarshal(warn, &issues)
	r.Warnings = []string{}
	for _, i := range issues {
		r.Warnings = append(r.Warnings, i.Message)
	}
	return r, nil
}

type PreviewRow struct {
	RawRecordID         uuid.UUID  `json:"rawRecordId"`
	Record              RawRecord  `json:"record"`
	Outcome             string     `json:"outcome"`
	MatchTransactionID  *uuid.UUID `json:"matchTransactionId"`
	MatchScore          *string    `json:"matchScore"`
	SuggestedCategoryID *uuid.UUID `json:"suggestedCategoryId"`
	Selected            bool       `json:"selected"`
	Issues              []string   `json:"issues"`
}

type Preview struct {
	Batch  Batch        `json:"batch"`
	Rows   []PreviewRow `json:"rows"`
	Totals struct {
		Income     *money.Money `json:"income"`
		Expenses   *money.Money `json:"expenses"`
		Count      int          `json:"count"`
		New        int          `json:"new"`
		Duplicates int          `json:"duplicates"`
		Matched    int          `json:"matched"`
		Conflicts  int          `json:"conflicts"`
		Errors     int          `json:"errors"`
	} `json:"totals"`
	Reconciliation Recon  `json:"reconciliation"`
	NextCursor     string `json:"nextCursor,omitempty"`
}

func GetPreview(ctx context.Context, db Querier, profileID, batchID uuid.UUID, page httpx.Page) (Preview, error) {
	var p Preview
	b, err := getBatch(ctx, db, profileID, batchID, false)
	if err != nil {
		return p, err
	}
	p.Batch, p.Reconciliation = b, b.Stats.Recon
	t := &p.Totals
	t.Income, t.Expenses, t.Count = b.Stats.Income, b.Stats.Expenses, b.Stats.Records
	t.New, t.Duplicates, t.Matched, t.Conflicts, t.Errors = b.Stats.New, b.Stats.Duplicates, b.Stats.Matched, b.Stats.Conflicts, b.Stats.Errors
	var after struct{ Row int }
	after.Row = -1
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return p, err
	}
	rows, err := db.Query(ctx, `SELECT `+rawCols+`, rr.outcome, rr.transaction_id, rr.match_score::text, rr.details
		FROM imported_raw_records r JOIN import_reconciliation_results rr ON rr.raw_record_id = r.id
		WHERE r.import_batch_id = $1 AND r.profile_id = $2 AND r.row_number > $3 ORDER BY r.row_number, r.id LIMIT $4`,
		batchID, profileID, after.Row, page.Limit+1)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.Rows = []PreviewRow{}
	for rows.Next() {
		var pr PreviewRow
		var details []byte
		rec, err := scanRaw(rows, &pr.Outcome, &pr.MatchTransactionID, &pr.MatchScore, &details)
		if err != nil {
			return p, err
		}
		pr.Record, pr.RawRecordID = rec, rec.ID
		var d struct {
			Selected  bool       `json:"selected"`
			Suggested *uuid.UUID `json:"suggestedCategoryId"`
			Issues    []string   `json:"issues"`
		}
		_ = json.Unmarshal(details, &d)
		pr.Selected, pr.SuggestedCategoryID, pr.Issues = d.Selected, d.Suggested, nonNil(d.Issues)
		p.Rows = append(p.Rows, pr)
	}
	if err := rows.Err(); err != nil {
		return p, err
	}
	// row_number can repeat only across multi-statement files; keyset on it is good enough for pages.
	if len(p.Rows) > page.Limit {
		p.Rows = p.Rows[:page.Limit]
		p.NextCursor = httpx.EncodeCursor(struct{ Row int }{p.Rows[len(p.Rows)-1].Record.RowNumber})
	}
	return p, nil
}

// ---------- reprocess ----------

// Reprocess re-parses the stored original file with the current version of its importer (and the
// current template definition) into a new staged batch. Rows whose fingerprint matches a
// transaction of the old batch are "matched": committing relinks those transactions to the new
// evidence, keeping every user edit (categories, splits, notes, tags).
func Reprocess(ctx context.Context, db *pgxpool.Pool, profileID, userID, batchID uuid.UUID, maxBytes int64) (Batch, error) {
	b, err := getBatch(ctx, db, profileID, batchID, false)
	if err != nil {
		return b, err
	}
	if b.Status != "committed" {
		return b, httpx.Conflict("only committed batches can be reprocessed")
	}
	imp := findImporter(b.ImporterID)
	if imp == nil {
		return b, &httpx.Error{Status: 422, Code: "client_reprocess_required",
			Message: "importer " + b.ImporterID + " runs in the web client; re-run it there and stage with reprocessedFromBatchId"}
	}
	var src []byte
	var name string
	if err := db.QueryRow(ctx, `SELECT content, file_name FROM import_batch_sources WHERE import_batch_id = $1 AND profile_id = $2`,
		batchID, profileID).Scan(&src, &name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return b, httpx.Unprocessable("original file of this batch is not stored")
		}
		return b, err
	}
	return ParseAndStage(ctx, db, ParseRequest{ProfileID: profileID, UserID: userID, AccountID: *b.AccountID, ImporterID: imp.ID,
		TemplateID: b.TemplateID, FileName: name, Bytes: src, ReprocessedFrom: &batchID}, maxBytes)
}
