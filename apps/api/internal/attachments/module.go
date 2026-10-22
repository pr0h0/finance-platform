// Package attachments: File uploads/downloads (receipts, statements).
//
// Files are stored on the local volume (ATTACHMENTS_DIR) under <profile id>/<attachment id>: the path is
// built only from server-generated UUIDs, never from the client file name, so it cannot traverse.
// Types are sniffed from content (not trusted from the client) against an allowlist.
//
// Owned routes under /api/v1: /attachments
// See docs/api/openapi.yaml for the contract.
package attachments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
)

type Attachment struct {
	ledger.Meta
	TransactionID *uuid.UUID `json:"transactionId"`
	FileName      string     `json:"fileName"`
	ContentType   string     `json:"contentType"`
	SizeBytes     int64      `json:"sizeBytes"`
	SHA256        string     `json:"sha256"`
	IsEncrypted   bool       `json:"isEncrypted"`
	Purpose       string     `json:"purpose"`
	storageKey    string
}

// allowed maps sniffed content types (http.DetectContentType) to the stored type.
var allowed = map[string]string{
	"image/jpeg": "image/jpeg", "image/png": "image/png", "image/gif": "image/gif", "image/webp": "image/webp",
	"application/pdf": "application/pdf", "text/plain; charset=utf-8": "text/plain; charset=utf-8",
}

var keyRE = regexp.MustCompile(`^[0-9a-f-]{36}/[0-9a-f-]{36}$`)

var entity = ledger.Entity[Attachment]{
	Table: "attachments", Name: "attachment",
	Cols:    "transaction_id, file_name, content_type, size_bytes, sha256, is_encrypted, purpose, storage_key",
	GetMeta: func(a *Attachment) *ledger.Meta { return &a.Meta },
	Scan: func(row pgx.Row) (*Attachment, error) {
		a := &Attachment{}
		var sum []byte
		err := row.Scan(append(a.Dest(), &a.TransactionID, &a.FileName, &a.ContentType, &a.SizeBytes, &sum, &a.IsEncrypted, &a.Purpose, &a.storageKey)...)
		a.SHA256 = hex.EncodeToString(sum)
		return a, err
	},
}

// SafeFileName keeps only the base name, drops control characters and bounds the length. It is
// display metadata only; it is never used to build a path.
func SafeFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '"' {
			return -1
		}
		return r
	}, name)
	if name == "." || name == "/" || name == ".." || strings.TrimSpace(name) == "" {
		name = "attachment"
	}
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}

func validPurpose(p string) bool {
	return p == "receipt" || p == "statement" || p == "document" || p == "other"
}

