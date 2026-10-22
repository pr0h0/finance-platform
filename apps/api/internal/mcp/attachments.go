package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/attachments"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// get_attachments (read_attachments). Account/period restrictions apply through the attachment's
// transaction: restricted clients only see attachments of transactions they can see.

const maxAttachmentContent = 4 << 20

var contentTypes = []string{"image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"}

// fileResult is a tool result that also carries a file, sent as an MCP image or embedded resource
// next to the JSON text (the JSON part alone counts against maxResultBytes).
type fileResult struct {
	result any
	mime   string
	data   []byte
	uri    string
}

type attachmentOut struct {
	ID            uuid.UUID  `json:"id"`
	TransactionID *uuid.UUID `json:"transactionId"`
	BookingDate   *string    `json:"transactionDate"`
	FileName      string     `json:"fileName"`
	ContentType   string     `json:"contentType"`
	SizeBytes     int64      `json:"sizeBytes"`
	Purpose       string     `json:"purpose"`
	CreatedAt     time.Time  `json:"createdAt"`
	ContentNote   string     `json:"contentNote,omitempty"`
	e2ee          bool
	backend, key  string
	serverSealed  bool
}

func getAttachments(ctx context.Context, s *session, def *toolDef, raw json.RawMessage) (any, error) {
	var in struct {
		ProfileID      *uuid.UUID `json:"profileId"`
		TransactionID  *uuid.UUID `json:"transactionId"`
		AttachmentID   *uuid.UUID `json:"attachmentId"`
		IncludeContent bool       `json:"includeContent"`
		Limit          int        `json:"limit"`
	}
	if err := decodeArgs(def, raw, &in); err != nil {
		return nil, err
	}
	if in.IncludeContent && in.AttachmentID == nil {
		return nil, httpx.Validation(map[string]string{"includeContent": "requires attachmentId (one file per call)"})
	}
	pid := in.ProfileID
	if pid == nil && in.AttachmentID != nil {
		p, err := s.entityProfile(ctx, "attachments", *in.AttachmentID)
		if err != nil {
			return nil, err
		}
		pid = &p
	}
	v, err := s.view(ctx, pid, def.Scopes)
	if err != nil {
		return nil, err
	}
	var from, to *string
	if v.From != nil {
		f := v.From.Format(time.DateOnly)
		from = &f
	}
	if v.To != nil {
		t := v.To.Format(time.DateOnly)
		to = &t
	}
	// server_encrypted is read through to_jsonb so this works before and after that column exists.
	rows, err := s.db.Query(ctx, `SELECT a.id, a.transaction_id, t.booking_date::text, a.file_name, a.content_type, a.size_bytes, a.purpose, a.created_at,
			a.is_encrypted, a.storage_backend, a.storage_key, coalesce((to_jsonb(a)->>'server_encrypted')::boolean, false)
		FROM attachments a LEFT JOIN transactions t ON t.id = a.transaction_id AND t.deleted_at IS NULL
		WHERE a.profile_id = $1 AND a.deleted_at IS NULL AND ($2::uuid IS NULL OR a.id = $2) AND ($3::uuid IS NULL OR a.transaction_id = $3)
		  AND ($4::uuid[] IS NULL OR EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.account_id = ANY($4)))
		  AND ($5::date IS NULL OR t.booking_date >= $5) AND ($6::date IS NULL OR t.booking_date <= $6)
		ORDER BY a.created_at DESC, a.id LIMIT $7`, v.P.ID, in.AttachmentID, in.TransactionID, v.AccountIDs, from, to, in.Limit+1)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (attachmentOut, error) {
		var a attachmentOut
		err := r.Scan(&a.ID, &a.TransactionID, &a.BookingDate, &a.FileName, &a.ContentType, &a.SizeBytes, &a.Purpose, &a.CreatedAt,
			&a.e2ee, &a.backend, &a.key, &a.serverSealed)
		return a, err
	})
	if err != nil {
		return nil, err
	}
	m := newMeta()
	if len(list) > in.Limit {
		list = list[:in.Limit]
		m.Complete = false
		m.warn("more attachments exist; filter by transactionId or raise limit")
	}
	if in.AttachmentID != nil && len(list) == 0 {
		return nil, httpx.NotFound("attachment")
	}
	out := map[string]any{"attachments": list, "meta": m}
	if !in.IncludeContent {
		return out, nil
	}
	a := &list[0]
	data, note := s.readAttachment(ctx, a)
	a.ContentNote = note
	if data == nil {
		m.Complete = false
		m.warn("content not included: " + note)
		return out, nil
	}
	return &fileResult{result: out, mime: a.ContentType, data: data, uri: "attachment://" + a.ID.String() + "/" + a.FileName}, nil
}

// readAttachment returns the plaintext content (local or S3, server-side encryption undone), or nil
// and the reason it cannot be shared.
func (s *session) readAttachment(ctx context.Context, a *attachmentOut) ([]byte, string) {
	switch {
	case a.e2ee:
		return nil, "end-to-end encrypted: only your devices can decrypt it"
	case !slices.Contains(contentTypes, strings.ToLower(a.ContentType)):
		return nil, "only images and PDFs are returned"
	case a.SizeBytes > maxAttachmentContent:
		return nil, "file is larger than 4 MiB"
	case s.cfg == nil:
		return nil, "the file's storage is not readable by the MCP server"
	}
	data, err := attachments.Content(ctx, s.cfg, a.backend, a.key, a.serverSealed, maxAttachmentContent)
	if errors.Is(err, os.ErrNotExist) {
		return nil, "file content is missing on the server"
	}
	if err != nil {
		return nil, "file could not be read"
	}
	return data, "included"
}
