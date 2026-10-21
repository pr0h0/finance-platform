// Package sync: Sync push/pull/status/conflicts and devices.
//
// Owned routes under /api/v1: /sync, /devices
// See docs/api/openapi.yaml and docs/architecture/sync-protocol.md.
package sync

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

const maxOps = 500

func principalFrom(ctx context.Context) authz.Principal {
	p, _ := authz.FromContext(ctx)
	return p
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	s := &svc{db: deps.DB}
	r.Group(func(g chi.Router) {
		g.Use(auth.RateLimit(auth.NewLimiter(deps.Config.RateLimitSyncPM)))
		g.Post("/sync/push", httpx.H(s.push))
		g.Get("/sync/pull", httpx.H(s.pull))
		g.Get("/sync/snapshot", httpx.H(s.snapshot))
	})
	r.Get("/sync/status", httpx.H(s.status))
	r.Get("/sync/conflicts", httpx.H(s.conflicts))
	r.With(httpx.Idempotent(deps.DB)).Post("/sync/conflicts/{id}/resolve", httpx.H(s.resolve))
	r.Get("/sync/keys", httpx.H(s.listKeys))
	r.Post("/sync/keys", httpx.H(s.createKey))
	registerDevices(r, deps.DB)
}

type svc struct{ db *pgxpool.Pool }

// requireDevice checks that deviceID is an active device of the principal.
func requireDevice(ctx context.Context, q authz.Querier, p authz.Principal, deviceID uuid.UUID) error {
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL)`,
		deviceID, p.UserID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return httpx.NewError(http.StatusForbidden, "device_revoked", "unknown or revoked device; enroll the device again")
	}
	return nil
}

func privacyMode(ctx context.Context, q authz.Querier, profileID uuid.UUID) (string, int64, error) {
	var mode string
	var head int64
	err := q.QueryRow(ctx, `SELECT privacy_mode, sync_version FROM profiles WHERE id = $1`, profileID).Scan(&mode, &head)
	return mode, head, err
}

// ---------- push ----------

func (s *svc) push(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		ProtocolVersion int         `json:"protocolVersion"`
		DeviceID        uuid.UUID   `json:"deviceId"`
		ProfileID       uuid.UUID   `json:"profileId"`
		Operations      []Operation `json:"operations"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		return err
	}
	if req.ProtocolVersion != app.SyncProtocolVersion {
		e := httpx.NewError(http.StatusConflict, "protocol_version_mismatch", "unsupported sync protocol version; update the client")
		e.Details = map[string]any{"serverProtocolVersion": app.SyncProtocolVersion}
		return e
	}
	if len(req.Operations) > maxOps {
		return httpx.Validation(map[string]string{"operations": "at most 500 operations per push"})
	}
	if h := r.Header.Get(authz.ProfileHeader); h != "" && h != req.ProfileID.String() {
		return httpx.BadRequest("X-Profile-ID does not match profileId")
	}
	ctx := r.Context()
	p, _, err := authz.RequireProfile(ctx, s.db, req.ProfileID, authz.RoleEditor)
	if err != nil {
		return err
	}
	if p.ActorType != authz.ActorUser {
		return authz.ErrForbidden // MCP writes go through the mcp module's approval flow
	}
	if err := requireDevice(ctx, s.db, p, req.DeviceID); err != nil {
		return err
	}
	p.DeviceID = &req.DeviceID
	ctx = authz.WithPrincipal(ctx, p) // sync_changes.device_id = pushing device
	mode, _, err := privacyMode(ctx, s.db, req.ProfileID)
	if err != nil {
		return err
	}
	results := make([]Result, 0, len(req.Operations))
	for i := range req.Operations {
		res, err := s.applyOne(ctx, req.ProfileID, req.DeviceID, mode == "e2ee", &req.Operations[i])
		if err != nil {
			return err
		}
		results = append(results, res)
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO sync_checkpoints (device_id, profile_id, last_pushed_at) VALUES ($1, $2, now())
		ON CONFLICT (device_id, profile_id) DO UPDATE SET last_pushed_at = now(), updated_at = now()`, req.DeviceID, req.ProfileID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE devices SET last_sync_at = now() WHERE id = $1`, req.DeviceID); err != nil {
		return err
	}
	_, head, err := privacyMode(ctx, s.db, req.ProfileID)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"results": results, "serverVersion": head})
	return nil
}

