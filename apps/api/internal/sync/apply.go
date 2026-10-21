package sync

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

var ident = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// Operation is one client op (packages/domain/src/sync.ts SyncOperation).
type Operation struct {
	OpID          uuid.UUID       `json:"opId"`
	EntityType    string          `json:"entityType"`
	EntityID      uuid.UUID       `json:"entityId"`
	Op            changes.Op      `json:"op"`
	BaseVersion   *int            `json:"baseVersion"`
	Data          json.RawMessage `json:"data"`
	ChangedFields []string        `json:"changedFields,omitempty"`
	ClientTime    string          `json:"clientTime"`
}

// Result is one entry of PushResponse.results.
type Result struct {
	OpID          uuid.UUID  `json:"opId"`
	Status        string     `json:"status"` // applied | conflict | rejected
	ServerVersion *int64     `json:"serverVersion,omitempty"`
	Version       *int       `json:"version,omitempty"`
	ConflictID    *uuid.UUID `json:"conflictId,omitempty"`
	Fields        []string   `json:"fields,omitempty"`
	Code          string     `json:"code,omitempty"`
	Message       string     `json:"message,omitempty"`
}

// volatile fields change on every write and never count as a user change.
var volatile = map[string]bool{"version": true, "serverVersion": true, "updatedAt": true}

// errConflict carries a detected conflict out of the apply functions.
type errConflict struct {
	fields     []string
	serverData any
}

func (e *errConflict) Error() string { return "conflict" }

func rejected(code, msg string) *httpx.Error {
	return httpx.NewError(http.StatusUnprocessableEntity, code, msg)
}

func (o *Operation) dataObject() (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal(o.Data, &m); err != nil || m == nil {
		return nil, rejected("invalid_data", "data must be a JSON object for upsert")
	}
	return m, nil
}

func (o *Operation) validate() error {
	switch {
	case o.OpID == uuid.Nil:
		return rejected("invalid_op", "opId required")
	case !ident.MatchString(o.EntityType):
		return rejected("invalid_op", "invalid entityType")
	case o.EntityID == uuid.Nil:
		return rejected("invalid_op", "entityId required")
	case o.Op != changes.OpUpsert && o.Op != changes.OpDelete:
		return rejected("invalid_op", "op must be upsert or delete")
	case o.BaseVersion != nil && *o.BaseVersion < 1:
		return rejected("invalid_op", "baseVersion must be >= 1 or null")
	}
	if o.Op == changes.OpUpsert {
		_, err := o.dataObject()
		return err
	}
	return nil
}

// normalize turns any API value into its generic JSON form so snapshots compare structurally.
func normalize(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("sync: snapshot is not an object: %w", err)
	}
	return m, nil
}

func versionOf(m map[string]any) (int, bool) {
	f, ok := m["version"].(float64)
	return int(f), ok && f >= 1
}

