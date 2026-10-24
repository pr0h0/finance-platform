// Package backups: Encrypted backups, restore, data export (portability).
//
// Owned routes under /api/v1: /backups, /export
// See docs/api/openapi.yaml for the contract and docs/api/export-format.md for the file format.
//
// Server backups are the gzip-compressed export JSON, encrypted at rest with AES-256-GCM using
// BACKUP_ENCRYPTION_KEY (encrypted_backups.encryption records the algorithm and key id, never key
// material). Without a key they are stored compressed only, and the metadata says alg "none".
// Passphrase-encrypted (E2EE) backups are produced client-side (ADR 0005) and never seen in clear here.
package backups

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/profiles"
)

const fileMagic = "FPB1" // FPB1 | 12-byte nonce | AES-256-GCM(gzip(export json)), AAD = backup id

// Backup is the OpenAPI Backup shape.
type Backup struct {
	ID            uuid.UUID       `json:"id"`
	ProfileID     *uuid.UUID      `json:"profileId"`
	Kind          string          `json:"kind"`
	FormatVersion int             `json:"formatVersion"`
	SchemaVersion int64           `json:"schemaVersion"`
	SizeBytes     int64           `json:"sizeBytes"`
	SHA256        string          `json:"sha256"`
	Encryption    json.RawMessage `json:"encryption"`
	Status        string          `json:"status"`
	CreatedAt     time.Time       `json:"createdAt"`
}

const cols = `id, profile_id, kind, format_version, schema_version, size_bytes, sha256, encryption, status, created_at`

func scan(row pgx.Row) (Backup, error) {
	var b Backup
	var sum []byte
	err := row.Scan(&b.ID, &b.ProfileID, &b.Kind, &b.FormatVersion, &b.SchemaVersion, &b.SizeBytes, &sum, &b.Encryption, &b.Status, &b.CreatedAt)
	b.SHA256 = hex.EncodeToString(sum)
	return b, err
}

// Service creates, reads and prunes server backups.
type Service struct {
	DB  *pgxpool.Pool
	Dir string
	Key []byte // nil = unencrypted
	Cfg *config.Config
}

func NewService(deps *app.Deps) (*Service, error) {
	s := &Service{DB: deps.DB, Dir: deps.Config.BackupDir, Cfg: deps.Config}
	if deps.Config.BackupKey != "" {
		k, err := base64.StdEncoding.DecodeString(deps.Config.BackupKey)
		if err != nil || len(k) != 32 {
			return nil, errors.New("BACKUP_ENCRYPTION_KEY must be base64 of 32 bytes")
		}
		s.Key = k
	}
	return s, nil
}

func (s *Service) keyID() string {
	h := sha256.Sum256(s.Key)
	return hex.EncodeToString(h[:4])
}

func (s *Service) path(id uuid.UUID) string { return filepath.Join(s.Dir, id.String()+".fpb") }

// Export is BuildExport plus the attachment contents.
func (s *Service) Export(ctx context.Context, profileID uuid.UUID) (*Export, error) {
	exp, err := BuildExport(ctx, s.DB, profileID)
	if err == nil {
		err = AddFiles(ctx, s.Cfg, exp)
	}
	return exp, err
}

