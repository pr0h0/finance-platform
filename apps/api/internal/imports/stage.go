package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// ParseRequest is a server-side import: raw file bytes parsed by a bundled Go importer.
type ParseRequest struct {
	ProfileID, UserID, AccountID uuid.UUID
	ImporterID                   string // empty = detect
	TemplateID                   *uuid.UUID
	FileName                     string
	Bytes                        []byte
	ReprocessedFrom              *uuid.UUID
}

func blockedErr(id string) error {
	return &httpx.Error{Status: 422, Code: "importer_blocked_external",
		Message: "importer " + id + " is not available yet: its statement format has not been provided (BLOCKED_EXTERNAL)"}
}

// ParseAndStage runs a bundled parser and stages the result (connected mode, MCP, reprocessing).
func ParseAndStage(ctx context.Context, db *pgxpool.Pool, req ParseRequest, maxBytes int64) (Batch, error) {
	if int64(len(req.Bytes)) > maxBytes {
		return Batch{}, httpx.NewError(413, "payload_too_large", "file exceeds the upload limit")
	}
	name, data, err := unwrapZip(req.FileName, req.Bytes, maxBytes)
	if err != nil {
		if errors.Is(err, ErrTooLarge) {
			return Batch{}, httpx.NewError(413, "payload_too_large", "archive content exceeds the upload limit or compression-ratio limit")
		}
		return Batch{}, &httpx.Error{Status: 422, Code: "invalid_file", Message: err.Error()}
	}
	var tmpl *Template
	importerID := req.ImporterID
	if req.TemplateID != nil {
		t, err := getTemplate(ctx, db, req.ProfileID, *req.TemplateID)
		if err != nil {
			return Batch{}, err
		}
		var fe map[string]string
		if tmpl, fe = ParseTemplate(t.Definition); fe != nil {
			return Batch{}, httpx.Validation(fe)
		}
		if importerID == "" {
			importerID = t.ImporterID
		}
	}
	if isBlocked(importerID) {
		return Batch{}, blockedErr(importerID)
	}
	var imp *Importer
	if importerID != "" {
		if imp = findImporter(importerID); imp == nil {
			return Batch{}, httpx.Validation(map[string]string{"importerId": "unknown importer"})
		}
	} else if imp = Detect(name, data, tmpl != nil); imp == nil {
		return Batch{}, &httpx.Error{Status: 422, Code: "format_not_detected", Message: "could not detect the file format; choose an importer (CSV needs a template)"}
	}
	acc, err := loadAccount(ctx, db, req.ProfileID, req.AccountID)
	if err != nil {
		return Batch{}, err
	}
	res, err := imp.parse(data, ParseContext{AccountCurrency: acc.Currency, Template: tmpl})
	if err != nil {
		code := "parse_failed"
		if errors.Is(err, errTemplateRequired) {
			code = "template_required"
		}
		return Batch{}, &httpx.Error{Status: 422, Code: code, Message: err.Error()}
	}
	res.ImporterID, res.ImporterVersion = imp.ID, imp.Version
	return Stage(ctx, db, StageInput{ProfileID: req.ProfileID, UserID: req.UserID, AccountID: req.AccountID, Importer: imp.ID,
		ImporterVersion: imp.Version, TemplateID: req.TemplateID, FileName: name, Source: req.Bytes, Encoding: res.Encoding, Result: res,
		ReprocessedFrom: req.ReprocessedFrom})
}

// ---------- templates ----------