// changedKeys lists top-level fields whose values differ between a and b (volatile fields ignored).
func changedKeys(a, b map[string]any) []string {
	var out []string
	for k, av := range a {
		if bv, ok := b[k]; !volatile[k] && (!ok || !reflect.DeepEqual(av, bv)) {
			out = append(out, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok && !volatile[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func intersect(a, b []string) []string {
	var out []string
	for _, x := range a {
		if slices.Contains(b, x) && !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

// sameContent: every field the client sent equals the server's (retry of a create whose response was lost).
func sameContent(client, server map[string]any) bool {
	for k, v := range client {
		if !volatile[k] && k != "createdAt" && !reflect.DeepEqual(v, server[k]) {
			return false
		}
	}
	return true
}

// mergePlan decides the stale-base update rule of sync-protocol.md step 4:
// fields changed on the server since base vs. fields the client changed. Disjoint and no client
// change to a money-bearing field → merged object (server state + client fields); otherwise the
// conflicting fields.
func mergePlan(base, current, client map[string]any, clientFields, money []string) (map[string]any, []string) {
	serverChanged := changedKeys(base, current)
	if len(clientFields) == 0 {
		clientFields = changedKeys(base, client)
	}
	bad := intersect(serverChanged, clientFields)
	for _, f := range intersect(clientFields, money) {
		if !slices.Contains(bad, f) {
			bad = append(bad, f)
		}
	}
	if len(bad) > 0 {
		sort.Strings(bad)
		return nil, bad
	}
	merged := make(map[string]any, len(current))
	for k, v := range current {
		merged[k] = v
	}
	for _, f := range clientFields {
		if v, ok := client[f]; ok {
			merged[f] = v
		} else {
			delete(merged, f)
		}
	}
	return merged, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// applyPlain applies one op to a server-readable profile through the registered Entity.
func applyPlain(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation) error {
	ent, ok := lookup(op.EntityType)
	if !ok {
		return rejected("unsupported_entity", "entity type "+op.EntityType+" is not syncable")
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`SELECT 1 FROM %s WHERE id = $1 AND profile_id = $2 FOR UPDATE`,
		pgx.Identifier{op.EntityType}.Sanitize()), op.EntityID, profileID); err != nil {
		return err
	}
	raw, deleted, err := ent.Load(ctx, tx, profileID, op.EntityID)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var current map[string]any
	if exists {
		if current, err = normalize(raw); err != nil {
			return err
		}
	}
	opID := op.OpID
	write := func(data json.RawMessage, create bool) error {
		err := ent.Upsert(ctx, tx, profileID, op.EntityID, data, create, &opID)
		if isUniqueViolation(err) {
			return rejected("id_conflict", "an entity with this id already exists")
		}
		return err
	}

	if op.Op == changes.OpDelete {
		switch {
		case !exists:
			return rejected("not_found", "entity not found")
		case deleted:
			return nil // idempotent
		case op.BaseVersion != nil:
			if v, _ := versionOf(current); v != *op.BaseVersion {
				base, found, err := baseSnapshot(ctx, tx, profileID, op, *op.BaseVersion)
				if err != nil {
					return err
				}
				if !found {
					return &errConflict{fields: []string{"*"}, serverData: current}
				}
				if bad := intersect(changedKeys(base, current), ent.MoneyFields); len(bad) > 0 {
					return &errConflict{fields: bad, serverData: current}
				}
			}
		}
		return ent.Delete(ctx, tx, profileID, op.EntityID, &opID)
	}

	client, _ := op.dataObject()
	switch {
	case !exists && op.BaseVersion != nil:
		return rejected("not_found", "entity not found")
	case !exists:
		return write(op.Data, true)
	case op.BaseVersion == nil:
		if !deleted && sameContent(client, current) {
			return nil // retried create
		}
		return rejected("id_conflict", "an entity with this id already exists")
	case deleted:
		return &errConflict{fields: []string{"deletedAt"}, serverData: current}
	}
	if v, _ := versionOf(current); v == *op.BaseVersion {
		return write(op.Data, false)
	}
	base, found, err := baseSnapshot(ctx, tx, profileID, op, *op.BaseVersion)
	if err != nil {
		return err
	}
	if !found {
		fields := op.ChangedFields
		if len(fields) == 0 {
			fields = []string{"*"}
		}
		return &errConflict{fields: fields, serverData: current}
	}
	merged, bad := mergePlan(base, current, client, op.ChangedFields, ent.MoneyFields)
	if bad != nil {
		return &errConflict{fields: bad, serverData: current}
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	return write(b, false)
}

// baseSnapshot finds the entity state the client based its edit on, from the change log.
func baseSnapshot(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation, version int) (map[string]any, bool, error) {
	var m map[string]any
	err := tx.QueryRow(ctx, `SELECT data FROM sync_changes WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3
		AND op = 'upsert' AND data -> 'version' = to_jsonb($4::int) ORDER BY server_version DESC LIMIT 1`,
		profileID, op.EntityType, op.EntityID, version).Scan(&m)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return m, err == nil, err
}

// ---------- E2EE (opaque envelopes) ----------

type envelope struct {
	V     int    `json:"v"`
	Alg   string `json:"alg"`
	KeyID string `json:"keyId"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
}

// parseEnvelope checks the ADR 0005 envelope shape; the server never decrypts it.
func parseEnvelope(raw json.RawMessage) (map[string]any, error) {
	bad := rejected("invalid_envelope", "e2ee profiles accept only {v:1, alg:\"xchacha20poly1305-ietf\", keyId, nonce, ct} envelopes")
	var e envelope
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e); err != nil {
		return nil, bad
	}
	nonce, err1 := base64.StdEncoding.DecodeString(e.Nonce)
	ct, err2 := base64.StdEncoding.DecodeString(e.CT)
	if e.V != 1 || e.Alg != "xchacha20poly1305-ietf" || e.KeyID == "" || len(e.KeyID) > 100 ||
		err1 != nil || len(nonce) != 24 || err2 != nil || len(ct) < 16 {
		return nil, bad
	}
	return map[string]any{"v": e.V, "alg": e.Alg, "keyId": e.KeyID, "nonce": e.Nonce, "ct": e.CT}, nil
}

// applyEncrypted stores an envelope for an e2ee profile. The server cannot merge ciphertext, so
// every stale-base update is a conflict resolved on a client.
func applyEncrypted(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation) error {
	var env map[string]any
	if op.Op == changes.OpUpsert {
		var err error
		if env, err = parseEnvelope(op.Data); err != nil {
			return err
		}
	}
	var cur map[string]any
	var version int
	var deletedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT envelope, version, deleted_at FROM encrypted_records
		WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3 FOR UPDATE`, profileID, op.EntityType, op.EntityID).
		Scan(&cur, &version, &deletedAt)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	deleted := deletedAt != nil
	server := map[string]any{"envelope": cur, "version": version, "deleted": deleted}

	if op.Op == changes.OpDelete {
		switch {
		case !exists:
			return rejected("not_found", "entity not found")
		case deleted:
			return nil
		case op.BaseVersion != nil && *op.BaseVersion != version:
			return &errConflict{fields: []string{"*"}, serverData: server}
		}
		if _, err := tx.Exec(ctx, `UPDATE encrypted_records SET deleted_at = now(), version = version + 1
			WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3`, profileID, op.EntityType, op.EntityID); err != nil {
			return err
		}
		return recordEncrypted(ctx, tx, profileID, op, nil, version+1)
	}
	switch {
	case !exists && op.BaseVersion != nil:
		return rejected("not_found", "entity not found")
	case !exists:
		if _, err := tx.Exec(ctx, `INSERT INTO encrypted_records (profile_id, entity_type, entity_id, envelope) VALUES ($1,$2,$3,$4)`,
			profileID, op.EntityType, op.EntityID, env); err != nil {
			return err
		}
		return recordEncrypted(ctx, tx, profileID, op, env, 1)
	case op.BaseVersion == nil:
		if !deleted && reflect.DeepEqual(cur, env) {
			return nil
		}
		return rejected("id_conflict", "an entity with this id already exists")
	case deleted || *op.BaseVersion != version:
		return &errConflict{fields: []string{"*"}, serverData: server}
	}
	if _, err := tx.Exec(ctx, `UPDATE encrypted_records SET envelope = $4, version = version + 1
		WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3`, profileID, op.EntityType, op.EntityID, env); err != nil {
		return err
	}
	return recordEncrypted(ctx, tx, profileID, op, env, version+1)
}

// recordEncrypted is changes.Record for encrypted_records (composite key, real entity type in the log).
// The pulled data is the envelope plus its "version"; the audit entry never contains ciphertext.
func recordEncrypted(ctx context.Context, tx pgx.Tx, profileID uuid.UUID, op *Operation, env map[string]any, version int) error {
	var sv int64
	if err := tx.QueryRow(ctx, `UPDATE profiles SET sync_version = sync_version + 1 WHERE id = $1 RETURNING sync_version`, profileID).Scan(&sv); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE encrypted_records SET server_version = $4 WHERE profile_id = $1 AND entity_type = $2 AND entity_id = $3`,
		profileID, op.EntityType, op.EntityID, sv); err != nil {
		return err
	}
	var data any
	if env != nil {
		d := map[string]any{"version": version}
		for k, v := range env {
			d[k] = v
		}
		data = d
	}
	p := principalFrom(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO sync_changes (profile_id, server_version, entity_type, entity_id, op, data, op_id, device_id, user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, profileID, sv, op.EntityType, op.EntityID, op.Op, data, op.OpID, p.DeviceID, p.UserID); err != nil {
		return err
	}
	opID := op.OpID.String()
	return changes.Audit(ctx, tx, changes.Entry{ProfileID: &profileID, Action: op.EntityType + ".sync_" + string(op.Op),
		EntityType: op.EntityType, EntityID: &op.EntityID,
		Metadata: map[string]any{"encrypted": true, "server_version": sv, "op_id": opID, "version": version}})
}
