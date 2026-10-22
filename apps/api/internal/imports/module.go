// Package imports: Importer registry, staging, preview, commit, rollback, reprocessing, templates,
// coverage and the uncategorized inbox (Features 14, 101, 110–130).
//
// Owned routes under /api/v1: /imports, /importers, /import-templates
// See docs/api/openapi.yaml for the contract and docs/importing/ for formats and templates.
//
// Two ways in:
//   - multipart upload (connected mode, MCP, scripts): a bundled Go parser runs on the server;
//   - JSON {result, source, fileSha256, ...}: the web client parsed the file locally with the TS
//     importer SDK and sends the normalized ImportResult plus the original bytes as evidence.
//
// Both end in Stage: immutable raw records + dedupe/match outcomes + reconciliation, then an
// explicit atomic Commit. Rollback only touches transactions the batch created.
package imports

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	h := &handlers{deps: deps}
	sync.RegisterEntity("import_batches", syncEntity)
	idem := httpx.Idempotent(deps.DB)
	upload := func(next http.Handler) http.Handler { // raise the body limit before Idempotent reads it
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			httpx.UploadBody(w, r, h.uploadLimit())
			next.ServeHTTP(w, r)
		})
	}
	r.Get("/importers", httpx.H(h.importers))
	r.Get("/import-templates", httpx.H(h.listTemplates))
	r.With(idem).Post("/import-templates", httpx.H(h.createTemplate))
	r.Get("/import-templates/{id}", httpx.H(h.getTemplate))
	r.Patch("/import-templates/{id}", httpx.H(h.updateTemplate))
	r.Delete("/import-templates/{id}", httpx.H(h.deleteTemplate))
	r.Get("/imports", httpx.H(h.list))
	r.With(upload, idem).Post("/imports", httpx.H(h.create))
	r.Get("/imports/coverage", httpx.H(h.coverage))
	r.Get("/imports/inbox", httpx.H(h.inbox))
	r.Get("/imports/{id}", httpx.H(h.get))
	r.Get("/imports/{id}/preview", httpx.H(h.preview))
	r.Get("/imports/{id}/records", httpx.H(h.records))
	r.Get("/imports/{id}/source", httpx.H(h.source))
	r.With(idem).Post("/imports/{id}/commit", httpx.H(h.commit))
	r.With(idem).Post("/imports/{id}/rollback", httpx.H(h.rollback))
	r.With(idem).Post("/imports/{id}/reprocess", httpx.H(h.reprocess))
}

type handlers struct{ deps *app.Deps }

// uploadLimit: the file limit plus room for base64 (client-parsed JSON) and multipart framing.
func (h *handlers) uploadLimit() int64 { return h.deps.Config.MaxUploadBytes*2 + 1<<20 }

func pathID(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return id, httpx.NotFound("resource")
	}
	return id, nil
}

func (h *handlers) importers(w http.ResponseWriter, r *http.Request) error {
	if _, err := authz.Require(r.Context()); err != nil {
		return err
	}
	items := make([]Manifest, 0, len(Registry)+len(Blocked))
	for _, i := range Registry {
		items = append(items, i.Manifest)
	}
	items = append(items, Blocked...)
	httpx.WriteJSON(w, http.StatusOK, httpx.List[Manifest]{Items: items})
	return nil
}

// ---------- templates ----------