// applyOne applies one op in its own DB transaction and stores its result under its opId.
// A repeated opId returns the stored result (idempotent retry). Transient server errors are
// reported as rejected/"retry" WITHOUT being stored, so the client retries the same op.
func (s *svc) applyOne(ctx context.Context, profileID, deviceID uuid.UUID, e2ee bool, op *Operation) (Result, error) {
	res := Result{OpID: op.OpID}
	if stored, ok, err := s.storedResult(ctx, profileID, op.OpID); err != nil || ok {
		return stored, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(ctx)

	opErr := op.validate()
	if opErr == nil {
		sp, err := tx.Begin(ctx) // savepoint: a failed op leaves no partial writes
		if err != nil {
			return res, err
		}
		if e2ee {
			opErr = applyEncrypted(ctx, sp, profileID, op)
		} else {
			opErr = applyPlain(ctx, sp, profileID, op)
		}
		if opErr == nil {
			err = sp.Commit(ctx)
		} else {
			err = sp.Rollback(ctx)
		}
		if err != nil {
			return res, err
		}
	}
	var conflict *errConflict
	var herr *httpx.Error
	switch {
	case opErr == nil:
		res.Status = "applied"
		v, sv, err := currentVersions(ctx, tx, profileID, op, e2ee)
		if err != nil {
			return res, err
		}
		res.Version, res.ServerVersion = v, &sv
	case errors.As(opErr, &conflict):
		id, err := insertConflict(ctx, tx, profileID, op, conflict)
		if err != nil {
			return res, err
		}
		res.Status, res.ConflictID, res.Fields = "conflict", &id, conflict.fields
	case errors.As(opErr, &herr):
		res.Status, res.Code, res.Message = "rejected", herr.Code, herr.Message
	default:
		slog.ErrorContext(ctx, "sync op failed", "err", opErr, "entity_type", op.EntityType)
		return Result{OpID: op.OpID, Status: "rejected", Code: "retry", Message: "temporary server error; retry this operation"}, nil
	}
	if op.OpID != uuid.Nil {
		b, _ := json.Marshal(res)
		_, err = tx.Exec(ctx, `INSERT INTO sync_operations (op_id, profile_id, device_id, status, result, server_version)
			VALUES ($1,$2,$3,$4,$5,$6)`, op.OpID, profileID, deviceID, res.Status, b, res.ServerVersion)
		if isUniqueViolation(err) { // a concurrent push of the same op won
			tx.Rollback(ctx)
			stored, _, err := s.storedResult(ctx, profileID, op.OpID)
			return stored, err
		}
		if err != nil {
			return res, err
		}
	}
	return res, tx.Commit(ctx)
}

func (s *svc) storedResult(ctx context.Context, profileID, opID uuid.UUID) (Result, bool, error) {
	var owner uuid.UUID
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT profile_id, result FROM sync_operations WHERE op_id = $1`, opID).Scan(&owner, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, false, nil
	}
	if err != nil {
		return Result{}, false, err
	}
	if owner != profileID {
		return Result{OpID: opID, Status: "rejected", Code: "op_id_conflict", Message: "opId already used"}, true, nil
	}
	var res Result
	return res, true, json.Unmarshal(raw, &res)
}

func currentVersions(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation, e2ee bool) (*int, int64, error) {
	var head int64
	if err := tx.QueryRow(ctx, `SELECT sync_version FROM profiles WHERE id = $1`, profileID).Scan(&head); err != nil {
		return nil, 0, err
	}
	if e2ee {
		var v int
		err := tx.QueryRow(ctx, `SELECT version FROM encrypted_records WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3`,
			profileID, op.EntityType, op.EntityID).Scan(&v)
		return &v, head, err
	}
	ent, _ := lookup(op.EntityType)
	raw, _, err := ent.Load(ctx, tx, profileID, op.EntityID)
	if err != nil {
		return nil, head, err
	}
	m, err := normalize(raw)
	if err != nil {
		return nil, head, err
	}
	if v, ok := versionOf(m); ok {
		return &v, head, nil
	}
	return nil, head, nil
}

func insertConflict(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation, c *errConflict) (uuid.UUID, error) {
	base := 0
	if op.BaseVersion != nil {
		base = *op.BaseVersion
	}
	client := json.RawMessage(`{}`)
	if op.Op == changes.OpUpsert {
		client = op.Data
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO sync_conflicts (profile_id, entity_type, entity_id, op_id, base_version, fields, server_data, client_data, op)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, profileID, op.EntityType, op.EntityID, op.OpID, base, c.fields,
		c.serverData, client, op.Op).Scan(&id)
	if err != nil {
		return id, err
	}
	return id, changes.Audit(ctx, tx, changes.Entry{ProfileID: &profileID, Action: "sync.conflict", EntityType: op.EntityType,
		EntityID: &op.EntityID, Metadata: map[string]any{"conflict_id": id.String(), "op_id": op.OpID.String(), "fields": c.fields}})
}

// ---------- pull / snapshot ----------

type change struct {
	ServerVersion int64      `json:"serverVersion"`
	EntityType    string     `json:"entityType"`
	EntityID      uuid.UUID  `json:"entityId"`
	Op            string     `json:"op"`
	Data          any        `json:"data"`
	OpID          *uuid.UUID `json:"opId"`
	DeviceID      *uuid.UUID `json:"deviceId"`
	ChangedAt     time.Time  `json:"changedAt"`
}

func collectChanges(rows pgx.Rows) ([]change, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (change, error) {
		var c change
		err := row.Scan(&c.ServerVersion, &c.EntityType, &c.EntityID, &c.Op, &c.Data, &c.OpID, &c.DeviceID, &c.ChangedAt)
		return c, err
	})
}

func (s *svc) pull(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	profileID, p, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	since, err := strconv.ParseInt(q.Get("since"), 10, 64)
	if err != nil || since < 0 {
		return httpx.Validation(map[string]string{"since": "non-negative integer required"})
	}
	page, err := httpx.ParsePage(r, 500, 1000)
	if err != nil {
		return err
	}
	var deviceID *uuid.UUID
	if d := q.Get("deviceId"); d != "" {
		id, err := uuid.Parse(d)
		if err != nil {
			return httpx.Validation(map[string]string{"deviceId": "invalid uuid"})
		}
		if err := requireDevice(ctx, s.db, p, id); err != nil {
			return err
		}
		deviceID = &id
	}
	_, head, err := privacyMode(ctx, s.db, profileID)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT server_version, entity_type, entity_id, op, data, op_id, device_id, changed_at
		FROM sync_changes WHERE profile_id = $1 AND server_version > $2 ORDER BY server_version LIMIT $3`, profileID, since, page.Limit+1)
	if err != nil {
		return err
	}
	items, err := collectChanges(rows)
	if err != nil {
		return err
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	next := since
	if len(items) > 0 {
		next = items[len(items)-1].ServerVersion
	}
	if deviceID != nil {
		// Pulling from `since` acknowledges everything up to it (durable server-side checkpoint).
		if _, err := s.db.Exec(ctx, `INSERT INTO sync_checkpoints (device_id, profile_id, last_pulled_version) VALUES ($1,$2,$3)
			ON CONFLICT (device_id, profile_id) DO UPDATE SET last_pulled_version = GREATEST(sync_checkpoints.last_pulled_version, EXCLUDED.last_pulled_version),
			updated_at = now()`, *deviceID, profileID, since); err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE devices SET last_sync_at = now() WHERE id = $1`, *deviceID); err != nil {
			return err
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"changes": nonNil(items), "nextSince": next, "hasMore": hasMore, "serverVersion": head})
	return nil
}

func nonNil(c []change) []change {
	if c == nil {
		return []change{}
	}
	return c
}

// snapshot pages the CURRENT state (latest upsert per entity, tombstones omitted) as of a fixed
// head, for initial download. After the last page the client pulls from serverVersion.
func (s *svc) snapshot(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	profileID, _, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 500, 1000)
	if err != nil {
		return err
	}
	var cur struct {
		Head  int64 `json:"h"`
		After int64 `json:"a"`
	}
	if page.Cursor != "" {
		if err := httpx.DecodeCursor(page.Cursor, &cur); err != nil {
			return err
		}
	} else if _, cur.Head, err = privacyMode(ctx, s.db, profileID); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT c.server_version, c.entity_type, c.entity_id, c.op, c.data, c.op_id, c.device_id, c.changed_at
		FROM sync_changes c WHERE c.profile_id = $1 AND c.server_version > $2 AND c.server_version <= $3 AND c.op = 'upsert'
		AND NOT EXISTS (SELECT 1 FROM sync_changes n WHERE n.profile_id = c.profile_id AND n.entity_type = c.entity_type
			AND n.entity_id = c.entity_id AND n.server_version > c.server_version AND n.server_version <= $3)
		ORDER BY c.server_version LIMIT $4`, profileID, cur.After, cur.Head, page.Limit+1)
	if err != nil {
		return err
	}
	items, err := collectChanges(rows)
	if err != nil {
		return err
	}
	resp := map[string]any{"nextSince": cur.Head, "hasMore": false, "serverVersion": cur.Head}
	if len(items) > page.Limit {
		items = items[:page.Limit]
		resp["hasMore"] = true
		resp["nextCursor"] = httpx.EncodeCursor(struct {
			Head  int64 `json:"h"`
			After int64 `json:"a"`
		}{cur.Head, items[len(items)-1].ServerVersion})
	}
	resp["changes"] = nonNil(items)
	httpx.WriteJSON(w, http.StatusOK, resp)
	return nil
}

// ---------- status ----------

func (s *svc) status(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	profileID, p, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	_, head, err := privacyMode(ctx, s.db, profileID)
	if err != nil {
		return err
	}
	type dev struct {
		DeviceID          uuid.UUID  `json:"deviceId"`
		LastPulledVersion int64      `json:"lastPulledVersion"`
		LastPushedAt      *time.Time `json:"lastPushedAt"`
	}
	rows, err := s.db.Query(ctx, `SELECT c.device_id, c.last_pulled_version, c.last_pushed_at FROM sync_checkpoints c
		JOIN devices d ON d.id = c.device_id WHERE c.profile_id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL ORDER BY d.created_at`, profileID, p.UserID)
	if err != nil {
		return err
	}
	devs, err := pgx.CollectRows(rows, pgx.RowToStructByPos[dev])
	if err != nil {
		return err
	}
	if devs == nil {
		devs = []dev{}
	}
	var open int
	var storage int64
	if err := s.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM sync_conflicts WHERE profile_id = $1 AND status = 'open'),
		(SELECT COALESCE(sum(pg_column_size(data)), 0) FROM sync_changes WHERE profile_id = $1)`, profileID).Scan(&open, &storage); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"profileId": profileID, "serverVersion": head, "devices": devs,
		"openConflicts": open, "storageBytes": storage})
	return nil
}

// ---------- conflicts ----------

type conflictOut struct {
	ID          uuid.UUID       `json:"id"`
	EntityType  string          `json:"entityType"`
	EntityID    uuid.UUID       `json:"entityId"`
	OpID        uuid.UUID       `json:"opId"`
	Op          string          `json:"op"`
	BaseVersion int             `json:"baseVersion"`
	Fields      []string        `json:"fields"`
	ServerData  json.RawMessage `json:"serverData"`
	ClientData  json.RawMessage `json:"clientData"`
	Status      string          `json:"status"`
	CreatedAt   time.Time       `json:"createdAt"`
}

const conflictCols = `id, entity_type, entity_id, op_id, op, base_version, fields, server_data, client_data, status, created_at`

func scanConflict(row pgx.Row) (conflictOut, error) {
	var c conflictOut
	err := row.Scan(&c.ID, &c.EntityType, &c.EntityID, &c.OpID, &c.Op, &c.BaseVersion, &c.Fields, &c.ServerData, &c.ClientData, &c.Status, &c.CreatedAt)
	return c, err
}

func (s *svc) conflicts(w http.ResponseWriter, r *http.Request) error {
	profileID, _, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 100, 500)
	if err != nil {
		return err
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "open"
	}
	if status != "open" && status != "resolved" && status != "dismissed" && status != "all" {
		return httpx.Validation(map[string]string{"status": "open, resolved, dismissed or all"})
	}
	var cur struct {
		At time.Time `json:"t"`
		ID uuid.UUID `json:"i"`
	}
	if page.Cursor != "" {
		if err := httpx.DecodeCursor(page.Cursor, &cur); err != nil {
			return err
		}
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+conflictCols+` FROM sync_conflicts WHERE profile_id = $1
		AND ($2 = 'all' OR status = $2) AND ($3::timestamptz IS NULL OR (created_at, id) > ($3, $4))
		ORDER BY created_at, id LIMIT $5`, profileID, status, nullTime(cur.At), cur.ID, page.Limit+1)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (conflictOut, error) { return scanConflict(row) })
	if err != nil {
		return err
	}
	out := httpx.List[conflictOut]{Items: items}
	if len(items) > page.Limit {
		out.Items = items[:page.Limit]
		last := out.Items[page.Limit-1]
		out.NextCursor = httpx.EncodeCursor(struct {
			At time.Time `json:"t"`
			ID uuid.UUID `json:"i"`
		}{last.CreatedAt, last.ID})
	}
	if out.Items == nil {
		out.Items = []conflictOut{}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// resolve applies an explicit decision. "server" keeps the server state; "client" replays the
// client's data; "merged" applies the given data. Writes go through the entity's validated
// Upsert/Delete (or the envelope store for e2ee), so the resolution is a normal recorded mutation.
func (s *svc) resolve(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	profileID, p, err := authz.ProfileFromRequest(r, s.db, authz.RoleEditor)
	if err != nil {
		return err
	}
	if p.ActorType != authz.ActorUser {
		return authz.ErrForbidden
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return httpx.NotFound("conflict")
	}
	var in struct {
		Choice string          `json:"choice"`
		Data   json.RawMessage `json:"data"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if in.Choice != "server" && in.Choice != "client" && in.Choice != "merged" {
		return httpx.Validation(map[string]string{"choice": "server, client or merged"})
	}
	if in.Choice == "merged" && len(in.Data) == 0 {
		return httpx.Validation(map[string]string{"data": "required for merged"})
	}
	mode, _, err := privacyMode(ctx, s.db, profileID)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	c, err := scanConflict(tx.QueryRow(ctx, `SELECT `+conflictCols+` FROM sync_conflicts WHERE id = $1 AND profile_id = $2 FOR UPDATE`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("conflict")
	}
	if err != nil {
		return err
	}
	if c.Status != "open" {
		return httpx.Conflict("conflict already " + c.Status)
	}
	if in.Choice != "server" {
		op := Operation{OpID: c.OpID, EntityType: c.EntityType, EntityID: c.EntityID, Op: changes.Op(c.Op), Data: c.ClientData}
		if in.Choice == "merged" {
			op.Op, op.Data = changes.OpUpsert, in.Data
		}
		if err := s.force(ctx, tx, profileID, &op, mode == "e2ee"); err != nil {
			return err
		}
	}
	resolution := map[string]any{"choice": in.Choice}
	if in.Choice == "merged" {
		resolution["data"] = in.Data
	}
	if _, err := tx.Exec(ctx, `UPDATE sync_conflicts SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
		id, resolution, p.UserID); err != nil {
		return err
	}
	if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &profileID, Action: "sync.conflict_resolve", EntityType: c.EntityType,
		EntityID: &c.EntityID, Metadata: map[string]any{"conflict_id": id.String(), "choice": in.Choice}}); err != nil {
		return err
	}
	c, err = scanConflict(tx.QueryRow(ctx, `SELECT `+conflictCols+` FROM sync_conflicts WHERE id = $1`, id))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, c)
	return nil
}

// force applies op on top of the current server version (the user explicitly chose it).
func (s *svc) force(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation, e2ee bool) error {
	if e2ee {
		var v int
		err := tx.QueryRow(ctx, `SELECT version FROM encrypted_records WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3 FOR UPDATE`,
			profileID, op.EntityType, op.EntityID).Scan(&v)
		if err == nil {
			op.BaseVersion = &v
			// a tombstoned record is revived only by an explicit choice
			if _, err := tx.Exec(ctx, `UPDATE encrypted_records SET deleted_at = NULL WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3 AND $4`,
				profileID, op.EntityType, op.EntityID, op.Op == changes.OpUpsert); err != nil {
				return err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return asHTTP(applyEncrypted(ctx, tx, profileID, op))
	}
	ent, ok := lookup(op.EntityType)
	if !ok {
		return rejected("unsupported_entity", "entity type "+op.EntityType+" is not syncable")
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM `+pgx.Identifier{op.EntityType}.Sanitize()+` WHERE id = $1 AND profile_id = $2 FOR UPDATE`,
		op.EntityID, profileID); err != nil {
		return err
	}
	_, deleted, err := ent.Load(ctx, tx, profileID, op.EntityID)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if op.Op == changes.OpDelete {
		if !exists || deleted {
			return nil
		}
		return ent.Delete(ctx, tx, profileID, op.EntityID, nil)
	}
	if _, err := op.dataObject(); err != nil {
		return err
	}
	return ent.Upsert(ctx, tx, profileID, op.EntityID, op.Data, !exists, nil)
}

func asHTTP(err error) error {
	var c *errConflict
	if errors.As(err, &c) {
		return httpx.Conflict("entity changed again; reload the conflict")
	}
	return err
}

// ---------- E2EE key envelopes ----------

type keyEnvelope struct {
	ID         uuid.UUID       `json:"id"`
	KeyID      string          `json:"keyId"`
	Kind       string          `json:"kind"`
	DeviceID   *uuid.UUID      `json:"deviceId"`
	WrappedKey []byte          `json:"wrappedKey"` // base64 in JSON
	KDFParams  json.RawMessage `json:"kdfParams"`
	CreatedAt  time.Time       `json:"createdAt"`
}

const keyCols = `id, key_id, kind, device_id, wrapped_key, kdf_params, created_at`

func scanKey(row pgx.Row) (keyEnvelope, error) {
	var k keyEnvelope
	err := row.Scan(&k.ID, &k.KeyID, &k.Kind, &k.DeviceID, &k.WrappedKey, &k.KDFParams, &k.CreatedAt)
	return k, err
}

func (s *svc) listKeys(w http.ResponseWriter, r *http.Request) error {
	profileID, p, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+keyCols+` FROM key_envelopes WHERE profile_id = $1 AND user_id = $2 AND revoked_at IS NULL
		ORDER BY created_at, id`, profileID, p.UserID)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (keyEnvelope, error) { return scanKey(row) })
	if err != nil {
		return err
	}
	if items == nil {
		items = []keyEnvelope{}
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.List[keyEnvelope]{Items: items})
	return nil
}