// Create writes a backup of profileID owned by userID.
func (s *Service) Create(ctx context.Context, profileID, userID uuid.UUID, kind string) (Backup, error) {
	exp, err := s.Export(ctx, profileID)
	if err != nil {
		return Backup{}, err
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(exp); err != nil {
		return Backup{}, err
	}
	if err := zw.Close(); err != nil {
		return Backup{}, err
	}
	id := uuid.New()
	data := buf.Bytes()
	enc := map[string]any{"alg": "none", "compression": "gzip", "format": exportFormat}
	if s.Key != nil {
		if data, err = s.seal(id, data); err != nil {
			return Backup{}, err
		}
		enc = map[string]any{"alg": "aes-256-gcm", "keyId": s.keyID(), "keySource": "BACKUP_ENCRYPTION_KEY", "compression": "gzip", "format": exportFormat}
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return Backup{}, fmt.Errorf("backup dir: %w", err)
	}
	tmp := s.path(id) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return Backup{}, fmt.Errorf("write backup: %w", err)
	}
	if err := os.Rename(tmp, s.path(id)); err != nil {
		return Backup{}, err
	}
	sum := sha256.Sum256(data)
	b, err := scan(s.DB.QueryRow(ctx, `INSERT INTO encrypted_backups (id, user_id, profile_id, kind, format_version, schema_version,
		storage_backend, storage_key, size_bytes, sha256, encryption) VALUES ($1,$2,$3,$4,$5,$6,'local',$7,$8,$9,$10) RETURNING `+cols,
		id, userID, profileID, kind, exportFormatVersion, exp.SchemaVersion, filepath.Base(s.path(id)), len(data), sum[:], enc))
	if err != nil {
		_ = os.Remove(s.path(id))
		return b, err
	}
	return b, changes.Audit(ctx, s.DB, changes.Entry{ProfileID: &profileID, Action: "backup.create", EntityType: "encrypted_backups",
		EntityID: &id, Metadata: map[string]any{"kind": kind, "size_bytes": len(data), "encrypted": s.Key != nil}})
}

func (s *Service) seal(id uuid.UUID, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.Key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte(fileMagic), nonce...)
	return gcm.Seal(out, nonce, plain, id[:]), nil
}

// Open returns the decrypted (gzip) export of a backup after verifying its checksum.
func (s *Service) Open(ctx context.Context, b Backup) ([]byte, error) {
	data, err := os.ReadFile(s.path(b.ID))
	if err != nil {
		return nil, httpx.NewError(http.StatusGone, "backup_missing", "backup file is missing on the server")
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != b.SHA256 {
		return nil, httpx.NewError(http.StatusConflict, "backup_corrupt", "backup file checksum mismatch")
	}
	if !bytes.HasPrefix(data, []byte(fileMagic)) {
		return data, nil
	}
	if s.Key == nil {
		return nil, httpx.NewError(http.StatusConflict, "backup_key_missing", "backup is encrypted but BACKUP_ENCRYPTION_KEY is not configured")
	}
	block, err := aes.NewCipher(s.Key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	data = data[len(fileMagic):]
	if len(data) < gcm.NonceSize() {
		return nil, httpx.NewError(http.StatusConflict, "backup_corrupt", "backup file truncated")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], b.ID[:])
	if err != nil {
		return nil, httpx.NewError(http.StatusConflict, "backup_key_mismatch", "backup cannot be decrypted with the configured key")
	}
	return plain, nil
}

// RunScheduled backs up every live profile whose last scheduled backup is older than interval and
// prunes scheduled backups older than retention. An advisory lock keeps replicas from doubling up.
func (s *Service) RunScheduled(ctx context.Context, interval time.Duration, retentionDays int) (int, error) {
	conn, err := s.DB.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext('finplat.backups'))`).Scan(&locked); err != nil || !locked {
		return 0, err
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext('finplat.backups'))`)

	rows, err := s.DB.Query(ctx, `SELECT p.id, p.owner_user_id FROM profiles p WHERE p.deleted_at IS NULL AND NOT EXISTS (
		SELECT 1 FROM encrypted_backups b WHERE b.profile_id = p.id AND b.kind = 'scheduled' AND b.created_at > now() - make_interval(secs => $1))`,
		interval.Seconds())
	if err != nil {
		return 0, err
	}
	type due struct{ Profile, Owner uuid.UUID }
	list, err := pgx.CollectRows(rows, pgx.RowToStructByPos[due])
	if err != nil {
		return 0, err
	}
	n := 0
	for _, d := range list {
		if _, err := s.Create(ctx, d.Profile, d.Owner, "scheduled"); err != nil {
			return n, fmt.Errorf("scheduled backup %s: %w", d.Profile, err)
		}
		n++
	}
	if retentionDays > 0 {
		old, err := s.DB.Query(ctx, `DELETE FROM encrypted_backups WHERE kind = 'scheduled' AND created_at < now() - make_interval(days => $1)
			RETURNING id`, retentionDays)
		if err != nil {
			return n, err
		}
		ids, err := pgx.CollectRows(old, pgx.RowTo[uuid.UUID])
		if err != nil {
			return n, err
		}
		for _, id := range ids {
			_ = os.Remove(s.path(id))
		}
	}
	return n, nil
}

