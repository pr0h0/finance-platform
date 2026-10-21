package imports

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

type env struct {
	pool               *pgxpool.Pool
	ctx                context.Context
	user, profile, acc uuid.UUID
	cat                uuid.UUID
}

func setup(t *testing.T) *env {
	t.Helper()
	pool := testdb.New(t)
	u, p := testdb.SeedUserProfile(t, pool)
	e := &env{pool: pool, user: u, profile: p, acc: uuid.New(), cat: uuid.New()}
	e.ctx = authz.WithPrincipal(context.Background(), authz.Principal{UserID: u, ActorType: authz.ActorUser})
	exec(t, pool, `INSERT INTO accounts (id, profile_id, name, account_type, currency) VALUES ($1,$2,'Checking','checking','BAM')`, e.acc, p)
	exec(t, pool, `INSERT INTO categories (id, profile_id, name) VALUES ($1,$2,'Groceries')`, e.cat, p)
	return e
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func count(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (e *env) manualTx(t *testing.T, date, amount string) uuid.UUID {
	id := uuid.New()
	kind := "expense"
	if amount[0] != '-' {
		kind = "income"
	}
	exec(t, e.pool, `INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,$3,$4,'manual')`, id, e.profile, kind, date)
	exec(t, e.pool, `INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,$4,'BAM')`, e.profile, id, e.acc, amount)
	return id
}

func (e *env) stage(t *testing.T, file string) Batch {
	t.Helper()
	b, err := ParseAndStage(e.ctx, e.pool, ParseRequest{ProfileID: e.profile, UserID: e.user, AccountID: e.acc, FileName: file, Bytes: fixture(t, file)}, 25<<20)
	if err != nil {
		t.Fatalf("stage %s: %v", file, err)
	}
	return b
}

func TestImportLifecycle(t *testing.T) {
	e := setup(t)
	unrelated := e.manualTx(t, "2025-03-01", "-20.00")

	// Stage + preview.
	b := e.stage(t, "synthetic.camt053.xml")
	if b.Status != "staged" || b.Stats.New != 2 || !b.Stats.Recon.OK || !b.Stats.Recon.HasBalances || *b.CoverageStart != "2025-01-01" {
		t.Fatalf("staged batch %+v", b)
	}
	p, err := GetPreview(e.ctx, e.pool, e.profile, b.ID, httpx.Page{Limit: 1})
	if err != nil || len(p.Rows) != 1 || p.NextCursor == "" || p.Totals.Expenses.Amount() != "150.00" || p.Totals.Income.Amount() != "1500.00" {
		t.Fatalf("preview %+v %v", p, err)
	}
	first := p.Rows[0].RawRecordID

	// Commit atomically with a user category and opening-balance reconstruction (case 18).
	b, err = Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{CreateOpeningBalance: true,
		Rows: []CommitRow{{RawRecordID: first, CategoryID: OptUUID{Set: true, Value: &e.cat}}}})
	if err != nil {
		t.Fatal(err)
	}
	if b.Status != "committed" || b.Stats.Committed != 2 || b.Stats.OpeningTxID == nil || b.Stats.LedgerMatches == nil || !*b.Stats.LedgerMatches {
		t.Fatalf("commit stats %+v", b.Stats)
	}
	var bal string
	_ = e.pool.QueryRow(e.ctx, `SELECT sum(amount)::numeric(30,2)::text FROM postings p JOIN transactions t ON t.id=p.transaction_id
		WHERE p.account_id=$1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.booking_date <= '2025-01-31'`, e.acc).Scan(&bal)
	if bal != "2350.00" {
		t.Fatalf("ledger after opening balance = %s, want 2350.00 (statement closing)", bal)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM sync_changes WHERE profile_id=$1 AND entity_type='transactions'`, e.profile); n != 3 {
		t.Fatalf("sync changes for transactions = %d", n)
	}
	if _, err := Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{}); err == nil {
		t.Fatal("double commit must fail")
	}

	// Case 15: source records are immutable and preserved.
	if _, err := e.pool.Exec(e.ctx, `UPDATE imported_raw_records SET source_description='x' WHERE import_batch_id=$1`, b.ID); err == nil {
		t.Fatal("raw records must be immutable")
	}
	var src []byte
	_ = e.pool.QueryRow(e.ctx, `SELECT content FROM import_batch_sources WHERE import_batch_id=$1`, b.ID).Scan(&src)
	if !bytes.Equal(src, fixture(t, "synthetic.camt053.xml")) {
		t.Fatal("original file not preserved")
	}

	// Case 14: the same statement again is recognized as duplicates and creates nothing.
	dup := e.stage(t, "synthetic.camt053.xml")
	if dup.Stats.Duplicates != 2 || dup.Stats.New != 0 {
		t.Fatalf("duplicate stats %+v", dup.Stats)
	}
	dup, err = Commit(e.ctx, e.pool, e.profile, e.user, dup.ID, CommitInput{})
	if err != nil || dup.Stats.Committed != 0 || dup.Stats.Skipped != 2 {
		t.Fatalf("dup commit %+v %v", dup.Stats, err)
	}

	// Case 16: user re-categorizes the salary; reprocessing keeps it.
	var salaryTx uuid.UUID
	_ = e.pool.QueryRow(e.ctx, `SELECT t.id FROM transactions t JOIN postings p ON p.transaction_id=t.id WHERE p.amount=1500 AND t.deleted_at IS NULL`).Scan(&salaryTx)
	income := uuid.New()
	exec(t, e.pool, `INSERT INTO categories (id, profile_id, name, kind) VALUES ($1,$2,'Salary','income')`, income, e.profile)
	exec(t, e.pool, `UPDATE transaction_splits SET category_id=$1 WHERE transaction_id=$2`, income, salaryTx)
	exec(t, e.pool, `UPDATE transactions SET notes='my note', categorization_source='user' WHERE id=$1`, salaryTx)
	rp, err := Reprocess(e.ctx, e.pool, e.profile, e.user, b.ID, 25<<20)
	if err != nil {
		t.Fatal(err)
	}
	if rp.Stats.Matched != 2 || rp.Stats.New != 0 || len(rp.Stats.Orphaned) != 0 || *rp.ReprocessedFrom != b.ID {
		t.Fatalf("reprocess stats %+v", rp.Stats)
	}
	if _, err := Commit(e.ctx, e.pool, e.profile, e.user, rp.ID, CommitInput{}); err != nil {
		t.Fatal(err)
	}
	var cat uuid.UUID
	var notes string
	var linkedBatch uuid.UUID
	_ = e.pool.QueryRow(e.ctx, `SELECT s.category_id, t.notes, r.import_batch_id FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id
		JOIN imported_raw_records r ON r.id=t.import_record_id WHERE t.id=$1`, salaryTx).Scan(&cat, &notes, &linkedBatch)
	if cat != income || notes != "my note" || linkedBatch != rp.ID {
		t.Fatalf("after reprocess: cat=%s notes=%q batch=%s", cat, notes, linkedBatch)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE profile_id=$1 AND deleted_at IS NULL`, e.profile); n != 4 {
		t.Fatalf("reprocess must not create transactions, have %d", n)
	}

	// Case 17: rolling back the reprocess restores links; rolling back the original removes only its rows.
	if _, err := Rollback(e.ctx, e.pool, e.profile, rp.ID); err != nil {
		t.Fatal(err)
	}
	_ = e.pool.QueryRow(e.ctx, `SELECT r.import_batch_id FROM transactions t JOIN imported_raw_records r ON r.id=t.import_record_id WHERE t.id=$1`, salaryTx).Scan(&linkedBatch)
	if linkedBatch != b.ID {
		t.Fatal("rollback of reprocess must relink to the original evidence")
	}
	rb, err := Rollback(e.ctx, e.pool, e.profile, b.ID)
	if err != nil || rb.Stats.RolledBack != 3 {
		t.Fatalf("rollback %+v %v", rb.Stats, err)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE profile_id=$1 AND deleted_at IS NULL`, e.profile); n != 1 {
		t.Fatalf("after rollback %d live transactions, want only the unrelated one", n)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE id=$1 AND deleted_at IS NULL`, unrelated); n != 1 {
		t.Fatal("unrelated transaction was touched")
	}
	if n := count(t, e.pool, `SELECT count(*) FROM sync_changes WHERE profile_id=$1 AND op='delete' AND entity_type='transactions'`, e.profile); n != 3 {
		t.Fatalf("rollback must publish %d tombstones", n)
	}
	if _, err := Rollback(e.ctx, e.pool, e.profile, b.ID); err == nil {
		t.Fatal("double rollback must fail")
	}
}

func TestMatchManualAndCoverageAndInbox(t *testing.T) {
	e := setup(t)
	manual := e.manualTx(t, "2025-01-04", "-150.00") // entered by hand a day late
	b := e.stage(t, "synthetic.mt940")
	if b.Stats.Matched != 1 || b.Stats.New != 2 || !b.Stats.Recon.OK {
		t.Fatalf("stats %+v", b.Stats)
	}
	b, err := Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{})
	if err != nil {
		t.Fatal(err)
	}
	if b.Stats.Linked != 1 || b.Stats.Committed != 2 {
		t.Fatalf("commit stats %+v", b.Stats)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE id=$1 AND import_record_id IS NOT NULL`, manual); n != 1 {
		t.Fatal("manual transaction should be linked to its bank record, not duplicated")
	}
	// No opening balance booked: ledger (-150+1500-10) differs from closing 2340 -> conflicting.
	if b.Stats.LedgerMatches == nil || *b.Stats.LedgerMatches {
		t.Fatalf("ledger check %+v", b.Stats)
	}
	cov, err := Coverage(e.ctx, e.pool, e.profile, nil, mustDate("2024-12-01"), mustDate("2025-02-28"))
	if err != nil || len(cov) != 1 {
		t.Fatal(err)
	}
	months := map[string]string{}
	for _, m := range cov[0].Months {
		months[m.Month] = m.Status
	}
	if months["2024-12"] != CovConflicting || months["2025-01"] != CovConflicting || months["2025-02"] != CovMissing {
		t.Fatalf("months %+v", months)
	}
	// Same CSV-style file (no balances) on a fresh account: unverified + partial month.
	items, _, err := Uncategorized(e.ctx, e.pool, e.profile, InboxFilter{Limit: 10})
	if err != nil || len(items) != 3 {
		t.Fatalf("inbox %+v %v", items, err)
	}
	if items[0].BookingDate != "2025-01-10" || items[0].Amount.Amount != "1500.00" {
		t.Fatalf("inbox order/amount %+v", items[0])
	}
}

func TestReconciliationGate(t *testing.T) {
	e := setup(t)
	bad := bytes.Replace(fixture(t, "synthetic.camt053.xml"), []byte(`<Amt Ccy="BAM">2350.00</Amt>`), []byte(`<Amt Ccy="BAM">2351.00</Amt>`), 1)
	b, err := ParseAndStage(e.ctx, e.pool, ParseRequest{ProfileID: e.profile, UserID: e.user, AccountID: e.acc, FileName: "bad.xml", Bytes: bad}, 25<<20)
	if err != nil {
		t.Fatal(err)
	}
	if b.Stats.Recon.OK || b.Stats.Recon.ComputedClosing.Amount() != "2350.00" {
		t.Fatalf("recon %+v", b.Stats.Recon)
	}
	if _, err := Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{}); err == nil {
		t.Fatal("unreconciled statement must not commit without allowUnreconciled")
	}
	if _, err := Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{AllowUnreconciled: true}); err != nil {
		t.Fatal(err)
	}
	// Foreign-currency rows on a single-currency account cannot be committed.
	eur := bytes.ReplaceAll(fixture(t, "synthetic.camt053.xml"), []byte(`Ccy="BAM">150.00`), []byte(`Ccy="EUR">150.00`))
	b, err = ParseAndStage(e.ctx, e.pool, ParseRequest{ProfileID: e.profile, UserID: e.user, AccountID: e.acc, FileName: "eur.xml", Bytes: eur}, 25<<20)
	if err != nil || b.Stats.Errors != 1 {
		t.Fatalf("currency mismatch %+v %v", b.Stats, err)
	}
}

func mustDate(s string) time.Time { t, _ := time.Parse(time.DateOnly, s); return t }

func TestHTTP(t *testing.T) {
	e := setup(t)
	deps := &app.Deps{Config: &config.Config{MaxUploadBytes: 1 << 20, MaxBodyBytes: 1 << 20}, DB: e.pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	r.Use(httpx.MaxBody(1<<20), func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(authz.WithPrincipal(req.Context(), authz.Principal{UserID: e.user, ActorType: authz.ActorUser})))
		})
	})
	Register(r, deps)
	do := func(method, path string, body io.Reader, ctype string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, body)
		req.Header.Set(authz.ProfileHeader, e.profile.String())
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	// Registry lists the blocked Raiffeisen placeholder.
	w := do("GET", "/importers", nil, "")
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"raiffeisen-bih"`)) || !bytes.Contains(w.Body.Bytes(), []byte(`"blocked_external"`)) {
		t.Fatalf("importers %d %s", w.Code, w.Body)
	}
	// Template CRUD + multipart CSV upload using it.
	w = do("POST", "/import-templates", bytes.NewReader([]byte(`{"importerId":"generic-csv","name":"Synthetic bank","format":"csv","definition":`+synthTemplate+`}`)), "application/json")
	if w.Code != 201 {
		t.Fatalf("create template %d %s", w.Code, w.Body)
	}
	var tmpl TemplateRow
	_ = json.Unmarshal(w.Body.Bytes(), &tmpl)
	if w = do("POST", "/import-templates", bytes.NewReader([]byte(`{"importerId":"generic-csv","name":"x","format":"csv","definition":{"columns":{}}}`)), "application/json"); w.Code != 422 {
		t.Fatalf("invalid template %d", w.Code)
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("accountId", e.acc.String())
	_ = mw.WriteField("templateId", tmpl.ID.String())
	fw, _ := mw.CreateFormFile("file", "stmt.csv")
	_, _ = fw.Write(fixture(t, "synthetic-cp1250.csv"))
	_ = mw.Close()
	w = do("POST", "/imports", &buf, mw.FormDataContentType())
	if w.Code != 201 {
		t.Fatalf("upload %d %s", w.Code, w.Body)
	}
	var b Batch
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	if b.Stats.New != 2 || b.ImporterID != "generic-csv" || b.Stats.Encoding != "windows-1250" {
		t.Fatalf("batch %+v", b)
	}
	w = do("GET", "/imports/"+b.ID.String()+"/preview", nil, "")
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("Kupovina ŠIŠ market ž")) {
		t.Fatalf("preview %d %s", w.Code, w.Body)
	}
	w = do("POST", "/imports/"+b.ID.String()+"/commit", bytes.NewReader([]byte(`{}`)), "application/json")
	if w.Code != 200 {
		t.Fatalf("commit %d %s", w.Code, w.Body)
	}
	if w = do("GET", "/imports/inbox", nil, ""); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"1500.00"`)) {
		t.Fatalf("inbox %d %s", w.Code, w.Body)
	}
	if w = do("GET", "/imports/coverage?from=2025-01-01&to=2025-01-31", nil, ""); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"unverified"`)) {
		t.Fatalf("coverage %d %s", w.Code, w.Body)
	}
	// Client-parsed (web) path: normalized result + original bytes + matching fingerprint.
	src := []byte("synthetic original bytes")
	sum := sha256.Sum256(src)
	body, _ := json.Marshal(map[string]any{"importerId": "generic-csv", "importerVersion": "1.0.0", "accountId": e.acc, "fileName": "web.csv",
		"fileSha256": hex.EncodeToString(sum[:]), "source": base64.StdEncoding.EncodeToString(src),
		"result": Result{Records: []Record{{RowNumber: 1, PostingDate: "2025-02-01", Description: "Web row", Direction: "debit", Amount: "12.34", Currency: "BAM", Raw: map[string]string{"a": "b"}}}}})
	if w = do("POST", "/imports", bytes.NewReader(body), "application/json"); w.Code != 201 {
		t.Fatalf("client stage %d %s", w.Code, w.Body)
	}
	body, _ = json.Marshal(map[string]any{"importerId": "generic-csv", "importerVersion": "1.0.0", "accountId": e.acc, "fileName": "web.csv",
		"fileSha256": "00", "source": base64.StdEncoding.EncodeToString(src), "result": Result{}})
	if w = do("POST", "/imports", bytes.NewReader(body), "application/json"); w.Code != 422 {
		t.Fatalf("sha mismatch must be rejected, got %d", w.Code)
	}
	body, _ = json.Marshal(map[string]any{"importerId": "raiffeisen-bih", "importerVersion": "0.0.0", "accountId": e.acc, "fileName": "r.csv",
		"fileSha256": hex.EncodeToString(sum[:]), "source": base64.StdEncoding.EncodeToString(src), "result": Result{}})
	if w = do("POST", "/imports", bytes.NewReader(body), "application/json"); w.Code != 422 || !bytes.Contains(w.Body.Bytes(), []byte("blocked_external")) {
		t.Fatalf("blocked importer must be refused, got %d %s", w.Code, w.Body)
	}
	// Other profile's batch is invisible.
	_, other := testdb.SeedUserProfile(t, e.pool)
	req := httptest.NewRequest("GET", "/imports/"+b.ID.String(), nil)
	req.Header.Set(authz.ProfileHeader, other.String())
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("foreign profile %d", rec.Code)
	}
}
