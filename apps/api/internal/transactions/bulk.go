package transactions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

// BulkEdit (OpenAPI BulkEdit). Only metadata is edited, so totals are preserved by construction.
type BulkEdit struct {
	TransactionIDs []uuid.UUID `json:"transactionIds"`
	Set            struct {
		CategoryID         *uuid.UUID  `json:"categoryId"`
		MerchantID         *uuid.UUID  `json:"merchantId"`
		AddTagIDs          []uuid.UUID `json:"addTagIds"`
		RemoveTagIDs       []uuid.UUID `json:"removeTagIds"`
		ExcludeFromReports *bool       `json:"excludeFromReports"`
		Status             *string     `json:"status"`
		// ClearCategory/ClearMerchant set the field to null (a JSON null cannot be told from "absent" here).
		ClearCategory bool `json:"clearCategory"`
		ClearMerchant bool `json:"clearMerchant"`
	} `json:"set"`
}

type BulkFailure struct {
	ID      uuid.UUID `json:"id"`
	Code    string    `json:"code"`
	Message string    `json:"message"`
}

type BulkResult struct {
	Updated int           `json:"updated"`
	Failed  []BulkFailure `json:"failed"`
}

// Bulk applies the same edit to every transaction (all-or-nothing: callers roll back when Failed is
// non-empty, and Updated is then 0). Category changes apply only to transactions with at most one split.
func Bulk(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, in BulkEdit) (*BulkResult, error) {
	if len(in.TransactionIDs) == 0 || len(in.TransactionIDs) > 1000 {
		return nil, httpx.Validation(map[string]string{"transactionIds": "1..1000 ids"})
	}
	res := &BulkResult{Failed: []BulkFailure{}}
	fail := func(id uuid.UUID, err error) {
		var he *httpx.Error
		if errors.As(err, &he) {
			res.Failed = append(res.Failed, BulkFailure{id, he.Code, he.Message})
		} else {
			res.Failed = append(res.Failed, BulkFailure{id, "error", err.Error()})
		}
	}
	for _, id := range in.TransactionIDs {
		cur, err := ledger.Get(ctx, tx, profileID, id, true)
		if err == nil && cur.DeletedAt != nil {
			err = httpx.NotFound("transaction")
		}
		if err != nil {
			fail(id, err)
			continue
		}
		after := cur.Clone()
		s := in.Set
		if s.CategoryID != nil || s.ClearCategory {
			switch {
			case !ledger.SplitKinds(cur.Kind):
				fail(id, httpx.Validation(map[string]string{"categoryId": cur.Kind + " transactions are not categorized"}))
				continue
			case len(cur.Splits) > 1:
				fail(id, httpx.NewError(422, "splits_mismatch", "transaction has several splits"))
				continue
			}
			after.Splits[0].CategoryID = s.CategoryID
			after.CategorizationSource = "user"
		}
		if s.MerchantID != nil || s.ClearMerchant {
			after.MerchantID = s.MerchantID
		}
		after.TagIDs = append(after.TagIDs, s.AddTagIDs...)
		if len(s.RemoveTagIDs) > 0 {
			var kept []uuid.UUID
			for _, t := range after.TagIDs {
				remove := false
				for _, r := range s.RemoveTagIDs {
					remove = remove || r == t
				}
				if !remove {
					kept = append(kept, t)
				}
			}
			after.TagIDs = kept
		}
		if after.TagIDs == nil {
			after.TagIDs = []uuid.UUID{}
		}
		if s.ExcludeFromReports != nil {
			after.ExcludeFromReports = *s.ExcludeFromReports
		}
		if s.Status != nil {
			after.Status = *s.Status
		}
		if _, err := ledger.Update(ctx, tx, cur, after, "transaction.bulk_update", map[string]any{"bulk": true}); err != nil {
			fail(id, err)
			continue
		}
		res.Updated++
	}
	if len(res.Failed) > 0 {
		res.Updated = 0
	}
	return res, nil
}

// History returns the audit trail of one transaction, newest first (at most 200 entries).
func History(ctx context.Context, db ledger.DB, profileID, id uuid.UUID) ([]AuditEntry, error) {
	rows, err := db.Query(ctx, `SELECT id, occurred_at, actor_type, actor_id, profile_id, action, entity_type, entity_id, before, after, request_id
		FROM audit_log WHERE profile_id = $1 AND entity_type = 'transactions' AND entity_id = $2 ORDER BY id DESC LIMIT 200`, profileID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		var before, after []byte
		if err := rows.Scan(&e.ID, &e.OccurredAt, &e.ActorType, &e.ActorID, &e.ProfileID, &e.Action, &e.EntityType, &e.EntityID,
			&before, &after, &e.RequestID); err != nil {
			return nil, err
		}
		e.Before, e.After = nullJSON(before), nullJSON(after)
		out = append(out, e)
	}
	return out, rows.Err()
}

func nullJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	return b
}

// Undo reverts the most recent recorded change of the transaction: a create is undone by a delete, a
// delete by a restore, an update by re-applying the previous snapshot (itself audited as transaction.undo,
// so undoing twice redoes). Imported evidence stays protected by ledger.Update.
func Undo(ctx context.Context, tx pgx.Tx, cur *ledger.Transaction) (*ledger.Transaction, error) {
	var before []byte
	var action string
	err := tx.QueryRow(ctx, `SELECT before, action FROM audit_log WHERE profile_id = $1 AND entity_type = 'transactions' AND entity_id = $2
		ORDER BY id DESC LIMIT 1`, cur.ProfileID, cur.ID).Scan(&before, &action)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.Conflict("nothing to undo")
	}
	if err != nil {
		return nil, err
	}
	if len(before) == 0 {
		if cur.DeletedAt != nil {
			return nil, httpx.Conflict("nothing to undo")
		}
		if err := ledger.Delete(ctx, tx, cur, "transaction.undo"); err != nil {
			return nil, err
		}
		return ledger.Get(ctx, tx, cur.ProfileID, cur.ID, false)
	}
	var prev ledger.Transaction
	if err := json.Unmarshal(before, &prev); err != nil {
		return nil, fmt.Errorf("undo: decode snapshot: %w", err)
	}
	// Restore only what the snapshot describes; ids/profile/versions stay those of the current row.
	prev.ID, prev.ProfileID, prev.Version = cur.ID, cur.ProfileID, cur.Version
	prev.Source, prev.ImportRecordID, prev.CorrectsTransactionID = cur.Source, cur.ImportRecordID, cur.CorrectsTransactionID
	if prev.TagIDs == nil {
		prev.TagIDs = []uuid.UUID{}
	}
	return ledger.Update(ctx, tx, cur, &prev, "transaction.undo", map[string]any{"undoes": action})
}
