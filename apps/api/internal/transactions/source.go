package transactions

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/money"
)

// SourceRecord is the API shape of the immutable imported evidence (OpenAPI ImportedRawRecord).
type SourceRecord struct {
	ID                uuid.UUID       `json:"id"`
	ImportBatchID     uuid.UUID       `json:"importBatchId"`
	RowNumber         int             `json:"rowNumber"`
	SourceDescription string          `json:"sourceDescription"`
	PostingDate       string          `json:"postingDate"`
	ValueDate         *string         `json:"valueDate"`
	Amount            money.Money     `json:"amount"`
	Direction         string          `json:"direction"`
	OriginalAmount    *money.Money    `json:"originalAmount"`
	ExchangeRate      *string         `json:"exchangeRate"`
	RunningBalance    *money.Money    `json:"runningBalance"`
	BankReference     string          `json:"bankReference"`
	StatementRef      string          `json:"statementRef"`
	SourceAccount     string          `json:"sourceAccount"`
	Counterparty      string          `json:"counterparty"`
	Raw               json.RawMessage `json:"raw"`
	ImporterID        string          `json:"importerId"`
	ImporterVersion   string          `json:"importerVersion"`
	Warnings          json.RawMessage `json:"warnings"`
}

type withSource struct {
	*ledger.Transaction
	SourceRecord *SourceRecord `json:"sourceRecord"`
}

func loadSource(ctx context.Context, db ledger.DB, t *ledger.Transaction) (*SourceRecord, error) {
	if t.ImportRecordID == nil {
		return nil, nil
	}
	var s SourceRecord
	var amt, orig, run pgtype.Numeric
	var cur string
	var ocur *string
	err := db.QueryRow(ctx, `SELECT id, import_batch_id, row_number, source_description, posting_date::text, value_date::text,
		amount, direction, currency, original_amount, original_currency, exchange_rate::text, running_balance, bank_reference,
		statement_ref, source_account, counterparty, raw, importer_id, importer_version, warnings
		FROM imported_raw_records WHERE id = $1 AND profile_id = $2`, *t.ImportRecordID, t.ProfileID).Scan(
		&s.ID, &s.ImportBatchID, &s.RowNumber, &s.SourceDescription, &s.PostingDate, &s.ValueDate, &amt, &s.Direction, &cur,
		&orig, &ocur, &s.ExchangeRate, &run, &s.BankReference, &s.StatementRef, &s.SourceAccount, &s.Counterparty, &s.Raw,
		&s.ImporterID, &s.ImporterVersion, &s.Warnings)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Stored evidence may carry more precision than the currency scale; never round it silently.
	if s.Amount, err = money.FromNumeric(amt, cur); err != nil {
		return nil, err
	}
	if orig.Valid && ocur != nil {
		if o, err := money.FromNumeric(orig, *ocur); err == nil {
			s.OriginalAmount = &o
		}
	}
	if run.Valid {
		if r, err := money.FromNumeric(run, cur); err == nil {
			s.RunningBalance = &r
		}
	}
	if s.ExchangeRate != nil {
		v := ledger.TrimDecimal(*s.ExchangeRate)
		s.ExchangeRate = &v
	}
	return &s, nil
}
