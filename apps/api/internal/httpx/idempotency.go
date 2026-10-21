package httpx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
)

// IdempotencyHeader is honoured on routes wrapped with Idempotent.
const IdempotencyHeader = "Idempotency-Key"

type recorder struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (r *recorder) WriteHeader(s int) { r.status = s; r.ResponseWriter.WriteHeader(s) }
func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	r.buf.Write(b)
	return r.ResponseWriter.Write(b)
}

// Idempotent makes a mutation safe to retry: the first response for (user, key) is stored for
// 24h and replayed for identical retries; a different body with the same key is rejected (422);
// a concurrent duplicate gets 409. 5xx responses are not stored so the client can retry.
// Requests without the header or without a principal pass through unchanged.
func Idempotent(db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get(IdempotencyHeader)
			p, ok := authz.FromContext(r.Context())
			if key == "" || !ok {
				next.ServeHTTP(w, r)
				return
			}
			if len(key) > 200 {
				WriteError(w, r, BadRequest("Idempotency-Key too long"))
				return
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				WriteError(w, r, NewError(http.StatusRequestEntityTooLarge, "payload_too_large", "request body too large"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			h := sha256.New()
			h.Write([]byte(r.Method + " " + r.URL.Path + "\n"))
			h.Write(body)
			hash := h.Sum(nil)
			ctx := r.Context()

			_, _ = db.Exec(ctx, `DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2 AND expires_at < now()`, p.UserID, key)
			tag, err := db.Exec(ctx, `INSERT INTO idempotency_keys (user_id, key, method, path, request_hash)
				VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, p.UserID, key, r.Method, r.URL.Path, hash)
			if err != nil {
				WriteError(w, r, err)
				return
			}
			if tag.RowsAffected() == 0 {
				replay(w, r, db, p, key, hash)
				return
			}
			rec := &recorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)
			// Store outcome with a fresh context: the client may have gone away.
			bg := context.WithoutCancel(ctx)
			if rec.status >= 500 || rec.status == 0 {
				_, _ = db.Exec(bg, `DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2`, p.UserID, key)
				return
			}
			_, _ = db.Exec(bg, `UPDATE idempotency_keys SET status_code=$3, response=$4, content_type=$5 WHERE user_id=$1 AND key=$2`,
				p.UserID, key, rec.status, rec.buf.Bytes(), w.Header().Get("Content-Type"))
		})
	}
}

func replay(w http.ResponseWriter, r *http.Request, db *pgxpool.Pool, p authz.Principal, key string, hash []byte) {
	var stored []byte
	var status *int
	var resp []byte
	var ctype *string
	err := db.QueryRow(r.Context(), `SELECT request_hash, status_code, response, content_type FROM idempotency_keys WHERE user_id=$1 AND key=$2`,
		p.UserID, key).Scan(&stored, &status, &resp, &ctype)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		WriteError(w, r, Conflict("idempotent request state changed; retry"))
	case err != nil:
		WriteError(w, r, err)
	case !bytes.Equal(stored, hash):
		WriteError(w, r, NewError(http.StatusUnprocessableEntity, "idempotency_key_reused", "Idempotency-Key was used with a different request"))
	case status == nil:
		WriteError(w, r, NewError(http.StatusConflict, "request_in_progress", "a request with this Idempotency-Key is in progress"))
	default:
		w.Header().Set("Idempotent-Replayed", "true")
		if ctype != nil && *ctype != "" {
			w.Header().Set("Content-Type", *ctype)
		}
		w.WriteHeader(*status)
		_, _ = w.Write(resp)
	}
}