func checkTransaction(ctx context.Context, db ledger.DB, profileID uuid.UUID, id *uuid.UUID) error {
	if id == nil {
		return nil
	}
	ok, err := ledger.Owned(ctx, db, "transactions", profileID, []uuid.UUID{*id})
	if err == nil && !ok {
		err = httpx.Validation(map[string]string{"transactionId": "unknown transaction"})
	}
	return err
}

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	db, cfg := deps.DB, deps.Config

	// The upload limit must be raised before Idempotent buffers the body (it reads it first).
	upload := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			httpx.UploadBody(w, r, cfg.MaxUploadBytes+64<<10)
			next.ServeHTTP(w, r)
		})
	}
	r.With(upload, httpx.Idempotent(db)).Post("/attachments", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, p, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		if cfg.StorageBackend != "local" {
			return httpx.NewError(http.StatusNotImplemented, "storage_unavailable", "only STORAGE_BACKEND=local is implemented")
		}
		mr, err := r.MultipartReader()
		if err != nil {
			return httpx.BadRequest("expected multipart/form-data")
		}
		dir := filepath.Join(cfg.AttachmentsDir, profileID.String())
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("attachments dir: %w", err)
		}
		a := &Attachment{Purpose: "receipt"}
		a.ID = uuid.New()
		var tmp string
		defer func() {
			if tmp != "" {
				_ = os.Remove(tmp)
			}
		}()
		for {
			part, err := mr.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return tooLarge(err, "invalid multipart body")
			}
			switch part.FormName() {
			case "file":
				if tmp != "" {
					return httpx.Validation(map[string]string{"file": "exactly one file"})
				}
				a.FileName = SafeFileName(part.FileName())
				if tmp, err = store(part, dir, cfg.MaxUploadBytes, a); err != nil {
					return err
				}
			case "transactionId", "purpose", "id":
				v, _ := io.ReadAll(io.LimitReader(part, 100))
				s := strings.TrimSpace(string(v))
				if part.FormName() == "purpose" {
					a.Purpose = s
				} else if part.FormName() == "id" { // client-chosen id: a connected device uploading its local attachment
					id, err := uuid.Parse(s)
					if err != nil || tmp != "" {
						return httpx.Validation(map[string]string{"id": "a uuid, sent before the file"})
					}
					a.ID = id
				} else if s != "" {
					id, err := uuid.Parse(s)
					if err != nil {
						return httpx.Validation(map[string]string{"transactionId": "invalid uuid"})
					}
					a.TransactionID = &id
				}
			default:
				return httpx.Validation(map[string]string{part.FormName(): "unknown field"})
			}
		}
		if tmp == "" {
			return httpx.Validation(map[string]string{"file": "required"})
		}
		if !validPurpose(a.Purpose) {
			return httpx.Validation(map[string]string{"purpose": "receipt, statement, document or other"})
		}
		if err := checkTransaction(r.Context(), db, profileID, a.TransactionID); err != nil {
			return err
		}
		key := profileID.String() + "/" + a.ID.String()
		var out *Attachment
		err = ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			sum, _ := hex.DecodeString(a.SHA256)
			if _, err := tx.Exec(r.Context(), `INSERT INTO attachments (id, profile_id, transaction_id, file_name, content_type, size_bytes,
				sha256, storage_backend, storage_key, purpose, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'local',$8,$9,$10)`,
				a.ID, profileID, a.TransactionID, a.FileName, a.ContentType, a.SizeBytes, sum, key, a.Purpose, p.UserID); err != nil {
				if pe := (*pgconn.PgError)(nil); errors.As(err, &pe) && pe.Code == "23505" {
					return httpx.Conflict("an attachment with this id already exists")
				}
				return err
			}
			if err := os.Rename(tmp, filepath.Join(cfg.AttachmentsDir, key)); err != nil {
				return fmt.Errorf("store attachment: %w", err)
			}
			tmp = ""
			out, err = entity.Record(r.Context(), tx, profileID, a.ID, changes.OpUpsert, nil, "create")
			if err != nil {
				_ = os.Remove(filepath.Join(cfg.AttachmentsDir, key))
			}
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, out)
		return nil
	}))

	r.Get("/attachments", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		page, err := httpx.ParsePage(r, 100, 500)
		if err != nil {
			return err
		}
		var c struct {
			N int `json:"n"`
		}
		if err := httpx.DecodeCursor(page.Cursor, &c); err != nil {
			return err
		}
		var txID *uuid.UUID
		if s := r.URL.Query().Get("transactionId"); s != "" {
			id, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation(map[string]string{"transactionId": "invalid uuid"})
			}
			txID = &id
		}
		rows, err := db.Query(r.Context(), `SELECT `+ledger.MetaCols+`, `+entity.Cols+` FROM attachments
			WHERE profile_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR transaction_id = $2)
			ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`, profileID, txID, page.Limit+1, c.N)
		if err != nil {
			return err
		}
		defer rows.Close()
		out := httpx.List[*Attachment]{Items: []*Attachment{}}
		for rows.Next() {
			a, err := entity.Scan(rows)
			if err != nil {
				return err
			}
			out.Items = append(out.Items, a)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(out.Items) > page.Limit {
			out.Items = out.Items[:page.Limit]
			out.NextCursor = httpx.EncodeCursor(struct {
				N int `json:"n"`
			}{c.N + page.Limit})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Get("/attachments/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		a, _, err := fromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, a)
		return nil
	}))

	r.Patch("/attachments/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "attachment")
		if err != nil {
			return err
		}
		var out *Attachment
		err = ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			cur, err := entity.Get(r.Context(), tx, profileID, id, true)
			if err != nil {
				return err
			}
			in := struct {
				TransactionID *uuid.UUID `json:"transactionId"`
				Purpose       string     `json:"purpose"`
				FileName      string     `json:"fileName"`
				Version       int        `json:"version"`
			}{cur.TransactionID, cur.Purpose, cur.FileName, 0}
			keys, err := ledger.DecodePatch(r, &in)
			if err != nil {
				return err
			}
			if !keys["version"] {
				return httpx.Validation(map[string]string{"version": "required"})
			}
			if in.Version != cur.Version {
				return ledger.VersionConflict(cur.Version)
			}
			if !validPurpose(in.Purpose) {
				return httpx.Validation(map[string]string{"purpose": "receipt, statement, document or other"})
			}
			if err := checkTransaction(r.Context(), tx, profileID, in.TransactionID); err != nil {
				return err
			}
			if _, err := tx.Exec(r.Context(), `UPDATE attachments SET transaction_id=$2, purpose=$3, file_name=$4, version = version + 1 WHERE id = $1`,
				id, in.TransactionID, in.Purpose, SafeFileName(in.FileName)); err != nil {
				return err
			}
			out, err = entity.Record(r.Context(), tx, profileID, id, changes.OpUpsert, cur, "update")
			return err
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	r.Delete("/attachments/{id}", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		profileID, _, err := authz.ProfileFromRequest(r, db, authz.RoleEditor)
		if err != nil {
			return err
		}
		id, err := ledger.IDParam(r, "id", "attachment")
		if err != nil {
			return err
		}
		var key string
		err = ledger.InTx(r.Context(), db, func(tx pgx.Tx) error {
			cur, err := entity.Get(r.Context(), tx, profileID, id, true)
			if err != nil {
				return err
			}
			key = cur.storageKey
			if _, err := tx.Exec(r.Context(), `UPDATE attachments SET deleted_at = now(), version = version + 1 WHERE id = $1`, id); err != nil {
				return err
			}
			_, err = entity.Record(r.Context(), tx, profileID, id, changes.OpDelete, cur, "delete")
			return err
		})
		if err != nil {
			return err
		}
		// The tombstone stays for sync; the content is removed (privacy) once the delete is committed.
		if keyRE.MatchString(key) {
			_ = os.Remove(filepath.Join(cfg.AttachmentsDir, key))
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}))

	r.Get("/attachments/{id}/content", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		a, _, err := fromRequest(r, db, authz.RoleViewer)
		if err != nil {
			return err
		}
		if !keyRE.MatchString(a.storageKey) {
			return httpx.NotFound("attachment content")
		}
		f, err := os.Open(filepath.Join(cfg.AttachmentsDir, a.storageKey))
		if errors.Is(err, os.ErrNotExist) {
			return httpx.NotFound("attachment content")
		}
		if err != nil {
			return err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return err
		}
		h := w.Header()
		h.Set("Content-Type", a.ContentType)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
		h.Set("Cache-Control", "private, max-age=0")
		disp := "attachment"
		if r.URL.Query().Get("inline") == "1" && a.ContentType != "text/plain; charset=utf-8" {
			disp = "inline"
		}
		h.Set("Content-Disposition", disp+"; filename*=UTF-8''"+url.PathEscape(a.FileName))
		http.ServeContent(w, r, "", st.ModTime(), f)
		return nil
	}))
}

