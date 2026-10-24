package backups

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/attachments"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// Export is the open, documented data format (Feature 94, docs/api/export-format.md):
// every row of every profile-scoped table as JSON (column names as in the database), plus the
// latest API snapshot of each synced entity so a restore can rebuild the sync log.
type Export struct {
	Format        string                       `json:"format"` // "finplat-export"
	FormatVersion int                          `json:"formatVersion"`
	SchemaVersion int64                        `json:"schemaVersion"`
	ExportedAt    time.Time                    `json:"exportedAt"`
	Profile       map[string]any               `json:"profile"`
	Settings      json.RawMessage              `json:"settings"`
	Tables        map[string][]json.RawMessage `json:"tables"`
	Snapshots     []Snapshot                   `json:"snapshots"`
	Files         []File                       `json:"files"` // formatVersion 2; absent in version 1
}

// File is the content of one attachment row (formatVersion 2).
type File struct {
	AttachmentID string `json:"attachmentId"`
	MimeType     string `json:"mimeType"`
	SHA256       string `json:"sha256"` // hex of the plaintext
	Data         []byte `json:"data"`   // base64 (standard, padded)
}

// Snapshot is the latest synced state of one entity (sync_changes data).
type Snapshot struct {
	EntityType    string          `json:"entityType"`
	EntityID      uuid.UUID       `json:"entityId"`
	ServerVersion int64           `json:"serverVersion"`
	Data          json.RawMessage `json:"data"`
}

const (
	exportFormat        = "finplat-export"
	exportFormatVersion = 2 // 2 added files (attachment contents); 1 is still restored
)

// excluded profile-scoped tables: logs, sync bookkeeping, credentials and key material are
// server-instance state, not user data (audit history stays on the source server).
var excluded = []string{"sync_changes", "sync_operations", "sync_checkpoints", "sync_conflicts", "audit_log",
	"encrypted_backups", "key_envelopes", "mcp_permission_grants", "mcp_proposed_changes", "profile_members", "profiles"}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// dataTables lists every base table with a profile_id column (new modules are picked up automatically).
