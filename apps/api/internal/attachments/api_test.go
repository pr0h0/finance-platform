package attachments

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

// Upload, download and delete through the API on S3 with encryption at rest (same path as local).
func TestAPIOnS3Encrypted(t *testing.T) {
	cfg := s3Config(t)
	cfg.AttachmentKey, cfg.MaxUploadBytes = testKey(), 1<<20
	pool := testdb.New(t)
	user, profile := testdb.SeedUserProfile(t, pool)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(authz.WithPrincipal(req.Context(), authz.Principal{UserID: user, ActorType: authz.ActorUser})))
		})
	})
	r.Route("/api/v1", func(v chi.Router) {
		Register(v, &app.Deps{Config: cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	})
	do := func(method, path string, body io.Reader, ct string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/v1"+path, body)
		req.Header.Set(authz.ProfileHeader, profile.String())
		req.Header.Set("Idempotency-Key", uuid.NewString())
		if ct != "" {
			req.Header.Set("Content-Type", ct)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "receipt.txt")
	_, _ = fw.Write([]byte("synthetic receipt total 12.50"))
	_ = mw.Close()
	rec := do("POST", "/attachments", &buf, mw.FormDataContentType())
	if rec.Code != 201 {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	var a struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	var backend string
	var sealed bool
	if err := pool.QueryRow(t.Context(), `SELECT storage_backend, server_encrypted FROM attachments WHERE id = $1`, a.ID).Scan(&backend, &sealed); err != nil || backend != "s3" || !sealed {
		t.Fatalf("row: %s %v %v", backend, sealed, err)
	}
	if rec := do("GET", "/attachments/"+a.ID+"/content", nil, ""); rec.Code != 200 || rec.Body.String() != "synthetic receipt total 12.50" {
		t.Fatalf("download: %d %q", rec.Code, rec.Body)
	}
	if rec := do("DELETE", "/attachments/"+a.ID, nil, ""); rec.Code != 204 {
		t.Fatalf("delete: %d", rec.Code)
	}
	b, _ := newBlobs(cfg)
	if _, err := b.s3.StatObject(t.Context(), cfg.S3Bucket, profile.String()+"/"+a.ID, minio.StatObjectOptions{}); err == nil {
		t.Fatal("object not removed")
	}
}
