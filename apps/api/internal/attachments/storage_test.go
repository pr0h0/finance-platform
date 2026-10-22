package attachments

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

func testKey() string {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	return base64.StdEncoding.EncodeToString(k)
}

func roundTrip(t *testing.T, b *blobs, wantSealed bool) (key string) {
	t.Helper()
	ctx := context.Background()
	profile := uuid.NewString()
	key = profile + "/" + uuid.NewString()
	dir, err := b.tempDir(profile)
	if err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, ".upload-test-"+uuid.NewString())
	plain := []byte("%PDF-1.4 synthetic statement content")
	if err := os.WriteFile(tmp, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	sealed, err := b.put(ctx, key, tmp)
	if err != nil || sealed != wantSealed {
		t.Fatalf("put: sealed=%v err=%v", sealed, err)
	}
	if _, err := os.Stat(tmp); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temp file left behind: %v", err)
	}
	f, _, err := b.open(ctx, b.backend, key, sealed)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(f)
	f.Close()
	if !bytes.Equal(got, plain) {
		t.Fatalf("content: %q", got)
	}
	// ServeContent needs Seek.
	if f, _, err = b.open(ctx, b.backend, key, sealed); err == nil {
		if n, err := f.Seek(5, io.SeekStart); err != nil || n != 5 {
			t.Fatalf("seek: %d %v", n, err)
		}
		f.Close()
	}
	return key
}

func TestLocalEncryptionAtRest(t *testing.T) {
	dir := t.TempDir()
	secret := testKey()
	b, err := newBlobs(&config.Config{StorageBackend: "local", AttachmentsDir: dir, AttachmentKey: secret})
	if err != nil {
		t.Fatal(err)
	}
	key := roundTrip(t, b, true)
	raw, _ := os.ReadFile(filepath.Join(dir, key))
	if bytes.Contains(raw, []byte("synthetic statement")) {
		t.Fatal("stored file is not encrypted")
	}
	// The key is bound as associated data: the same ciphertext under another key does not open.
	other := uuid.NewString() + "/" + uuid.NewString()
	_ = os.MkdirAll(filepath.Dir(filepath.Join(dir, other)), 0o700)
	_ = os.WriteFile(filepath.Join(dir, other), raw, 0o600)
	if _, _, err := b.open(context.Background(), "local", other, true); err == nil {
		t.Fatal("swapped ciphertext decrypted")
	}
	// A server without the key cannot read it, and says so.
	plainOnly, _ := newBlobs(&config.Config{StorageBackend: "local", AttachmentsDir: dir})
	if _, _, err := plainOnly.open(context.Background(), "local", key, true); err == nil {
		t.Fatal("opened without key")
	}
	// Content (used by MCP) undoes the encryption and enforces its size cap.
	cfg := &config.Config{StorageBackend: "local", AttachmentsDir: dir, AttachmentKey: secret}
	if got, err := Content(context.Background(), cfg, "local", key, true, 1<<20); err != nil || string(got) != "%PDF-1.4 synthetic statement content" {
		t.Fatalf("Content: %q %v", got, err)
	}
	if _, err := Content(context.Background(), cfg, "local", key, true, 4); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Content cap: %v", err)
	}
	if _, err := Content(context.Background(), cfg, "local", "../etc/passwd", false, 10); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("bad key: %v", err)
	}
	// Unencrypted files written before the key was set still open.
	k2 := roundTrip(t, plainOnly, false)
	if _, _, err := b.open(context.Background(), "local", k2, false); err != nil {
		t.Fatal(err)
	}
	if err := b.remove(context.Background(), "local", key); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.open(context.Background(), "local", key, true); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("after remove: %v", err)
	}
}

func TestBadKeyRejected(t *testing.T) {
	if _, err := newBlobs(&config.Config{AttachmentKey: "c2hvcnQ="}); err == nil {
		t.Fatal("short key accepted")
	}
}

// s3Config points at the dev MinIO (docker-compose.dev.yml --profile integrations); skipped when absent.
func s3Config(t *testing.T) *config.Config {
	t.Helper()
	ep := os.Getenv("TEST_S3_ENDPOINT")
	if ep == "" {
		ep = "http://minio:9000"
	}
	host := ep[len("http://"):]
	c, err := net.DialTimeout("tcp", host, time.Second)
	if err != nil {
		t.Skip("S3 test server not reachable (docker compose -f docker-compose.dev.yml --profile integrations up -d minio)")
	}
	c.Close()
	cfg := &config.Config{StorageBackend: "s3", AttachmentsDir: t.TempDir(), S3Endpoint: ep, S3Bucket: "finplat-test-" + uuid.NewString()[:8],
		S3AccessKey: "finplat", S3SecretKey: "finplat-dev-secret", S3Region: "us-east-1", S3PathStyle: true}
	b, err := newBlobs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := b.s3.MakeBucket(ctx, cfg.S3Bucket, minio.MakeBucketOptions{Region: cfg.S3Region}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for o := range b.s3.ListObjects(ctx, cfg.S3Bucket, minio.ListObjectsOptions{Recursive: true}) {
			_ = b.s3.RemoveObject(ctx, cfg.S3Bucket, o.Key, minio.RemoveObjectOptions{})
		}
		_ = b.s3.RemoveBucket(ctx, cfg.S3Bucket)
	})
	return cfg
}

func TestS3Backend(t *testing.T) {
	cfg := s3Config(t)
	ctx := context.Background()
	for _, tc := range []struct {
		name     string
		sse, key bool
	}{{"plain", false, false}, {"sse-s3", true, false}, {"app-encrypted", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			c := *cfg
			c.S3SSE = tc.sse
			if tc.key {
				c.AttachmentKey = testKey()
			}
			b, err := newBlobs(&c)
			if err != nil {
				t.Fatal(err)
			}
			key := roundTrip(t, b, tc.key)
			st, err := b.s3.StatObject(ctx, c.S3Bucket, key, minio.StatObjectOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if tc.sse && st.Metadata.Get("X-Amz-Server-Side-Encryption") != "AES256" {
				t.Fatalf("SSE header missing: %v", st.Metadata)
			}
			if err := b.remove(ctx, "s3", key); err != nil {
				t.Fatal(err)
			}
			if _, _, err := b.open(ctx, "s3", key, tc.key); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("after remove: %v", err)
			}
		})
	}
}
