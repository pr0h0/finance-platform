package imports

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// A connected web client stages locally, uploads the batch with its own ids, then reports commit
// and rollback through sync; the batch can only move forward and cannot be created or deleted by sync.
func TestClientIDsAndSyncStatus(t *testing.T) {
	e := setup(t)
	batchID, recID := uuid.New(), uuid.New()
	in := StageInput{ProfileID: e.profile, UserID: e.user, AccountID: e.acc, Importer: "generic-csv", ImporterVersion: "1.0.0",
		FileName: "web.csv", Source: []byte("bytes"), BatchID: &batchID,
		Result: Result{Records: []Record{{ID: &recID, RowNumber: 1, PostingDate: "2025-03-01", Description: "Row", Direction: "debit", Amount: "5.00", Currency: "BAM"}}}}
	b, err := Stage(e.ctx, e.pool, in)
	if err != nil || b.ID != batchID {
		t.Fatalf("stage %v %v", b.ID, err)
	}
	if n := count(t, e.pool, `SELECT count(*) FROM imported_raw_records WHERE id = $1 AND import_batch_id = $2`, recID, batchID); n != 1 {
		t.Fatalf("raw record id not kept: %d", n)
	}
	if _, err := Stage(e.ctx, e.pool, in); err == nil {
		t.Fatal("reusing a batch id must fail")
	}
	upsert := func(status string, create bool) error {
		tx, err := e.pool.Begin(e.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(e.ctx)
		data, _ := json.Marshal(map[string]any{"status": status, "stats": map[string]any{"created": 1}})
		if err := syncEntity.Upsert(e.ctx, tx, e.profile, batchID, data, create, nil); err != nil {
			return err
		}
		return tx.Commit(e.ctx)
	}
	if err := upsert("committed", true); err == nil {
		t.Fatal("sync must not create batches")
	}
	if err := upsert("rolled_back", false); err == nil {
		t.Fatal("staged -> rolled_back must be refused")
	}
	if err := upsert("committed", false); err != nil {
		t.Fatal(err)
	}
	if err := upsert("rolled_back", false); err != nil {
		t.Fatal(err)
	}
	if err := upsert("committed", false); err == nil {
		t.Fatal("rolled_back -> committed must be refused")
	}
	got, _ := getBatch(e.ctx, e.pool, e.profile, batchID, false)
	if got.Status != "rolled_back" || got.CommittedAt == nil || got.RolledBackAt == nil || got.Stats.Committed != 1 {
		t.Fatalf("batch %+v", got)
	}
}
