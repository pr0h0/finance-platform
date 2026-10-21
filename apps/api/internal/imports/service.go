package imports

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// ---------- batch row + API shape ----------

type Recon struct {
	HasBalances              bool         `json:"hasBalances"`
	OpeningBalance           *money.Money `json:"openingBalance"`
	ClosingBalance           *money.Money `json:"closingBalance"`
	ComputedClosing          *money.Money `json:"computedClosing"`
	OK                       bool         `json:"ok"`
	OpeningSource            string       `json:"openingSource,omitempty"` // statement | running_balance
	RunningBalanceMismatches int          `json:"runningBalanceMismatches"`
}

type Stats struct {
	Encoding      string       `json:"encoding,omitempty"`
	Records       int          `json:"records"`
	New           int          `json:"new"`
	Duplicates    int          `json:"duplicates"`
	Matched       int          `json:"matched"`
	Conflicts     int          `json:"conflicts"`
	Errors        int          `json:"errors"`
	ParseErrors   []Issue      `json:"parseErrors"`
	Warnings      []Issue      `json:"warnings"`
	Income        *money.Money `json:"income"`
	Expenses      *money.Money `json:"expenses"`
	Recon         Recon        `json:"reconciliation"`
	Orphaned      []uuid.UUID  `json:"orphanedTransactionIds,omitempty"` // reprocess: old rows absent from the new parse
	Committed     int          `json:"committed,omitempty"`
	Linked        int          `json:"linked,omitempty"`
	Skipped       int          `json:"skipped,omitempty"`
	LedgerMatches *bool        `json:"ledgerMatchesClosing,omitempty"`
	LedgerDiff    *money.Money `json:"ledgerDifference,omitempty"`
	OpeningTxID   *uuid.UUID   `json:"openingBalanceTransactionId,omitempty"`
	RolledBack    int          `json:"rolledBack,omitempty"`
	Unlinked      int          `json:"unlinked,omitempty"`
}

type Batch struct {
	ID              uuid.UUID  `json:"id"`
	ProfileID       uuid.UUID  `json:"profileId"`
	Version         int        `json:"version"`
	ServerVersion   int64      `json:"serverVersion"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	DeletedAt       *time.Time `json:"deletedAt"`
	AccountID       *uuid.UUID `json:"accountId"`
	ImporterID      string     `json:"importerId"`
	ImporterVersion string     `json:"importerVersion"`
	TemplateID      *uuid.UUID `json:"templateId"`
	FileName        string     `json:"fileName"`
	FileSha256      string     `json:"fileSha256"`
	FileSize        int64      `json:"fileSize"`
	Status          string     `json:"status"`
	CoverageStart   *string    `json:"coverageStart"`
	CoverageEnd     *string    `json:"coverageEnd"`
	Stats           Stats      `json:"stats"`
	Error           *string    `json:"error"`
	CommittedAt     *time.Time `json:"committedAt"`
	RolledBackAt    *time.Time `json:"rolledBackAt"`
	ReprocessedFrom *uuid.UUID `json:"reprocessedFromBatchId"`
}

const batchCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, account_id, importer_id,
	importer_version, template_id, file_name, file_sha256, file_size, status, coverage_start, coverage_end, stats, error,
	committed_at, rolled_back_at, reprocessed_from_batch_id`

func scanBatch(row pgx.Row) (Batch, error) {
	var b Batch
	var sha []byte
	var cs, ce *time.Time
	var stats []byte
	err := row.Scan(&b.ID, &b.ProfileID, &b.Version, &b.ServerVersion, &b.CreatedAt, &b.UpdatedAt, &b.DeletedAt, &b.AccountID,
		&b.ImporterID, &b.ImporterVersion, &b.TemplateID, &b.FileName, &sha, &b.FileSize, &b.Status, &cs, &ce, &stats, &b.Error,
		&b.CommittedAt, &b.RolledBackAt, &b.ReprocessedFrom)
	if err != nil {
		return b, err
	}
	b.FileSha256 = hex.EncodeToString(sha)
	b.CoverageStart, b.CoverageEnd = dateStr(cs), dateStr(ce)
	if err := json.Unmarshal(stats, &b.Stats); err != nil {
		return b, fmt.Errorf("batch stats: %w", err)
	}
	return b, nil
}

func getBatch(ctx context.Context, q Querier, profileID, id uuid.UUID, lock bool) (Batch, error) {
	sql := `SELECT ` + batchCols + ` FROM import_batches WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`
	if lock {
		sql += ` FOR UPDATE`
	}
	b, err := scanBatch(q.QueryRow(ctx, sql, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return b, httpx.NotFound("import batch")
	}
	return b, err
}

// saveBatch writes status/stats/coverage, bumps version and records the sync change + audit.
func saveBatch(ctx context.Context, tx pgx.Tx, b *Batch, action string) error {
	bump := 1
	if action == "import.stage" {
		bump = 0 // first write of a new batch
	}
	stats, err := json.Marshal(b.Stats)
	if err != nil {
		return err
	}
	b2, err := scanBatch(tx.QueryRow(ctx, `UPDATE import_batches SET status = $3, stats = $4, error = $5, coverage_start = $6, coverage_end = $7,
		committed_at = $8, rolled_back_at = $9, version = version + $10 WHERE id = $1 AND profile_id = $2 RETURNING `+batchCols,
		b.ID, b.ProfileID, b.Status, stats, b.Error, b.CoverageStart, b.CoverageEnd, b.CommittedAt, b.RolledBackAt, bump))
	if err != nil {
		return fmt.Errorf("update batch: %w", err)
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: b.ProfileID, EntityType: "import_batches", EntityID: b.ID,
		Op: changes.OpUpsert, Data: b2, Action: action})
	b2.ServerVersion = v
	*b = b2
	return err
}

// ---------- account ----------

type account struct {
	ID       uuid.UUID
	Currency string
	Multi    bool
}

func loadAccount(ctx context.Context, q Querier, profileID, id uuid.UUID) (account, error) {
	a := account{ID: id}
	err := q.QueryRow(ctx, `SELECT currency, is_multi_currency FROM accounts WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`,
		id, profileID).Scan(&a.Currency, &a.Multi)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, httpx.Validation(map[string]string{"accountId": "unknown account"})
	}
	a.Currency = strings.TrimSpace(a.Currency)
	return a, err
}

