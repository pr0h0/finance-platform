package imports

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// Querier is satisfied by *pgxpool.Pool and pgx.Tx.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Money reads a NUMERIC rendered as text (amount::text) into Money.
func Money(text, currency string) (money.Money, error) {
	return money.Parse(trimZeros(text), strings.TrimSpace(currency))
}

// trimZeros drops insignificant fraction zeros of a NUMERIC(30,10) text ("150.0000000000" -> "150").
func trimZeros(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}

func optMoney(text *string, currency *string) (*money.Money, error) {
	if text == nil || currency == nil {
		return nil, nil
	}
	m, err := Money(*text, *currency)
	return &m, err
}

func dateStr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.DateOnly)
	return &s
}

// TransactionSnapshot loads a transaction in its API shape (packages/domain Transaction) including
// postings, splits and tag ids, for changes.Record. Deleted rows are included (tombstone snapshots).
//
// ponytail: duplicated here because the transactions module is written concurrently; switch to its
// exported snapshot function once it exists so the shape has one owner.
func TransactionSnapshot(ctx context.Context, q Querier, profileID, id uuid.UUID) (map[string]any, error) {
	var (
		kind, status, desc, notes, payee, ref, source, catSrc string
		booking                                               time.Time
		valueDate                                             *time.Time
		occurredAt, deletedAt                                 *time.Time
		merchantID, importRecordID, relatedID, correctsID     *uuid.UUID
		exclude                                               bool
		version                                               int
		serverVersion                                         int64
		createdAt, updatedAt                                  time.Time
	)
	err := q.QueryRow(ctx, `SELECT kind, status, booking_date, value_date, occurred_at, description, notes, merchant_id, payee, reference,
		exclude_from_reports, source, import_record_id, related_transaction_id, corrects_transaction_id, categorization_source,
		version, server_version, created_at, updated_at, deleted_at
		FROM transactions WHERE id = $1 AND profile_id = $2`, id, profileID).Scan(
		&kind, &status, &booking, &valueDate, &occurredAt, &desc, &notes, &merchantID, &payee, &ref,
		&exclude, &source, &importRecordID, &relatedID, &correctsID, &catSrc,
		&version, &serverVersion, &createdAt, &updatedAt, &deletedAt)
	if err != nil {
		return nil, fmt.Errorf("transaction snapshot: %w", err)
	}
	postings := []map[string]any{}
	rows, err := q.Query(ctx, `SELECT id, account_id, amount::text, currency, original_amount::text, original_currency, exchange_rate_id, line_no, memo
		FROM postings WHERE transaction_id = $1 AND profile_id = $2 AND deleted_at IS NULL ORDER BY line_no, id`, id, profileID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid, acc uuid.UUID
		var amt, cur string
		var oAmt, oCur *string
		var rateID *uuid.UUID
		var line int
		var memo string
		if err := rows.Scan(&pid, &acc, &amt, &cur, &oAmt, &oCur, &rateID, &line, &memo); err != nil {
			rows.Close()
			return nil, err
		}
		m, err := Money(amt, cur)
		if err != nil {
			rows.Close()
			return nil, err
		}
		om, err := optMoney(oAmt, oCur)
		if err != nil {
			rows.Close()
			return nil, err
		}
		postings = append(postings, map[string]any{"id": pid, "accountId": acc, "amount": m, "originalAmount": om,
			"exchangeRateId": rateID, "lineNo": line, "memo": memo})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	splits := []map[string]any{}
	rows, err = q.Query(ctx, `SELECT id, category_id, amount::text, currency, description, notes, sort_order
		FROM transaction_splits WHERE transaction_id = $1 AND profile_id = $2 AND deleted_at IS NULL ORDER BY sort_order, id`, id, profileID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sid uuid.UUID
		var cat *uuid.UUID
		var amt, cur, sdesc, snotes string
		var sort int
		if err := rows.Scan(&sid, &cat, &amt, &cur, &sdesc, &snotes, &sort); err != nil {
			rows.Close()
			return nil, err
		}
		m, err := Money(amt, cur)
		if err != nil {
			rows.Close()
			return nil, err
		}
		splits = append(splits, map[string]any{"id": sid, "categoryId": cat, "amount": m, "description": sdesc, "notes": snotes, "sortOrder": sort})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	tagIDs := []uuid.UUID{}
	rows, err = q.Query(ctx, `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1 AND profile_id = $2 ORDER BY tag_id`, id, profileID)
	if err != nil {
		return nil, err
	}
	tagIDs, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return nil, err
	}
	attIDs := []uuid.UUID{}
	rows, err = q.Query(ctx, `SELECT id FROM attachments WHERE transaction_id = $1 AND profile_id = $2 AND deleted_at IS NULL ORDER BY id`, id, profileID)
	if err != nil {
		return nil, err
	}
	if attIDs, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
		return nil, err
	}
	return map[string]any{
		"id": id, "profileId": profileID, "version": version, "serverVersion": serverVersion,
		"createdAt": createdAt, "updatedAt": updatedAt, "deletedAt": deletedAt,
		"kind": kind, "status": status, "bookingDate": booking.Format(time.DateOnly), "valueDate": dateStr(valueDate),
		"occurredAt": occurredAt, "description": desc, "notes": notes, "merchantId": merchantID, "payee": payee,
		"reference": ref, "excludeFromReports": exclude, "source": source, "importRecordId": importRecordID,
		"relatedTransactionId": relatedID, "correctsTransactionId": correctsID, "categorizationSource": catSrc,
		"postings": postings, "splits": splits, "tagIds": tagIDs, "attachmentIds": attIDs,
	}, nil
}
