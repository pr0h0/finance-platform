package imports

import (
	"testing"

	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/transactions"
)

// An imported expense and the matching income on another own account become one transfer; the batch
// cannot be rolled back while linked; undo on both halves restores the imported evidence.
func TestLinkImportedTransfer(t *testing.T) {
	e := setup(t)
	acc2 := uuid.New()
	exec(t, e.pool, `INSERT INTO accounts (id, profile_id, name, account_type, currency) VALUES ($1,$2,'Card','checking','BAM')`, acc2, e.profile)
	b := e.stage(t, "synthetic.camt053.xml")
	if _, err := Commit(e.ctx, e.pool, e.profile, e.user, b.ID, CommitInput{}); err != nil {
		t.Fatal(err)
	}
	var outID uuid.UUID
	var date, amount string
	if err := e.pool.QueryRow(e.ctx, `SELECT t.id, t.booking_date::text, (-p.amount)::numeric(30,2)::text FROM transactions t
		JOIN postings p ON p.transaction_id = t.id WHERE t.profile_id = $1 AND t.kind = 'expense' AND t.import_record_id IS NOT NULL LIMIT 1`,
		e.profile).Scan(&outID, &date, &amount); err != nil {
		t.Fatal(err)
	}
	inID := uuid.New()
	exec(t, e.pool, `INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,'income',$3,'from checking')`, inID, e.profile, date)
	exec(t, e.pool, `INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,$4,'BAM')`, e.profile, inID, acc2, amount)
	exec(t, e.pool, `INSERT INTO transaction_splits (profile_id, transaction_id, amount, currency) VALUES ($1,$2,$3,'BAM')`, e.profile, inID, amount)
	balance := func(acc uuid.UUID) string {
		var s string
		_ = e.pool.QueryRow(e.ctx, `SELECT coalesce(sum(p.amount),0)::numeric(30,2)::text FROM postings p JOIN transactions t ON t.id = p.transaction_id
			WHERE p.account_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL`, acc).Scan(&s)
		return s
	}
	b1, b2 := balance(e.acc), balance(acc2)

	tx, _ := e.pool.Begin(e.ctx)
	out, _ := ledger.Get(e.ctx, tx, e.profile, outID, true)
	in, _ := ledger.Get(e.ctx, tx, e.profile, inID, true)
	res, err := transactions.LinkTransfer(e.ctx, tx, in, out) // either order
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(e.ctx); err != nil {
		t.Fatal(err)
	}
	if res.ID != outID || res.Kind != "transfer" || len(res.Postings) != 2 || len(res.Splits) != 0 || *res.RelatedTransactionID != inID {
		t.Fatalf("linked %+v", res)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE id = $1 AND deleted_at IS NOT NULL`, inID); n != 1 {
		t.Fatal("the income half must be tombstoned")
	}
	if balance(e.acc) != b1 || balance(acc2) != b2 {
		t.Fatalf("balances changed: %s %s, want %s %s", balance(e.acc), balance(acc2), b1, b2)
	}
	if _, err := Rollback(e.ctx, e.pool, e.profile, b.ID); err == nil {
		t.Fatal("rollback must refuse while a transaction of the batch is linked")
	}

	// unlink: undo both halves
	tx, _ = e.pool.Begin(e.ctx)
	for _, id := range []uuid.UUID{outID, inID} {
		cur, _ := ledger.Get(e.ctx, tx, e.profile, id, true)
		if _, err := transactions.Undo(e.ctx, tx, cur); err != nil {
			t.Fatalf("undo %s: %v", id, err)
		}
	}
	if err := tx.Commit(e.ctx); err != nil {
		t.Fatal(err)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM transactions WHERE id = ANY($1) AND deleted_at IS NULL AND kind IN ('expense','income')`, []uuid.UUID{outID, inID}); n != 2 {
		t.Fatal("undo must restore the expense and the income")
	}
	if balance(e.acc) != b1 || balance(acc2) != b2 {
		t.Fatal("balances changed after undo")
	}
	if _, err := Rollback(e.ctx, e.pool, e.profile, b.ID); err != nil {
		t.Fatalf("rollback after unlinking: %v", err)
	}

}