// Register mounts this module's routes on the /api/v1 router and starts the backup scheduler
// when JOBS_ENABLED and BACKUP_SCHEDULE (a Go duration, "off" disables) allow it.
func Register(r chi.Router, deps *app.Deps) {
	s, err := NewService(deps)
	if err != nil {
		deps.Log.Error("backups disabled", "err", err)
		r.HandleFunc("/backups*", httpx.H(func(http.ResponseWriter, *http.Request) error {
			return httpx.NewError(http.StatusServiceUnavailable, "backups_misconfigured", err.Error())
		}))
		return
	}
	if interval, err := time.ParseDuration(deps.Config.BackupSchedule); err == nil && interval > 0 && deps.Config.JobsEnabled {
		go schedule(deps.Log, s, interval, deps.Config.BackupRetentionDays)
	}
	db := deps.DB

	r.Get("/backups", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		rows, err := db.Query(r.Context(), `SELECT `+cols+` FROM encrypted_backups b WHERE user_id = $1
			AND (profile_id IS NULL OR EXISTS (SELECT 1 FROM profile_members m WHERE m.profile_id = b.profile_id AND m.user_id = $1 AND m.role = 'owner'))
			ORDER BY created_at DESC LIMIT 500`, p.UserID)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Backup, error) { return scan(row) })
		if err != nil {
			return err
		}
		if items == nil {
			items = []Backup{}
		}
		httpx.WriteJSON(w, http.StatusOK, httpx.List[Backup]{Items: items})
		return nil
	}))

	r.With(httpx.Idempotent(db)).Post("/backups", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		var in struct {
			ProfileID uuid.UUID `json:"profileId"`
		}
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		if _, _, err := authz.RequireProfile(r.Context(), db, in.ProfileID, authz.RoleOwner); err != nil {
			return err
		}
		b, err := s.Create(r.Context(), in.ProfileID, p.UserID, "manual")
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, b)
		return nil
	}))

	load := func(r *http.Request) (Backup, error) {
		p, err := userOnly(r)
		if err != nil {
			return Backup{}, err
		}
		id, err := uuid.Parse(chi.URLParam(r, "id"))
		if err != nil {
			return Backup{}, httpx.NotFound("backup")
		}
		b, err := scan(db.QueryRow(r.Context(), `SELECT `+cols+` FROM encrypted_backups WHERE id = $1 AND user_id = $2`, id, p.UserID))
		if errors.Is(err, pgx.ErrNoRows) {
			return b, httpx.NotFound("backup")
		}
		return b, err
	}

	r.Get("/backups/{id}/download", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		b, err := load(r)
		if err != nil {
			return err
		}
		data, err := s.Open(r.Context(), b)
		if err != nil {
			return err
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="finplat-backup-%s.json.gz"`, b.CreatedAt.UTC().Format("20060102-150405")))
		w.Header().Set("Cache-Control", "no-store")
		_, err = w.Write(data)
		return err
	}))

	r.Delete("/backups/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		b, err := load(r)
		if err != nil {
			return err
		}
		if _, err := db.Exec(r.Context(), `DELETE FROM encrypted_backups WHERE id = $1`, b.ID); err != nil {
			return err
		}
		if err := os.Remove(s.path(b.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := changes.Audit(r.Context(), db, changes.Entry{ProfileID: b.ProfileID, Action: "backup.delete", EntityType: "encrypted_backups", EntityID: &b.ID}); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.With(httpx.Idempotent(db)).Post("/backups/restore", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := userOnly(r)
		if err != nil {
			return err
		}
		httpx.UploadBody(w, r, deps.Config.MaxUploadBytes)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "backup larger than MAX_UPLOAD_BYTES")
			}
			return httpx.BadRequest("expected multipart/form-data with a file field")
		}
		defer r.MultipartForm.RemoveAll()
		f, _, err := r.FormFile("file")
		if err != nil {
			return httpx.Validation(map[string]string{"file": "required"})
		}
		defer f.Close()
		raw, err := io.ReadAll(f)
		if err != nil {
			return err
		}
		exp, err := ParseExport(raw)
		if err != nil {
			return err
		}
		ctx := r.Context()
		var target uuid.UUID
		if t := r.FormValue("targetProfileId"); t != "" {
			if target, err = uuid.Parse(t); err != nil {
				return httpx.Validation(map[string]string{"targetProfileId": "invalid uuid"})
			}
			if _, _, err := authz.RequireProfile(ctx, db, target, authz.RoleOwner); err != nil {
				return err
			}
			if err := s.requireEmpty(ctx, target); err != nil {
				return err
			}
			if _, err := s.Create(ctx, target, p.UserID, "pre_migration"); err != nil {
				return fmt.Errorf("pre-restore backup: %w", err)
			}
		}
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if target == uuid.Nil {
			name, _ := exp.Profile["name"].(string)
			in := profiles.Input{Name: truncate(name+" (restored)", 100)}
			for _, k := range []struct {
				dst **string
				key string
			}{{&in.BaseCurrency, "base_currency"}, {&in.Timezone, "timezone"}, {&in.Locale, "locale"}} {
				if v, ok := exp.Profile[k.key].(string); ok {
					*k.dst = &v
				}
			}
			if ws, ok := exp.Profile["week_start"].(float64); ok {
				n := int(ws)
				in.WeekStart = &n
			}
			pr, err := profiles.Create(ctx, tx, p.UserID, in)
			if err != nil {
				return err
			}
			target = pr.ID
		}
		counts, err := Restore(ctx, tx, deps.Config, exp, target, p.UserID)
		if err != nil {
			return err
		}
		if err := changes.Audit(ctx, tx, changes.Entry{ProfileID: &target, Action: "backup.restore", EntityType: "profiles", EntityID: &target,
			Metadata: map[string]any{"counts": counts, "schema_version": exp.SchemaVersion}}); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"profileId": target, "counts": counts})
		return nil
	}))

	r.Get("/export", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		exp, err := s.Export(r.Context(), profileID)
		if err != nil {
			return err
		}
		if err := changes.Audit(r.Context(), db, changes.Entry{ProfileID: &profileID, Action: "profile.export", EntityType: "profiles", EntityID: &profileID}); err != nil {
			return err
		}
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="finplat-export-%s.json"`, time.Now().UTC().Format("20060102")))
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSON(w, http.StatusOK, exp)
		return nil
	}))
}

func (s *Service) requireEmpty(ctx context.Context, profileID uuid.UUID) error {
	exp, err := BuildExport(ctx, s.DB, profileID)
	if err != nil {
		return err
	}
	if len(exp.Tables) > 0 {
		return httpx.NewError(http.StatusConflict, "profile_not_empty", "restore into an existing profile requires it to be empty; omit targetProfileId to restore as a new profile")
	}
	return nil
}

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func userOnly(r *http.Request) (authz.Principal, error) {
	p, err := authz.Require(r.Context())
	if err == nil && p.ActorType != authz.ActorUser {
		err = authz.ErrForbidden
	}
	return p, err
}

func schedule(log *slog.Logger, s *Service, interval time.Duration, retentionDays int) {
	tick := min(interval, 15*time.Minute)
	for {
		time.Sleep(tick)
		n, err := s.RunScheduled(context.Background(), interval, retentionDays)
		if err != nil {
			log.Error("scheduled backups failed", "err", err)
		} else if n > 0 {
			log.Info("scheduled backups created", "count", n)
		}
	}
}