// createKey stores a wrapped profile data key. The server only ever sees wrapped (encrypted) keys.
func (s *svc) createKey(w http.ResponseWriter, r *http.Request) error {
	profileID, p, err := authz.ProfileFromRequest(r, s.db, authz.RoleViewer)
	if err != nil {
		return err
	}
	if p.ActorType != authz.ActorUser {
		return authz.ErrForbidden
	}
	var in keyEnvelope
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	f := map[string]string{}
	if in.KeyID == "" || len(in.KeyID) > 100 {
		f["keyId"] = "1-100 characters"
	}
	switch in.Kind {
	case "password", "recovery", "member":
	case "device":
		if in.DeviceID == nil {
			f["deviceId"] = "required for device envelopes"
		}
	default:
		f["kind"] = "password, recovery, device or member"
	}
	if len(in.WrappedKey) < 32 || len(in.WrappedKey) > 4096 {
		f["wrappedKey"] = "base64 wrapped key (32-4096 bytes)"
	}
	if len(in.KDFParams) == 0 {
		in.KDFParams = json.RawMessage(`{}`)
	} else if in.KDFParams[0] != '{' {
		f["kdfParams"] = "object"
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	if in.DeviceID != nil {
		if err := requireDevice(r.Context(), s.db, p, *in.DeviceID); err != nil {
			return err
		}
	}
	k, err := scanKey(s.db.QueryRow(r.Context(), `INSERT INTO key_envelopes (user_id, profile_id, device_id, key_id, kind, wrapped_key, kdf_params)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING `+keyCols, p.UserID, profileID, in.DeviceID, in.KeyID, in.Kind, in.WrappedKey, in.KDFParams))
	if err != nil {
		return err
	}
	if err := changes.Audit(r.Context(), s.db, changes.Entry{ProfileID: &profileID, Action: "sync.key_envelope_create", EntityType: "key_envelopes",
		EntityID: &k.ID, Metadata: map[string]any{"kind": k.Kind, "key_id": k.KeyID}}); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, k)
	return nil
}