func (h *handlers) listTemplates(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 100, 500)
	if err != nil {
		return err
	}
	var after struct{ ID uuid.UUID }
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT `+tmplCols+` FROM import_templates
		WHERE (profile_id = $1 OR profile_id IS NULL) AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT $3`, pid, after.ID, page.Limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := httpx.List[TemplateRow]{Items: []TemplateRow{}}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return err
		}
		out.Items = append(out.Items, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(out.Items) > page.Limit {
		out.Items = out.Items[:page.Limit]
		out.NextCursor = httpx.EncodeCursor(struct{ ID uuid.UUID }{out.Items[page.Limit-1].ID})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func (h *handlers) getTemplate(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	t, err := getTemplate(r.Context(), h.deps.DB, pid, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, t)
	return nil
}

func (h *handlers) createTemplate(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	var in TemplateInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	t, err := saveTemplate(r.Context(), h.deps.DB, pid, nil, in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, t)
	return nil
}

func (h *handlers) updateTemplate(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	var in TemplateInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	t, err := saveTemplate(r.Context(), h.deps.DB, pid, &id, in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, t)
	return nil
}

func (h *handlers) deleteTemplate(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	if err := deleteTemplate(r.Context(), h.deps.DB, pid, id); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- batches ----------

func (h *handlers) list(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 50, 200)
	if err != nil {
		return err
	}
	var after struct {
		At time.Time
		ID uuid.UUID
	}
	after.At = time.Now().Add(24 * time.Hour)
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	var accountID *uuid.UUID
	if s := r.URL.Query().Get("accountId"); s != "" {
		id, err := uuid.Parse(s)
		if err != nil {
			return httpx.Validation(map[string]string{"accountId": "invalid uuid"})
		}
		accountID = &id
	}
	var status *string
	if s := r.URL.Query().Get("status"); s != "" {
		status = &s
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT `+batchCols+` FROM import_batches
		WHERE profile_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR account_id = $2) AND ($3::text IS NULL OR status = $3)
		AND (created_at, id) < ($4, $5) ORDER BY created_at DESC, id DESC LIMIT $6`, pid, accountID, status, after.At, after.ID, page.Limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := httpx.List[Batch]{Items: []Batch{}}
	for rows.Next() {
		b, err := scanBatch(rows)
		if err != nil {
			return err
		}
		out.Items = append(out.Items, b)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(out.Items) > page.Limit {
		out.Items = out.Items[:page.Limit]
		last := out.Items[page.Limit-1]
		out.NextCursor = httpx.EncodeCursor(struct {
			At time.Time
			ID uuid.UUID
		}{last.CreatedAt, last.ID})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

func optUUID(s, field string, errs map[string]string) *uuid.UUID {
	if s == "" {
		return nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		errs[field] = "invalid uuid"
		return nil
	}
	return &id
}

// clientStage is the body of POST /imports when the web client parsed the file itself.
type clientStage struct {
	ID                     *uuid.UUID `json:"id,omitempty"` // client-chosen batch id (connected web upload of a local import)
	ImporterID             string     `json:"importerId"`
	ImporterVersion        string     `json:"importerVersion"`
	AccountID              uuid.UUID  `json:"accountId"`
	TemplateID             *uuid.UUID `json:"templateId,omitempty"`
	FileName               string     `json:"fileName"`
	FileSha256             string     `json:"fileSha256"`
	Source                 string     `json:"source"` // base64 of the original file (immutable evidence)
	Encoding               string     `json:"encoding,omitempty"`
	Result                 Result     `json:"result"`
	ReprocessedFromBatchID *uuid.UUID `json:"reprocessedFromBatchId,omitempty"`
}

func (h *handlers) create(w http.ResponseWriter, r *http.Request) error {
	pid, p, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	max := h.deps.Config.MaxUploadBytes
	var b Batch
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var in clientStage
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
		errs := map[string]string{}
		src, derr := base64.StdEncoding.DecodeString(in.Source)
		sum := sha256.Sum256(src)
		switch {
		case derr != nil || len(src) == 0:
			errs["source"] = "base64 of the original file is required"
		case int64(len(src)) > max:
			return httpx.NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "file exceeds the upload limit")
		case !strings.EqualFold(hex.EncodeToString(sum[:]), in.FileSha256):
			errs["fileSha256"] = "does not match the source bytes"
		}
		if in.ImporterID == "" || len(in.ImporterID) > 100 {
			errs["importerId"] = "required"
		}
		if in.ImporterVersion == "" || len(in.ImporterVersion) > 50 {
			errs["importerVersion"] = "required"
		}
		if in.FileName == "" || len(in.FileName) > 255 {
			errs["fileName"] = "required"
		}
		if in.AccountID == uuid.Nil {
			errs["accountId"] = "required"
		}
		if len(errs) > 0 {
			return httpx.Validation(errs)
		}
		if isBlocked(in.ImporterID) {
			return blockedErr(in.ImporterID)
		}
		if in.ReprocessedFromBatchID != nil {
			if _, err := getBatch(r.Context(), h.deps.DB, pid, *in.ReprocessedFromBatchID, false); err != nil {
				return err
			}
		}
		if in.TemplateID != nil {
			if _, err := getTemplate(r.Context(), h.deps.DB, pid, *in.TemplateID); err != nil {
				return err
			}
		}
		b, err = Stage(r.Context(), h.deps.DB, StageInput{ProfileID: pid, UserID: p.UserID, AccountID: in.AccountID, Importer: in.ImporterID,
			ImporterVersion: in.ImporterVersion, TemplateID: in.TemplateID, FileName: in.FileName, Source: src, Encoding: in.Encoding,
			Result: in.Result, ReprocessedFrom: in.ReprocessedFromBatchID, BatchID: in.ID})
	} else {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			return httpx.BadRequest("expected multipart/form-data with a file field, or application/json")
		}
		defer r.MultipartForm.RemoveAll()
		f, fh, ferr := r.FormFile("file")
		errs := map[string]string{}
		if ferr != nil {
			errs["file"] = "required"
		}
		accountID := optUUID(r.FormValue("accountId"), "accountId", errs)
		if accountID == nil && errs["accountId"] == "" {
			errs["accountId"] = "required"
		}
		templateID := optUUID(r.FormValue("templateId"), "templateId", errs)
		if len(errs) > 0 {
			return httpx.Validation(errs)
		}
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, max+1))
		if err != nil {
			return err
		}
		b, err = ParseAndStage(r.Context(), h.deps.DB, ParseRequest{ProfileID: pid, UserID: p.UserID, AccountID: *accountID,
			ImporterID: r.FormValue("importerId"), TemplateID: templateID, FileName: fh.Filename, Bytes: data}, max)
		if err != nil {
			return err
		}
	}
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, b)
	return nil
}

