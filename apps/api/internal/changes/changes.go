// Package changes is the ONE way to record a mutation of a syncable entity. Every module that
// creates, updates or soft-deletes a profile-scoped row calls Record inside the same pgx.Tx as
// the write. Record:
//  1. allocates the next per-profile server_version (UPDATE profiles ... RETURNING, row-locked),
//  2. stamps <entity table>.server_version on the row,
//  3. appends to sync_changes (what clients pull),
//  4. appends to audit_log (actor from authz principal in ctx, request id from chi).
//
// See docs/architecture/sync-protocol.md.
package changes

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
)

type Op string

const (
	OpUpsert Op = "upsert"
	OpDelete Op = "delete" // soft delete: set deleted_at first, then Record (tombstone)
)

// Change describes one entity mutation.
type Change struct {
	ProfileID  uuid.UUID
	EntityType string // table name, e.g. "transactions"; must have id + server_version columns
	EntityID   uuid.UUID
	Op         Op
	Data       any        // API-shaped snapshot after the change (nil for delete); E2EE: the envelope
	Before     any        // optional snapshot before the change (audit only, never synced)
	Action     string     // audit action, "<entity>.<verb>", e.g. "transaction.update"
	OpID       *uuid.UUID // client op id when the change came from a sync push
	Metadata   map[string]any
}

var ident = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

type opIDKey struct{}

// WithOpID marks every change recorded under ctx as caused by the sync push operation opID, so module
// service functions need no op-id parameter (the sync push handler sets it around Entity.Upsert/Delete).
func WithOpID(ctx context.Context, opID uuid.UUID) context.Context {
	return context.WithValue(ctx, opIDKey{}, opID)
}

// Record writes the sync change + audit entry and returns the allocated server_version.
func Record(ctx context.Context, tx pgx.Tx, c Change) (int64, error) {
	if !ident.MatchString(c.EntityType) {
		return 0, fmt.Errorf("changes: invalid entity type %q", c.EntityType)
	}
	if c.Op != OpUpsert && c.Op != OpDelete {
		return 0, fmt.Errorf("changes: invalid op %q", c.Op)
	}
	if id, ok := ctx.Value(opIDKey{}).(uuid.UUID); ok && c.OpID == nil {
		c.OpID = &id
	}
	var v int64
	if err := tx.QueryRow(ctx, `UPDATE profiles SET sync_version = sync_version + 1 WHERE id = $1 RETURNING sync_version`,
		c.ProfileID).Scan(&v); err != nil {
		return 0, fmt.Errorf("changes: allocate version: %w", err)
	}
	tag, err := tx.Exec(ctx, fmt.Sprintf(`UPDATE %s SET server_version = $1 WHERE id = $2 AND profile_id = $3`,
		pgx.Identifier{c.EntityType}.Sanitize()), v, c.EntityID, c.ProfileID)
	if err != nil {
		return 0, fmt.Errorf("changes: stamp %s: %w", c.EntityType, err)
	}
	if tag.RowsAffected() != 1 {
		return 0, fmt.Errorf("changes: %s %s not found in profile", c.EntityType, c.EntityID)
	}
	data, err := jsonOrNil(c.Data)
	if err != nil {
		return 0, err
	}
	p, _ := authz.FromContext(ctx)
	var userID *uuid.UUID
	if p.UserID != uuid.Nil {
		userID = &p.UserID
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sync_changes (profile_id, server_version, entity_type, entity_id, op, data, op_id, device_id, user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, c.ProfileID, v, c.EntityType, c.EntityID, c.Op, data, c.OpID, p.DeviceID, userID); err != nil {
		return 0, fmt.Errorf("changes: append sync change: %w", err)
	}
	action := c.Action
	if action == "" {
		action = c.EntityType + "." + string(c.Op)
	}
	meta := c.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	meta["server_version"] = v
	if c.OpID != nil {
		meta["op_id"] = c.OpID.String()
	}
	err = Audit(ctx, tx, Entry{ProfileID: &c.ProfileID, Action: action, EntityType: c.EntityType, EntityID: &c.EntityID,
		Before: c.Before, After: c.Data, Metadata: meta})
	return v, err
}

// Entry is an audit-only record (logins, admin actions, MCP approvals, imports...).
type Entry struct {
	ProfileID  *uuid.UUID
	Action     string
	EntityType string
	EntityID   *uuid.UUID
	Before     any
	After      any
	Metadata   map[string]any
	IP         string // optional
}

// Execer is satisfied by pgx.Tx and *pgxpool.Pool.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Audit appends to audit_log. The actor comes from the context principal (system if none).
func Audit(ctx context.Context, db Execer, e Entry) error {
	p, ok := authz.FromContext(ctx)
	actorType := string(authz.ActorSystem)
	var actorID, userID *uuid.UUID
	if ok {
		actorType = string(p.ActorType)
		id := p.ActorID()
		actorID, userID = &id, &p.UserID
	}
	before, err := jsonOrNil(e.Before)
	if err != nil {
		return err
	}
	after, err := jsonOrNil(e.After)
	if err != nil {
		return err
	}
	meta := e.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	var ip *string
	if e.IP != "" {
		ip = &e.IP
	}
	var entityType *string
	if e.EntityType != "" {
		entityType = &e.EntityType
	}
	_, err = db.Exec(ctx, `INSERT INTO audit_log (actor_type, actor_id, user_id, profile_id, action, entity_type, entity_id, before, after, request_id, ip, metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::inet,$12)`,
		actorType, actorID, userID, e.ProfileID, e.Action, entityType, e.EntityID, before, after,
		middleware.GetReqID(ctx), ip, meta)
	if err != nil {
		return fmt.Errorf("changes: audit: %w", err)
	}
	return nil
}

func jsonOrNil(v any) ([]byte, error) {
	if v == nil {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("changes: marshal: %w", err)
	}
	return b, nil
}