func dataTables(ctx context.Context, q querier) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT c.table_name::text FROM information_schema.columns c
		JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public' AND c.column_name = 'profile_id' AND t.table_type = 'BASE TABLE'
		  AND NOT (c.table_name = ANY($1)) ORDER BY 1`, excluded)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// BuildExport reads the whole profile inside one REPEATABLE READ snapshot (consistent export).
func BuildExport(ctx context.Context, db interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}, profileID uuid.UUID) (*Export, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	sv, err := schemaVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	e := &Export{Format: exportFormat, FormatVersion: exportFormatVersion, SchemaVersion: sv, ExportedAt: time.Now().UTC(),
		Tables: map[string][]json.RawMessage{}, Settings: json.RawMessage(`{}`), Snapshots: []Snapshot{}, Files: []File{}}
	if err := tx.QueryRow(ctx, `SELECT to_jsonb(p) FROM profiles p WHERE id = $1`, profileID).Scan(&e.Profile); err != nil {
		return nil, fmt.Errorf("export profile: %w", err)
	}
	err = tx.QueryRow(ctx, `SELECT value FROM settings WHERE scope = 'profile' AND owner_id = $1 AND key = 'settings'`, profileID).Scan(&e.Settings)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	tables, err := dataTables(ctx, tx)
	if err != nil {
		return nil, err
	}
	for _, t := range tables {
		rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT to_jsonb(t) FROM %s t WHERE profile_id = $1`, pgx.Identifier{t}.Sanitize()), profileID)
		if err != nil {
			return nil, fmt.Errorf("export %s: %w", t, err)
		}
		items, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
		if err != nil {
			return nil, fmt.Errorf("export %s: %w", t, err)
		}
		if len(items) > 0 {
			e.Tables[t] = items
		}
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (entity_type, entity_id) entity_type, entity_id, server_version, COALESCE(data, 'null'), op
		FROM sync_changes WHERE profile_id = $1 ORDER BY entity_type, entity_id, server_version DESC`, profileID)
	if err != nil {
		return nil, err
	}
	all, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (struct {
		Snapshot
		op string
	}, error) {
		var s struct {
			Snapshot
			op string
		}
		err := row.Scan(&s.EntityType, &s.EntityID, &s.ServerVersion, &s.Data, &s.op)
		return s, err
	})
	if err != nil {
		return nil, err
	}
	for _, s := range all {
		if s.op == "upsert" {
			e.Snapshots = append(e.Snapshots, s.Snapshot)
		}
	}
	slices.SortFunc(e.Snapshots, func(a, b Snapshot) int { return int(a.ServerVersion - b.ServerVersion) })
	return e, nil
}

// attachmentRow: the attachments columns export and restore need (to_jsonb names; sha256 is "\\x<hex>").
type attachmentRow struct {
	ID        string  `json:"id"`
	Type      string  `json:"content_type"`
	SHA256    string  `json:"sha256"`
	Backend   string  `json:"storage_backend"`
	Key       string  `json:"storage_key"`
	Sealed    bool    `json:"server_encrypted"`
	DeletedAt *string `json:"deleted_at"`
}

// AddFiles reads the content of every live attachment of the export into e.Files. E2EE profiles keep
// attachments on their devices, so there is nothing to add. Rows whose content is missing are skipped.
// ponytail: contents are held in memory (and base64 again while encoding); stream the JSON if exports get huge.
func AddFiles(ctx context.Context, cfg *config.Config, e *Export) error {
	if mode, _ := e.Profile["privacy_mode"].(string); mode == "e2ee" {
		return nil
	}
	for _, raw := range e.Tables["attachments"] {
		var a attachmentRow
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		if a.DeletedAt != nil {
			continue
		}
		data, err := attachments.Content(ctx, cfg, a.Backend, a.Key, a.Sealed, 1<<40)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("export attachment %s: %w", a.ID, err)
		}
		sum := sha256.Sum256(data)
		e.Files = append(e.Files, File{AttachmentID: a.ID, MimeType: a.Type, SHA256: hex.EncodeToString(sum[:]), Data: data})
	}
	return nil
}

func schemaVersion(ctx context.Context, q querier) (int64, error) {
	var v int64 // same as database.SchemaVersion, usable inside a transaction
	err := q.QueryRow(ctx, `SELECT COALESCE(MAX(version_id), 0) FROM goose_db_version WHERE is_applied`).Scan(&v)
	return v, err
}

// ParseExport accepts the export JSON, gzipped or not.
func ParseExport(raw []byte) (*Export, error) {
	if len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, httpx.BadRequest("invalid gzip")
		}
		// ponytail: decompressed size is bounded at 20x the upload limit against gzip bombs.
		if raw, err = io.ReadAll(io.LimitReader(zr, int64(len(raw))*20+1<<20)); err != nil {
			return nil, httpx.BadRequest("invalid gzip")
		}
	}
	var e Export
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, httpx.BadRequest("backup is not a finplat export: " + err.Error())
	}
	if e.Format != exportFormat || e.FormatVersion < 1 || e.FormatVersion > exportFormatVersion || e.Profile == nil {
		return nil, httpx.Unprocessable("unsupported backup format")
	}
	return &e, nil
}

// fkInfo: (table, column) -> referenced table, for single-column foreign keys.
func fkInfo(ctx context.Context, q querier) (map[string]map[string]string, error) {
	rows, err := q.Query(ctx, `SELECT c.conrelid::regclass::text, a.attname::text, c.confrelid::regclass::text
		FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
		WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.connamespace = 'public'::regnamespace`)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]string{}
	for rows.Next() {
		var t, col, ref string
		if err := rows.Scan(&t, &col, &ref); err != nil {
			return nil, err
		}
		if out[t] == nil {
			out[t] = map[string]string{}
		}
		out[t][col] = ref
	}
	return out, rows.Err()
}

// remap replaces every string equal to an old id (anywhere in the value) with its new id.
func remap(v any, ids map[string]string) any {
	switch x := v.(type) {
	case string:
		if n, ok := ids[x]; ok {
			return n
		}
	case map[string]any:
		for k, e := range x {
			x[k] = remap(e, ids)
		}
	case []any:
		for i, e := range x {
			x[i] = remap(e, ids)
		}
	}
	return v
}

// insertOrder sorts tables so referenced tables come first (self references handled per row).
func insertOrder(tables []string, fks map[string]map[string]string) []string {
	var out []string
	done := map[string]bool{}
	for len(out) < len(tables) {
		progressed := false
		for _, t := range tables {
			if done[t] {
				continue
			}
			ready := true
			for _, ref := range fks[t] {
				if ref != t && slices.Contains(tables, ref) && !done[ref] {
					ready = false
				}
			}
			if ready {
				done[t], progressed = true, true
				out = append(out, t)
			}
		}
		if !progressed { // FK cycle between tables: keep remaining order; inserts will report it
			for _, t := range tables {
				if !done[t] {
					done[t] = true
					out = append(out, t)
				}
			}
		}
	}
	return out
}

// Restore loads an export into targetProfileID (which must exist and be empty), giving every row
// a new id so a backup can be restored next to the original or on another server. Users that do
// not exist here are replaced by restoredBy. Synced entities are re-recorded with changes.Record
// so devices download the restored data. Attachment contents (e.Files) are written to the attachment
// storage under the new ids. Returns row counts per table.
func Restore(ctx context.Context, tx pgx.Tx, cfg *config.Config, e *Export, targetProfileID, restoredBy uuid.UUID) (map[string]int, error) {
	if mode, _ := e.Profile["privacy_mode"].(string); mode == "e2ee" {
		return nil, httpx.NewError(http.StatusConflict, "e2ee_profile",
			"end-to-end encrypted profiles are restored by a client holding the key (ciphertext is bound to its ids)")
	}
	sv, err := schemaVersion(ctx, tx)
	if err != nil {
		return nil, err
	}
	if e.SchemaVersion > sv {
		return nil, httpx.NewError(http.StatusConflict, "backup_newer_than_server", "backup was made by a newer server version; upgrade first")
	}
	tables, err := dataTables(ctx, tx)
	if err != nil {
		return nil, err
	}
	for t := range e.Tables {
		if !slices.Contains(tables, t) {
			return nil, httpx.Unprocessable("backup contains unknown table " + t)
		}
	}
	fks, err := fkInfo(ctx, tx)
	if err != nil {
		return nil, err
	}

	// 1. decode rows, build the id map
	ids := map[string]string{}
	if old, ok := e.Profile["id"].(string); ok {
		ids[old] = targetProfileID.String()
	}
	rows := map[string][]map[string]any{}
	for t, raws := range e.Tables {
		for _, raw := range raws {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				return nil, httpx.Unprocessable("bad row in " + t)
			}
			if id, ok := m["id"].(string); ok {
				if _, dup := ids[id]; !dup {
					ids[id] = uuid.NewString()
				}
			}
			rows[t] = append(rows[t], m)
		}
	}
	// 2. users referenced by the backup that do not exist here become the restoring user
	userCols := func(t string) []string {
		var cols []string
		for col, ref := range fks[t] {
			if ref == "users" {
				cols = append(cols, col)
			}
		}
		return cols
	}
	known := map[string]bool{}
	for t, rs := range rows {
		for _, m := range rs {
			for _, col := range userCols(t) {
				if s, ok := m[col].(string); ok {
					known[s] = false
				}
			}
		}
	}
	if len(known) > 0 {
		var list []string
		for k := range known {
			list = append(list, k)
		}
		r, err := tx.Query(ctx, `SELECT id::text FROM users WHERE id::text = ANY($1)`, list)
		if err != nil {
			return nil, err
		}
		existing, err := pgx.CollectRows(r, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		for _, id := range existing {
			known[id] = true
		}
	}
	oldProfile, _ := e.Profile["id"].(string)
	files := map[string]*File{}
	for i := range e.Files {
		files[e.Files[i].AttachmentID] = &e.Files[i]
	}
	for t, rs := range rows {
		for _, m := range rs {
			old, _ := m["id"].(string)
			remap(m, ids)
			m["profile_id"] = targetProfileID.String()
			if _, ok := m["server_version"]; ok {
				m["server_version"] = 0
			}
			for _, col := range userCols(t) {
				if s, ok := m[col].(string); ok && !known[s] {
					m[col] = restoredBy.String()
				}
			}
			if t == "attachments" {
				if err := restoreFile(ctx, tx, cfg, m, files[old], old, oldProfile, targetProfileID); err != nil {
					return nil, err
				}
			}
		}
	}

	// 3. insert in dependency order
	counts := map[string]int{}
	var present []string
	for t := range rows {
		present = append(present, t)
	}
	slices.Sort(present)
	newIDs := map[string]bool{}
	for _, n := range ids {
		newIDs[n] = true
	}
	for _, t := range insertOrder(present, fks) {
		cols, err := tableColumns(ctx, tx, t)
		if err != nil {
			return nil, err
		}
		pending := rows[t]
		inserted := map[string]bool{}
		for len(pending) > 0 {
			var next []map[string]any
			for _, m := range pending {
				if !selfRefsReady(t, m, fks, inserted, newIDs) {
					next = append(next, m)
					continue
				}
				if err := insertRow(ctx, tx, t, cols, m); err != nil {
					return nil, err
				}
				if id, ok := m["id"].(string); ok {
					inserted[id] = true
				}
				counts[t]++
			}
			if len(next) == len(pending) {
				return nil, httpx.Unprocessable("backup has unresolvable references in " + t)
			}
			pending = next
		}
	}

	// 4. settings + sync log
	if len(e.Settings) > 0 && string(e.Settings) != "null" {
		if _, err := tx.Exec(ctx, `INSERT INTO settings (scope, owner_id, key, value) VALUES ('profile', $1, 'settings', $2)
			ON CONFLICT (scope, owner_id, key) DO UPDATE SET value = EXCLUDED.value`, targetProfileID, e.Settings); err != nil {
			return nil, err
		}
	}
	for _, s := range e.Snapshots {
		newID, ok := ids[s.EntityID.String()]
		if !ok || !slices.Contains(present, s.EntityType) {
			continue
		}
		var data any
		if err := json.Unmarshal(s.Data, &data); err != nil {
			return nil, httpx.Unprocessable("bad snapshot")
		}
		if _, err := changes.Record(ctx, tx, changes.Change{ProfileID: targetProfileID, EntityType: s.EntityType,
			EntityID: uuid.MustParse(newID), Op: changes.OpUpsert, Data: remap(data, ids), Action: s.EntityType + ".restore"}); err != nil {
			return nil, err
		}
	}
	return counts, nil
}

// restoreFile points an attachments row at its new storage key and writes the backup's content there
// (checksum verified). The key is always rebuilt from the new ids, so a crafted backup cannot point a
// row at another profile's file. Without a file in the backup (version 1), the content is copied from the
// original attachment when it still exists on this server in a profile the restoring user may read;
// otherwise the row keeps metadata only.
// ponytail: files written before a failed restore stay as unreferenced orphans under the rolled-back ids.
func restoreFile(ctx context.Context, tx pgx.Tx, cfg *config.Config, m map[string]any, f *File, oldID, oldProfile string, profileID uuid.UUID) error {
	id, _ := m["id"].(string)
	key := profileID.String() + "/" + id
	m["storage_key"] = key
	if m["deleted_at"] != nil {
		return nil
	}
	if f == nil {
		var err error
		if f, err = sourceFile(ctx, tx, cfg, oldID, oldProfile); f == nil {
			return err
		}
	}
	sum := sha256.Sum256(f.Data)
	hexSum := hex.EncodeToString(sum[:])
	row, _ := m["sha256"].(string)
	if !strings.EqualFold(f.SHA256, hexSum) || (row != "" && !strings.EqualFold(strings.TrimPrefix(row, `\x`), hexSum)) {
		return httpx.Unprocessable("attachment " + id + ": content checksum mismatch")
	}
	backend, ct, sealed, err := attachments.Store(ctx, cfg, key, f.Data)
	if err != nil {
		return fmt.Errorf("restore attachment content: %w", err)
	}
	m["storage_backend"], m["content_type"], m["server_encrypted"], m["size_bytes"] = backend, ct, sealed, len(f.Data)
	return nil
}

// sourceFile reads the original attachment's content from this server, or returns nil when it is gone
// or the restoring user is not a member of its profile.
func sourceFile(ctx context.Context, tx pgx.Tx, cfg *config.Config, oldID, oldProfile string) (*File, error) {
	pid, err := uuid.Parse(oldProfile)
	if err != nil {
		return nil, nil
	}
	if _, _, err := authz.RequireProfile(ctx, tx, pid, authz.RoleViewer); err != nil {
		return nil, nil
	}
	var backend, key string
	var sealed bool
	var sum []byte
	err = tx.QueryRow(ctx, `SELECT storage_backend, storage_key, server_encrypted, sha256 FROM attachments
		WHERE id::text = $1 AND profile_id = $2 AND deleted_at IS NULL`, oldID, pid).Scan(&backend, &key, &sealed, &sum)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	data, err := attachments.Content(ctx, cfg, backend, key, sealed, 1<<40)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("copy attachment %s: %w", oldID, err)
	}
	return &File{AttachmentID: oldID, SHA256: hex.EncodeToString(sum), Data: data}, nil
}

func selfRefsReady(t string, m map[string]any, fks map[string]map[string]string, inserted, newIDs map[string]bool) bool {
	for col, ref := range fks[t] {
		if ref != t {
			continue
		}
		if v, ok := m[col].(string); ok && !inserted[v] && v != m["id"] {
			// a reference to a row outside the backup cannot be satisfied: drop it rather than fail
			if !newIDs[v] {
				m[col] = nil
				continue
			}
			return false
		}
	}
	return true
}

func tableColumns(ctx context.Context, q querier, t string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
		AND is_generated = 'NEVER' ORDER BY ordinal_position`, t)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// insertRow inserts the backup row; columns missing from an older backup keep their defaults.
func insertRow(ctx context.Context, tx pgx.Tx, t string, cols []string, m map[string]any) error {
	var use []string
	for _, c := range cols {
		if _, ok := m[c]; ok {
			use = append(use, pgx.Identifier{c}.Sanitize())
		}
	}
	list := strings.Join(use, ", ")
	tbl := pgx.Identifier{t}.Sanitize()
	_, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s, $1)`, tbl, list, list, tbl), m)
	if err != nil {
		return fmt.Errorf("restore %s: %w", t, err)
	}
	return nil
}