func (h *handlers) get(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	b, err := getBatch(r.Context(), h.deps.DB, pid, id, false)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, b)
	return nil
}

func (h *handlers) preview(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 200, 1000)
	if err != nil {
		return err
	}
	p, err := GetPreview(r.Context(), h.deps.DB, pid, id, page)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, p)
	return nil
}

func (h *handlers) records(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	if _, err := getBatch(r.Context(), h.deps.DB, pid, id, false); err != nil {
		return err
	}
	page, err := httpx.ParsePage(r, 200, 1000)
	if err != nil {
		return err
	}
	var after struct{ Row int }
	after.Row = -1
	if err := httpx.DecodeCursor(page.Cursor, &after); err != nil {
		return err
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT `+rawCols+` FROM imported_raw_records r
		WHERE r.import_batch_id = $1 AND r.profile_id = $2 AND r.row_number > $3 ORDER BY r.row_number, r.id LIMIT $4`, id, pid, after.Row, page.Limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := httpx.List[RawRecord]{Items: []RawRecord{}}
	for rows.Next() {
		rec, err := scanRaw(rows)
		if err != nil {
			return err
		}
		out.Items = append(out.Items, rec)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(out.Items) > page.Limit {
		out.Items = out.Items[:page.Limit]
		out.NextCursor = httpx.EncodeCursor(struct{ Row int }{out.Items[page.Limit-1].RowNumber})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

// source downloads the original file exactly as uploaded.
func (h *handlers) source(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	var content []byte
	var name string
	if err := h.deps.DB.QueryRow(r.Context(), `SELECT content, file_name FROM import_batch_sources WHERE import_batch_id = $1 AND profile_id = $2`,
		id, pid).Scan(&content, &name); err != nil {
		return httpx.NotFound("import source")
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(name)+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(content)
	return nil
}

func (h *handlers) commit(w http.ResponseWriter, r *http.Request) error {
	pid, p, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	var in CommitInput
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	b, err := Commit(r.Context(), h.deps.DB, pid, p.UserID, id, in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, b)
	return nil
}

func (h *handlers) rollback(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	b, err := Rollback(r.Context(), h.deps.DB, pid, id)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, b)
	return nil
}

func (h *handlers) reprocess(w http.ResponseWriter, r *http.Request) error {
	pid, p, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleEditor)
	if err != nil {
		return err
	}
	id, err := pathID(r)
	if err != nil {
		return err
	}
	b, err := Reprocess(r.Context(), h.deps.DB, pid, p.UserID, id, h.deps.Config.MaxUploadBytes)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, b)
	return nil
}

func parseUUIDList(s string) ([]uuid.UUID, error) {
	if s == "" {
		return nil, nil
	}
	var out []uuid.UUID
	for _, part := range strings.Split(s, ",") {
		id, err := uuid.Parse(strings.TrimSpace(part))
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

func parseOptDate(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, ok := parseISODate(s)
	if !ok {
		return nil, httpx.BadRequest("dates must be YYYY-MM-DD")
	}
	return &t, nil
}

func (h *handlers) coverage(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	ids, err := parseUUIDList(q.Get("accountIds"))
	if err != nil {
		return httpx.Validation(map[string]string{"accountIds": "comma-separated uuids"})
	}
	from, err := parseOptDate(q.Get("from"))
	if err != nil {
		return err
	}
	to, err := parseOptDate(q.Get("to"))
	if err != nil {
		return err
	}
	var f, t time.Time
	if from != nil {
		f = *from
	}
	if to != nil {
		t = *to
	}
	cov, err := Coverage(r.Context(), h.deps.DB, pid, ids, f, t)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"accounts": cov})
	return nil
}

func (h *handlers) inbox(w http.ResponseWriter, r *http.Request) error {
	pid, _, err := authz.ProfileFromRequest(r, h.deps.DB, authz.RoleViewer)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	page, err := httpx.ParsePage(r, 50, 500)
	if err != nil {
		return err
	}
	f := InboxFilter{Limit: page.Limit}
	if f.AccountIDs, err = parseUUIDList(q.Get("accountIds")); err != nil {
		return httpx.Validation(map[string]string{"accountIds": "comma-separated uuids"})
	}
	if f.From, err = parseOptDate(q.Get("from")); err != nil {
		return err
	}
	if f.To, err = parseOptDate(q.Get("to")); err != nil {
		return err
	}
	if page.Cursor != "" {
		f.After = &struct {
			Date string
			ID   uuid.UUID
		}{}
		if err := httpx.DecodeCursor(page.Cursor, f.After); err != nil {
			return err
		}
	}
	items, more, err := Uncategorized(r.Context(), h.deps.DB, pid, f)
	if err != nil {
		return err
	}
	out := httpx.List[InboxItem]{Items: items}
	if more {
		last := items[len(items)-1]
		out.NextCursor = httpx.EncodeCursor(struct {
			Date string
			ID   uuid.UUID
		}{last.BookingDate, last.ID})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}