// ---------- staging ----------

type StageInput struct {
	ProfileID       uuid.UUID
	UserID          uuid.UUID
	AccountID       uuid.UUID
	Importer        string
	ImporterVersion string
	TemplateID      *uuid.UUID
	FileName        string
	Source          []byte
	Encoding        string
	Result          Result
	ReprocessedFrom *uuid.UUID
}

type stagedRow struct {
	rec       Record
	id        uuid.UUID
	fp        string
	signed    *money.Money // nil when the row cannot be committed
	issues    []string
	outcome   string
	matchTx   *uuid.UUID
	score     *float64
	suggested *uuid.UUID
	selected  bool
	prevRec   *uuid.UUID // reprocess: record the matched transaction pointed to before
}

var (
	isoCurrency = regexp.MustCompile(`^[A-Z]{3}$`)
	isoDate     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func parseISODate(s string) (time.Time, bool) {
	if !isoDate.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.Parse(time.DateOnly, s)
	return t, err == nil
}

// validateRecords drops structurally invalid records into parse errors (they cannot be stored) and
// marks committable ones with their signed Money.
func validateRecords(res Result, acc account) ([]stagedRow, []Issue) {
	errs := append([]Issue{}, res.Errors...)
	var rows []stagedRow
	for _, r := range res.Records {
		r.Currency = strings.ToUpper(strings.TrimSpace(r.Currency))
		bad := func(field, msg string) {
			errs = append(errs, Issue{Row: r.RowNumber, Field: field, Code: "invalid_" + field, Message: msg})
		}
		if _, ok := parseISODate(r.PostingDate); !ok {
			bad("postingDate", "postingDate must be YYYY-MM-DD")
			continue
		}
		if r.Direction != "debit" && r.Direction != "credit" {
			bad("direction", "direction must be debit or credit")
			continue
		}
		if !plainDecimal.MatchString(r.Amount) {
			bad("amount", "amount must be a positive decimal string")
			continue
		}
		if !isoCurrency.MatchString(r.Currency) {
			bad("currency", "currency must be an ISO 4217 code")
			continue
		}
		if r.ValueDate != "" {
			if _, ok := parseISODate(r.ValueDate); !ok {
				r.ValueDate = ""
			}
		}
		if r.Raw == nil {
			r.Raw = map[string]string{}
		}
		if r.Warnings == nil {
			r.Warnings = []Issue{}
		}
		sr := stagedRow{rec: r, id: uuid.New()}
		m, err := money.Parse(r.Amount, r.Currency)
		switch {
		case err != nil:
			sr.issues = append(sr.issues, err.Error())
		case r.Currency != acc.Currency && !acc.Multi:
			sr.issues = append(sr.issues, fmt.Sprintf("currency %s differs from the account currency %s", r.Currency, acc.Currency))
		default:
			if r.Direction == "debit" {
				m = m.Neg()
			}
			sr.signed = &m
		}
		for _, w := range r.Warnings {
			sr.issues = append(sr.issues, w.Message)
		}
		rows = append(rows, sr)
	}
	recs := make([]Record, len(rows))
	for i := range rows {
		recs[i] = rows[i].rec
	}
	for i, fp := range Fingerprints(recs) {
		rows[i].fp = fp
	}
	return rows, errs
}

func numeric(s string) pgtype.Numeric {
	var n pgtype.Numeric
	if s == "" || n.Scan(s) != nil {
		return pgtype.Numeric{}
	}
	return n
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Stage parses nothing: it persists an already-parsed result (server parser or web client) as a
// staged batch with immutable raw records, dedupe outcomes, suggestions and reconciliation.
func Stage(ctx context.Context, db *pgxpool.Pool, in StageInput) (Batch, error) {
	if len(in.Result.Records) > maxRecords {
		return Batch{}, httpx.Unprocessable(fmt.Sprintf("too many records (max %d)", maxRecords))
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return Batch{}, err
	}
	defer tx.Rollback(ctx)
	acc, err := loadAccount(ctx, tx, in.ProfileID, in.AccountID)
	if err != nil {
		return Batch{}, err
	}
	rows, parseErrs := validateRecords(in.Result, acc)
	if len(rows) == 0 {
		return Batch{}, &httpx.Error{Status: 422, Code: "import_empty", Message: "no importable records found", Details: map[string]any{"errors": capIssues(parseErrs)}}
	}
	sum := sha256.Sum256(in.Source)
	batchID := uuid.New()
	var start, end string
	for _, r := range rows {
		if start == "" || r.rec.PostingDate < start {
			start = r.rec.PostingDate
		}
		if r.rec.PostingDate > end {
			end = r.rec.PostingDate
		}
	}
	st := mergeStatements(in.Result.Statements)
	if st != nil {
		if _, ok := parseISODate(st.PeriodStart); ok && st.PeriodStart < start {
			start = st.PeriodStart
		}
		if _, ok := parseISODate(st.PeriodEnd); ok && st.PeriodEnd > end {
			end = st.PeriodEnd
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO import_batches (id, profile_id, account_id, importer_id, importer_version, template_id,
		file_name, file_sha256, file_size, status, coverage_start, coverage_end, created_by, reprocessed_from_batch_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'staged',$10,$11,$12,$13)`,
		batchID, in.ProfileID, in.AccountID, in.Importer, in.ImporterVersion, in.TemplateID, in.FileName, sum[:], len(in.Source),
		start, end, in.UserID, in.ReprocessedFrom); err != nil {
		return Batch{}, fmt.Errorf("insert batch: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO import_batch_sources (import_batch_id, profile_id, file_name, encoding, content) VALUES ($1,$2,$3,$4,$5)`,
		batchID, in.ProfileID, in.FileName, in.Encoding, in.Source); err != nil {
		return Batch{}, fmt.Errorf("insert source: %w", err)
	}
	var stmtID *uuid.UUID
	if st != nil {
		id := uuid.New()
		stmtID = &id
		var ps, pe *string
		if _, ok := parseISODate(st.PeriodStart); ok {
			ps = &st.PeriodStart
		}
		if _, ok := parseISODate(st.PeriodEnd); ok {
			pe = &st.PeriodEnd
		}
		cur := strings.ToUpper(st.Currency)
		if cur == "" {
			cur = acc.Currency
		}
		var curP *string
		if _, ok := money.Scale(cur); ok {
			curP = &cur
		}
		if _, err := tx.Exec(ctx, `INSERT INTO bank_statements (id, profile_id, account_id, import_batch_id, statement_ref, period_start, period_end,
			opening_balance, closing_balance, currency, file_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			id, in.ProfileID, in.AccountID, batchID, st.Ref, ps, pe, numericOrNil(st.OpeningBalance), numericOrNil(st.ClosingBalance), curP, sum[:]); err != nil {
			return Batch{}, fmt.Errorf("insert statement: %w", err)
		}
	}
	// Immutable raw records (COPY: statements can have tens of thousands of rows).
	raw := make([][]any, len(rows))
	for i, r := range rows {
		amount := r.rec.Amount
		if r.rec.Direction == "debit" {
			amount = "-" + amount
		}
		posting, _ := parseISODate(r.rec.PostingDate)
		var valueDate *time.Time
		if t, ok := parseISODate(r.rec.ValueDate); ok {
			valueDate = &t
		}
		var oCur *string
		if isoCurrency.MatchString(strings.ToUpper(r.rec.OriginalCurrency)) && r.rec.OriginalAmount != "" {
			c := strings.ToUpper(r.rec.OriginalCurrency)
			oCur = &c
		}
		warnings := r.rec.Warnings
		raw[i] = []any{r.id, in.ProfileID, batchID, stmtID, in.AccountID, r.rec.RowNumber, r.rec.Description, posting, valueDate,
			numeric(amount), r.rec.Direction, r.rec.Currency, nilIfInvalid(numeric(r.rec.OriginalAmount), oCur != nil), oCur,
			nilIfInvalid(numeric(r.rec.ExchangeRate), true), nilIfInvalid(numeric(r.rec.RunningBalance), true),
			r.rec.BankReference, firstNonEmpty(r.rec.StatementRef, stRef(st)), r.rec.AccountRef, r.rec.Counterparty,
			r.rec.Raw, r.fp, sum[:], in.Importer, in.ImporterVersion, warnings}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"imported_raw_records"}, []string{"id", "profile_id", "import_batch_id", "bank_statement_id",
		"account_id", "row_number", "source_description", "posting_date", "value_date", "amount", "direction", "currency", "original_amount",
		"original_currency", "exchange_rate", "running_balance", "bank_reference", "statement_ref", "source_account", "counterparty",
		"raw", "dedupe_fingerprint", "file_sha256", "importer_id", "importer_version", "warnings"}, pgx.CopyFromRows(raw)); err != nil {
		return Batch{}, fmt.Errorf("copy raw records: %w", err)
	}
	if err := classify(ctx, tx, in.ProfileID, acc, batchID, in.ReprocessedFrom, rows, start, end); err != nil {
		return Batch{}, err
	}
	stats := Stats{Encoding: in.Encoding, Records: len(rows), ParseErrors: capIssues(parseErrs), Warnings: capIssues(in.Result.Warnings)}
	if err := summarize(&stats, rows, st, acc); err != nil {
		return Batch{}, err
	}
	if in.ReprocessedFrom != nil {
		if stats.Orphaned, err = orphaned(ctx, tx, in.ProfileID, *in.ReprocessedFrom, rows); err != nil {
			return Batch{}, err
		}
	}
	results := make([][]any, len(rows))
	for i, r := range rows {
		details := map[string]any{"selected": r.selected, "issues": nonNil(r.issues)}
		if r.suggested != nil {
			details["suggestedCategoryId"] = r.suggested
		}
		if r.prevRec != nil {
			details["previousImportRecordId"] = r.prevRec
		}
		var score pgtype.Numeric
		if r.score != nil {
			score = numeric(fmt.Sprintf("%.4f", *r.score))
		}
		results[i] = []any{uuid.New(), in.ProfileID, batchID, r.id, r.matchTx, r.outcome, nilIfInvalid(score, r.score != nil), details}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"import_reconciliation_results"}, []string{"id", "profile_id", "import_batch_id",
		"raw_record_id", "transaction_id", "outcome", "match_score", "details"}, pgx.CopyFromRows(results)); err != nil {
		return Batch{}, fmt.Errorf("copy reconciliation results: %w", err)
	}
	b, err := getBatch(ctx, tx, in.ProfileID, batchID, true)
	if err != nil {
		return b, err
	}
	b.Stats = stats
	if err := saveBatch(ctx, tx, &b, "import.stage"); err != nil {
		return b, err
	}
	return b, tx.Commit(ctx)
}

// mergeStatements folds the statements of one file (one account) into one period: first opening
// balance, last closing balance, widest period.
func mergeStatements(sts []Statement) *Statement {
	if len(sts) == 0 {
		return nil
	}
	m := &Statement{}
	var refs []string
	for _, s := range sts {
		if s.Ref != "" {
			refs = append(refs, s.Ref)
		}
		if _, ok := parseISODate(s.PeriodStart); ok && (m.PeriodStart == "" || s.PeriodStart < m.PeriodStart) {
			m.PeriodStart = s.PeriodStart
		}
		if _, ok := parseISODate(s.PeriodEnd); ok && s.PeriodEnd > m.PeriodEnd {
			m.PeriodEnd = s.PeriodEnd
		}
		if m.OpeningBalance == "" {
			m.OpeningBalance = s.OpeningBalance
		}
		if s.ClosingBalance != "" {
			m.ClosingBalance = s.ClosingBalance
		}
		if m.Currency == "" {
			m.Currency = s.Currency
		}
		m.AccountRef = firstNonEmpty(m.AccountRef, s.AccountRef)
	}
	m.Ref = strings.Join(refs, ",")
	if len(m.Ref) > 500 {
		m.Ref = m.Ref[:500]
	}
	return m
}

func stRef(st *Statement) string {
	if st == nil {
		return ""
	}
	return st.Ref
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func nilIfInvalid(n pgtype.Numeric, ok bool) any {
	if !ok || !n.Valid {
		return nil
	}
	return n
}

func numericOrNil(s string) any { return nilIfInvalid(numeric(s), true) }

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func capIssues(in []Issue) []Issue {
	if len(in) > 200 {
		return append(in[:200:200], Issue{Code: "truncated", Message: fmt.Sprintf("%d more issues not shown", len(in)-200)})
	}
	if in == nil {
		return []Issue{}
	}
	return in
}

// classify sets outcome / match / suggestion / default selection for every staged row.
//
//   - fingerprint already linked to a live transaction on this account: duplicate (or, when that
//     record belongs to the batch being reprocessed, matched: the existing transaction is relinked
//     on commit so user classifications survive);
//   - otherwise a live, not-yet-imported transaction with the same signed amount within ±3 days:
//     matched (manual entry gets linked to its bank evidence instead of duplicated);
//   - an already-imported transaction with the same amount within ±1 day but another fingerprint:
//     conflict (probable duplicate across formats; user decides);
//   - else new.
func classify(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, acc account, batchID uuid.UUID, reprocessFrom *uuid.UUID,
	rows []stagedRow, start, end string) error {
	fps := make([]string, len(rows))
	for i, r := range rows {
		fps[i] = r.fp
	}
	type hit struct {
		tx, rec, batch uuid.UUID
	}
	known := map[string]hit{}
	q, err := tx.Query(ctx, `SELECT r.dedupe_fingerprint, t.id, r.id, r.import_batch_id FROM imported_raw_records r
		JOIN transactions t ON t.import_record_id = r.id AND t.deleted_at IS NULL AND t.profile_id = r.profile_id
		WHERE r.profile_id = $1 AND r.account_id = $2 AND r.dedupe_fingerprint = ANY($3) AND r.import_batch_id <> $4`,
		profileID, acc.ID, fps, batchID)
	if err != nil {
		return fmt.Errorf("dedupe lookup: %w", err)
	}
	for q.Next() {
		var fp string
		var h hit
		if err := q.Scan(&fp, &h.tx, &h.rec, &h.batch); err != nil {
			q.Close()
			return err
		}
		known[fp] = h
	}
	q.Close()
	if err := q.Err(); err != nil {
		return err
	}
	// Fuzzy candidates in the coverage window ±3 days.
	type cand struct {
		id       uuid.UUID
		date     time.Time
		amount   string
		imported bool
		claimed  bool
	}
	var cands []*cand
	q, err = tx.Query(ctx, `SELECT t.id, t.booking_date, sum(p.amount)::text, t.import_record_id IS NOT NULL
		FROM transactions t JOIN postings p ON p.transaction_id = t.id AND p.deleted_at IS NULL AND p.account_id = $2
		WHERE t.profile_id = $1 AND t.deleted_at IS NULL AND t.booking_date BETWEEN $3::date - 3 AND $4::date + 3
		GROUP BY t.id`, profileID, acc.ID, start, end)
	if err != nil {
		return fmt.Errorf("match candidates: %w", err)
	}
	for q.Next() {
		c := &cand{}
		if err := q.Scan(&c.id, &c.date, &c.amount, &c.imported); err != nil {
			q.Close()
			return err
		}
		c.amount = trimZeros(c.amount)
		cands = append(cands, c)
	}
	q.Close()
	if err := q.Err(); err != nil {
		return err
	}
	for _, h := range known { // exact hits are not fuzzy candidates for other rows
		for _, c := range cands {
			if c.id == h.tx {
				c.claimed = true
			}
		}
	}
	sugg, err := loadSuggestions(ctx, tx, profileID)
	if err != nil {
		return err
	}
	for i := range rows {
		r := &rows[i]
		if r.signed == nil {
			r.outcome = "error"
			continue
		}
		if h, ok := known[r.fp]; ok {
			t := h.tx
			r.matchTx, r.score = &t, ptr(1.0)
			if reprocessFrom != nil && h.batch == *reprocessFrom {
				rec := h.rec
				r.outcome, r.selected, r.prevRec = "matched", true, &rec
			} else {
				r.outcome = "duplicate"
				r.issues = append(r.issues, "already imported")
			}
			continue
		}
		r.outcome, r.selected = "new", true
		date, _ := parseISODate(r.rec.PostingDate)
		amt := trimZeros(r.signed.Amount())
		var best *cand
		bestDiff := 99
		for _, c := range cands {
			if c.claimed || c.amount != amt {
				continue
			}
			diff := int(abs(c.date.Sub(date).Hours()) / 24)
			if diff > 3 || (c.imported && diff > 1) {
				continue
			}
			if diff < bestDiff {
				best, bestDiff = c, diff
			}
		}
		if best != nil {
			best.claimed = true
			id := best.id
			r.matchTx, r.score = &id, ptr(1-float64(bestDiff)*0.1)
			if best.imported {
				r.outcome, r.selected = "conflict", false
				r.issues = append(r.issues, "an imported transaction with the same amount and date already exists (different reference/description)")
			} else {
				r.outcome = "matched"
			}
			continue
		}
		r.suggested = sugg.suggest(r.rec.Description)
	}
	return nil
}

func ptr[T any](v T) *T { return &v }

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// suggestions: categories learned from the user's own past classifications of identical source
// descriptions (merchant-specific memory, Feature 125) and merchants' default categories.
type suggestions struct {
	byDesc    map[string]uuid.UUID
	merchants []struct {
		name string
		cat  uuid.UUID
	}
}

func loadSuggestions(ctx context.Context, tx pgx.Tx, profileID uuid.UUID) (*suggestions, error) {
	s := &suggestions{byDesc: map[string]uuid.UUID{}}
	rows, err := tx.Query(ctx, `SELECT r.source_description, min(s.category_id::text)::uuid
		FROM imported_raw_records r
		JOIN transactions t ON t.import_record_id = r.id AND t.deleted_at IS NULL
		JOIN transaction_splits s ON s.transaction_id = t.id AND s.deleted_at IS NULL
		JOIN categories c ON c.id = s.category_id AND c.deleted_at IS NULL
		WHERE r.profile_id = $1 AND t.categorization_source IN ('user','mcp','import')
		GROUP BY t.id, r.source_description, t.booking_date HAVING count(*) = 1
		ORDER BY t.booking_date DESC LIMIT 5000`, profileID)
	if err != nil {
		return nil, fmt.Errorf("suggestions: %w", err)
	}
	for rows.Next() {
		var desc string
		var cat uuid.UUID
		if err := rows.Scan(&desc, &cat); err != nil {
			rows.Close()
			return nil, err
		}
		if k := canonicalDesc(desc); k != "" {
			if _, seen := s.byDesc[k]; !seen { // most recent wins
				s.byDesc[k] = cat
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = tx.Query(ctx, `SELECT m.normalized_name, m.default_category_id FROM merchants m
		JOIN categories c ON c.id = m.default_category_id AND c.deleted_at IS NULL
		WHERE m.profile_id = $1 AND m.deleted_at IS NULL AND length(m.normalized_name) >= 3`, profileID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var m struct {
			name string
			cat  uuid.UUID
		}
		if err := rows.Scan(&m.name, &m.cat); err != nil {
			rows.Close()
			return nil, err
		}
		m.name = canonicalDesc(m.name)
		if m.name != "" {
			s.merchants = append(s.merchants, m)
		}
	}
	rows.Close()
	// Longest merchant name first so "shell oil" beats "shell".
	sort.Slice(s.merchants, func(i, j int) bool { return len(s.merchants[i].name) > len(s.merchants[j].name) })
	return s, rows.Err()
}

func (s *suggestions) suggest(desc string) *uuid.UUID {
	k := canonicalDesc(desc)
	if k == "" {
		return nil
	}
	if c, ok := s.byDesc[k]; ok {
		return &c
	}
	for _, m := range s.merchants {
		if strings.Contains(k, m.name) {
			c := m.cat
			return &c
		}
	}
	return nil
}

// summarize computes outcome counts, income/expense totals and statement reconciliation.
func summarize(st *Stats, rows []stagedRow, stmt *Statement, acc account) error {
	income, _ := money.Zero(acc.Currency)
	expenses, _ := money.Zero(acc.Currency)
	total, _ := money.Zero(acc.Currency)
	var prevRunning *money.Money
	var firstRunning *money.Money
	var firstSigned *money.Money
	for _, r := range rows {
		switch r.outcome {
		case "new":
			st.New++
		case "duplicate":
			st.Duplicates++
		case "matched":
			st.Matched++
		case "conflict":
			st.Conflicts++
		case "error":
			st.Errors++
		}
		if r.signed == nil || r.signed.Currency() != acc.Currency {
			continue
		}
		var err error
		if total, err = total.Add(*r.signed); err != nil {
			return err
		}
		if r.signed.Sign() > 0 {
			income, _ = income.Add(*r.signed)
		} else {
			expenses, _ = expenses.Add(r.signed.Abs())
		}
		if r.rec.RunningBalance != "" {
			rb, err := money.Parse(strings.TrimPrefix(r.rec.RunningBalance, "+"), acc.Currency)
			if err == nil {
				if prevRunning != nil {
					exp, _ := prevRunning.Add(*r.signed)
					if c, _ := exp.Cmp(rb); c != 0 {
						st.Recon.RunningBalanceMismatches++
					}
				} else {
					firstRunning, firstSigned = &rb, r.signed
				}
				prevRunning = &rb
			}
		}
	}
	st.Income, st.Expenses = &income, &expenses
	parse := func(s string) *money.Money {
		if s == "" {
			return nil
		}
		m, err := money.Parse(strings.TrimPrefix(s, "+"), acc.Currency)
		if err != nil {
			return nil
		}
		return &m
	}
	if stmt != nil && (stmt.Currency == "" || strings.EqualFold(stmt.Currency, acc.Currency)) {
		st.Recon.OpeningBalance, st.Recon.ClosingBalance = parse(stmt.OpeningBalance), parse(stmt.ClosingBalance)
		if st.Recon.OpeningBalance != nil {
			st.Recon.OpeningSource = "statement"
		}
	}
	// Opening balance reconstruction from the first running balance (Feature 129).
	if st.Recon.OpeningBalance == nil && firstRunning != nil {
		ob, _ := firstRunning.Sub(*firstSigned)
		st.Recon.OpeningBalance, st.Recon.OpeningSource = &ob, "running_balance"
		if st.Recon.ClosingBalance == nil && prevRunning != nil {
			st.Recon.ClosingBalance = prevRunning
		}
	}
	if st.Recon.OpeningBalance != nil {
		cc, _ := st.Recon.OpeningBalance.Add(total)
		st.Recon.ComputedClosing = &cc
	}
	st.Recon.HasBalances = st.Recon.OpeningBalance != nil && st.Recon.ClosingBalance != nil
	st.Recon.OK = st.Recon.RunningBalanceMismatches == 0
	if st.Recon.HasBalances {
		c, _ := st.Recon.ComputedClosing.Cmp(*st.Recon.ClosingBalance)
		st.Recon.OK = st.Recon.OK && c == 0
	}
	return nil
}

// orphaned lists transactions of the reprocessed batch that the new parse did not match.
func orphaned(ctx context.Context, tx pgx.Tx, profileID, oldBatch uuid.UUID, rows []stagedRow) ([]uuid.UUID, error) {
	matched := map[uuid.UUID]bool{}
	for _, r := range rows {
		if r.prevRec != nil && r.matchTx != nil {
			matched[*r.matchTx] = true
		}
	}
	q, err := tx.Query(ctx, `SELECT t.id FROM transactions t JOIN imported_raw_records r ON r.id = t.import_record_id
		WHERE r.import_batch_id = $1 AND t.profile_id = $2 AND t.deleted_at IS NULL ORDER BY t.booking_date, t.id`, oldBatch, profileID)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(q, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	var out []uuid.UUID
	for _, id := range ids {
		if !matched[id] {
			out = append(out, id)
		}
	}
	return out, nil
}