func fromRequest(r *http.Request, db ledger.DB, min authz.Role) (*Attachment, uuid.UUID, error) {
	profileID, _, err := authz.ProfileFromRequest(r, db, min)
	if err != nil {
		return nil, uuid.Nil, err
	}
	id, err := ledger.IDParam(r, "id", "attachment")
	if err != nil {
		return nil, uuid.Nil, err
	}
	a, err := entity.Get(r.Context(), db, profileID, id, false)
	return a, profileID, err
}

func tooLarge(err error, msg string) error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "file too large")
	}
	return httpx.BadRequest(msg)
}

// store streams the file part to a temp file in dir, hashing and sniffing it, and enforcing max bytes.
func store(part *multipart.Part, dir string, max int64, a *Attachment) (string, error) {
	f, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return "", fmt.Errorf("temp file: %w", err)
	}
	name := f.Name()
	defer f.Close()
	h := sha256.New()
	head := make([]byte, 512)
	n, err := io.ReadFull(part, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		_ = os.Remove(name)
		return "", tooLarge(err, "upload interrupted")
	}
	head = head[:n]
	ct, ok := allowed[http.DetectContentType(head)]
	if !ok || n == 0 {
		_ = os.Remove(name)
		return "", httpx.NewError(http.StatusUnsupportedMediaType, "unsupported_file_type",
			"allowed: JPEG, PNG, GIF, WebP, PDF, plain text")
	}
	size, err := io.Copy(io.MultiWriter(f, h), io.MultiReader(strings.NewReader(string(head)), io.LimitReader(part, max-int64(n)+1)))
	if err != nil {
		_ = os.Remove(name)
		return "", tooLarge(err, "upload interrupted")
	}
	if size > max {
		_ = os.Remove(name)
		return "", httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "file too large")
	}
	if err := f.Sync(); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	a.ContentType, a.SizeBytes, a.SHA256 = ct, size, hex.EncodeToString(h.Sum(nil))
	return name, nil
}
