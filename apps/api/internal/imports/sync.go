package imports

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// syncEntity lets a connected client report what it did with an import it parsed and staged on
// the device. The batch itself (source file + raw records, client ids) is created with POST
// /imports; the transactions the client committed arrive as ordinary transaction ops linked by
// importRecordId. Sync may only move the batch status forward: staged -> committed -> rolled_back.
var syncEntity = sync.Entity{
	Load: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (any, bool, error) {
		b, err := getBatch(ctx, tx, profileID, id, false)
		if he := (*httpx.Error)(nil); errors.As(err, &he) {
			return nil, false, pgx.ErrNoRows
		}
		return b, false, err
	},
	Upsert: func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, opID *uuid.UUID) error {
		if create {
			return httpx.Unprocessable("upload the import with POST /imports first (source file and raw records)")
		}
		var in struct {
			Status string `json:"status"`
			Stats  struct {
				Created int `json:"created"`
			} `json:"stats"`
		}
		if err := json.Unmarshal(data, &in); err != nil {
			return httpx.Validation(map[string]string{"data": err.Error()})
		}
		b, err := getBatch(ctx, tx, profileID, id, true)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		switch {
		case in.Status == b.Status:
			return nil
		case b.Status == "staged" && in.Status == "committed":
			b.Status, b.CommittedAt, b.Stats.Committed = in.Status, &now, in.Stats.Created
		case b.Status == "committed" && in.Status == "rolled_back":
			b.Status, b.RolledBackAt = in.Status, &now
		default:
			return httpx.Conflict("import batch cannot go from " + b.Status + " to " + in.Status)
		}
		return saveBatchOp(ctx, tx, &b, "import."+map[string]string{"committed": "commit", "rolled_back": "rollback"}[in.Status], opID)
	},
	Delete: func(context.Context, pgx.Tx, uuid.UUID, uuid.UUID, *uuid.UUID) error {
		return httpx.Unprocessable("import batches are evidence and cannot be deleted; roll the batch back instead")
	},
}
