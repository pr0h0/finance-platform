package sync

import (
	"context"
	"encoding/json"
	stdsync "sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Entity lets sync push / conflict resolution write a module's syncable table through the SAME
// validated service code as its REST endpoint (sync must not be a back door). A module registers
// its entity once from its Register func:
//
//	sync.RegisterEntity("transactions", sync.Entity{Load: ..., Upsert: ..., Delete: ..., MoneyFields: [...]})
//
// The entity type is the table name (it must have id, profile_id, server_version, version, deleted_at).
// Ops for unregistered entity types are rejected with code "unsupported_entity".
type Entity struct {
	// Load returns the current API-shaped snapshot (the same shape passed to changes.Record as Data,
	// which MUST include the integer "version") and whether the row is tombstoned.
	// Return pgx.ErrNoRows when the id does not exist in profileID. Sync has already locked the row.
	Load func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID) (snapshot any, deleted bool, err error)
	// Upsert validates data (a full API entity object; read-only fields such as version, serverVersion,
	// createdAt must be ignored) and creates (create=true, with the client-chosen id) or updates the row,
	// calling changes.Record(..., OpID: opID). Validation failures are returned as *httpx.Error.
	Upsert func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, data json.RawMessage, create bool, opID *uuid.UUID) error
	// Delete tombstones the row (deleted_at + changes.Record OpDelete).
	Delete func(ctx context.Context, tx pgx.Tx, profileID, id uuid.UUID, opID *uuid.UUID) error
	// MoneyFields are top-level API fields that are never auto-merged (sync-protocol.md), e.g.
	// postings, splits, kind, amount. A stale-base edit touching one becomes a conflict.
	MoneyFields []string
}

var (
	regMu    stdsync.RWMutex
	registry = map[string]Entity{}
)

// RegisterEntity makes entityType pushable. Call it from the owning module's Register.
func RegisterEntity(entityType string, e Entity) {
	if !ident.MatchString(entityType) || e.Load == nil || e.Upsert == nil || e.Delete == nil {
		panic("sync.RegisterEntity: invalid entity " + entityType)
	}
	regMu.Lock()
	defer regMu.Unlock()
	registry[entityType] = e
}

func lookup(entityType string) (Entity, bool) {
	regMu.RLock()
	defer regMu.RUnlock()
	e, ok := registry[entityType]
	return e, ok
}
