package transactions

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// syncEntity accepts the client's full transaction snapshot (header + postings + splits + tags +
// conversion, derived on the device like service.go does) and writes it through the ledger, which
// re-validates every invariant. Child ids are server-assigned; they travel back in the pulled snapshot.
var syncEntity = sync.Entity{
	MoneyFields: []string{"kind", "postings", "splits", "conversion", "status", "bookingDate"},
	Load: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (any, bool, error) {
		t, err := ledger.Get(ctx, tx, profileID, id, false)
		if he := (*httpx.Error)(nil); errors.As(err, &he) {
			return nil, false, pgx.ErrNoRows
		} else if err != nil {
			return nil, false, err
		}
		return t, t.DeletedAt != nil, nil
	},
	Upsert: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, _ *uuid.UUID) error {
		var in ledger.Transaction
		if err := json.Unmarshal(data, &in); err != nil {
			return httpx.Validation(map[string]string{"data": err.Error()})
		}
		in.ID, in.ProfileID, in.DeletedAt = id, profileID, nil
		if in.TagIDs == nil {
			in.TagIDs = []uuid.UUID{}
		}
		if err := serverRefs(ctx, tx, profileID, &in); err != nil {
			return err
		}
		if create {
			_, err := ledger.Create(ctx, tx, &in, "transaction.create", nil)
			return err
		}
		cur, err := ledger.Get(ctx, tx, profileID, id, true)
		if err != nil {
			return err
		}
		// Not client-editable after creation (ledger.Update keeps them too), except that a manual entry
		// may be linked to the bank record that proves it (browser import matching) and unlinked again
		// (rollback of that import). serverRefs already dropped record ids this profile does not have.
		in.Source, in.CorrectsTransactionID = cur.Source, cur.CorrectsTransactionID
		if cur.Source == "import" {
			in.ImportRecordID = cur.ImportRecordID
		}
		in.Version, in.CreatedAt = cur.Version, cur.CreatedAt
		_, err = ledger.Update(ctx, tx, cur, &in, "transaction.update", nil)
		return err
	},
	Delete: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, _ *uuid.UUID) error {
		cur, err := ledger.Get(ctx, tx, profileID, id, true)
		if err != nil {
			return err
		}
		return ledger.Delete(ctx, tx, cur, "transaction.delete")
	},
}

// serverRefs drops references to rows that live only on the device (exchange rates and imported
// raw records are local tables in the client store), so they cannot point at another profile's rows.
func serverRefs(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, t *ledger.Transaction) error {
	known := func(table string, id *uuid.UUID) (*uuid.UUID, error) {
		if id == nil {
			return nil, nil
		}
		q := `SELECT EXISTS (SELECT 1 FROM imported_raw_records WHERE id = $1 AND profile_id = $2)`
		if table == "exchange_rates" {
			q = `SELECT EXISTS (SELECT 1 FROM exchange_rates WHERE id = $1 AND (profile_id = $2 OR profile_id IS NULL))`
		}
		var ok bool
		if err := tx.QueryRow(ctx, q, *id, profileID).Scan(&ok); err != nil || !ok {
			return nil, err
		}
		return id, nil
	}
	var err error
	for i := range t.Postings {
		if t.Postings[i].ExchangeRateID, err = known("exchange_rates", t.Postings[i].ExchangeRateID); err != nil {
			return err
		}
	}
	if t.Conversion != nil {
		if t.Conversion.ExchangeRateID, err = known("exchange_rates", t.Conversion.ExchangeRateID); err != nil {
			return err
		}
	}
	t.ImportRecordID, err = known("imported_raw_records", t.ImportRecordID)
	return err
}