type TemplateRow struct {
	ID            uuid.UUID       `json:"id"`
	ProfileID     *uuid.UUID      `json:"profileId"`
	Version       int             `json:"version"`
	ServerVersion int64           `json:"serverVersion"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	DeletedAt     *time.Time      `json:"deletedAt"`
	ImporterID    string          `json:"importerId"`
	Name          string          `json:"name"`
	BankName      string          `json:"bankName"`
	Country       *string         `json:"country"`
	SchemaVersion int             `json:"schemaVersion"`
	TemplateVer   string          `json:"templateVersion"`
	Format        string          `json:"format"`
	Definition    json.RawMessage `json:"definition"`
	IsCommunity   bool            `json:"isCommunity"`
}

const tmplCols = `id, profile_id, version, server_version, created_at, updated_at, deleted_at, importer_id, name, bank_name, country,
	schema_version, template_version, format, definition, is_community`

func scanTemplate(row pgx.Row) (TemplateRow, error) {
	var t TemplateRow
	err := row.Scan(&t.ID, &t.ProfileID, &t.Version, &t.ServerVersion, &t.CreatedAt, &t.UpdatedAt, &t.DeletedAt, &t.ImporterID, &t.Name,
		&t.BankName, &t.Country, &t.SchemaVersion, &t.TemplateVer, &t.Format, &t.Definition, &t.IsCommunity)
	if t.Country != nil {
		c := strings.TrimSpace(*t.Country)
		t.Country = &c
	}
	return t, err
}

// getTemplate returns a template of the profile or a server-wide (community) one.
func getTemplate(ctx context.Context, q Querier, profileID, id uuid.UUID) (TemplateRow, error) {
	t, err := scanTemplate(q.QueryRow(ctx, `SELECT `+tmplCols+` FROM import_templates
		WHERE id = $1 AND (profile_id = $2 OR profile_id IS NULL) AND deleted_at IS NULL`, id, profileID))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, httpx.NotFound("import template")
	}
	return t, err
}

type TemplateInput struct {
	ID         *uuid.UUID      `json:"id,omitempty"`
	ImporterID string          `json:"importerId"`
	Name       string          `json:"name"`
	BankName   string          `json:"bankName"`
	Country    *string         `json:"country"`
	Format     string          `json:"format"`
	Definition json.RawMessage `json:"definition"`
	Version    *int            `json:"version,omitempty"`
}

var templateFormats = map[string]bool{"csv": true, "tsv": true, "xlsx": true, "ofx": true, "qif": true, "camt053": true, "mt940": true, "pdf": true, "json": true, "other": true}

func (in *TemplateInput) validate() map[string]string {
	errs := map[string]string{}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 200 {
		errs["name"] = "required, at most 200 characters"
	}
	if in.ImporterID == "" || len(in.ImporterID) > 100 {
		errs["importerId"] = "required"
	}
	if !templateFormats[in.Format] {
		errs["format"] = "unsupported format"
	}
	if len(in.BankName) > 200 {
		errs["bankName"] = "too long"
	}
	if in.Country != nil && len(*in.Country) != 2 {
		errs["country"] = "must be an ISO 3166 alpha-2 code"
	}
	if len(in.Definition) == 0 || in.Definition[0] != '{' {
		errs["definition"] = "must be an object"
	} else if len(in.Definition) > 64<<10 {
		errs["definition"] = "too large"
	} else if in.Format == "csv" || in.Format == "tsv" || in.Format == "xlsx" || in.Format == "pdf" {
		t, fe := ParseTemplate(in.Definition)
		for k, v := range fe {
			errs[k] = v
		}
		if t != nil && t.Format != in.Format {
			errs["format"] = "must equal definition.format"
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return errs
}

func saveTemplate(ctx context.Context, db *pgxpool.Pool, profileID uuid.UUID, id *uuid.UUID, in TemplateInput) (TemplateRow, error) {
	if fe := in.validate(); fe != nil {
		return TemplateRow{}, httpx.Validation(fe)
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return TemplateRow{}, err
	}
	defer tx.Rollback(ctx)
	var t TemplateRow
	action := "import_template.create"
	if id == nil {
		newID := uuid.New()
		if in.ID != nil {
			newID = *in.ID
		}
		t, err = scanTemplate(tx.QueryRow(ctx, `INSERT INTO import_templates (id, profile_id, importer_id, name, bank_name, country, format, definition)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING `+tmplCols,
			newID, profileID, in.ImporterID, in.Name, in.BankName, in.Country, in.Format, in.Definition))
		if errors.Is(err, pgx.ErrNoRows) {
			return t, httpx.Conflict("id already exists")
		}
	} else {
		action = "import_template.update"
		var cur int
		if err := tx.QueryRow(ctx, `SELECT version FROM import_templates WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL FOR UPDATE`,
			*id, profileID).Scan(&cur); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return t, httpx.NotFound("import template") // community templates are read-only
			}
			return t, err
		}
		if in.Version != nil && *in.Version != cur {
			return t, httpx.Conflict("version mismatch")
		}
		t, err = scanTemplate(tx.QueryRow(ctx, `UPDATE import_templates SET importer_id = $3, name = $4, bank_name = $5, country = $6, format = $7,
			definition = $8, version = version + 1 WHERE id = $1 AND profile_id = $2 RETURNING `+tmplCols,
			*id, profileID, in.ImporterID, in.Name, in.BankName, in.Country, in.Format, in.Definition))
	}
	if err != nil {
		return t, fmt.Errorf("save template: %w", err)
	}
	v, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "import_templates", EntityID: t.ID, Op: changes.OpUpsert,
		Data: t, Action: action})
	if err != nil {
		return t, err
	}
	t.ServerVersion = v
	return t, tx.Commit(ctx)
}

func deleteTemplate(ctx context.Context, db *pgxpool.Pool, profileID, id uuid.UUID) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE import_templates SET deleted_at = now(), version = version + 1 WHERE id = $1 AND profile_id = $2 AND deleted_at IS NULL`, id, profileID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("import template")
	}
	if _, err := changes.Record(ctx, tx, changes.Change{ProfileID: profileID, EntityType: "import_templates", EntityID: id, Op: changes.OpDelete,
		Action: "import_template.delete"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
