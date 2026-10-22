package attachments

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/encrypt"

	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// blobs stores attachment contents under a server-generated key (<profile id>/<attachment id>) on the
// local volume or an S3-compatible bucket. Each row remembers its backend, so switching STORAGE_BACKEND
// keeps older files readable. With ATTACHMENT_ENCRYPTION_KEY new files are sealed with AES-256-GCM
// (nonce || ciphertext, the key as associated data so files cannot be swapped between rows).
type blobs struct {
	backend string // where new files go
	dir     string
	s3      *minio.Client
	bucket  string
	sse     bool
	aead    cipher.AEAD
}

func newBlobs(cfg *config.Config) (*blobs, error) {
	b := &blobs{backend: cfg.StorageBackend, dir: cfg.AttachmentsDir, bucket: cfg.S3Bucket, sse: cfg.S3SSE}
	if b.backend == "" {
		b.backend = "local"
	}
	if cfg.AttachmentKey != "" {
		k, err := base64.StdEncoding.DecodeString(cfg.AttachmentKey)
		if err != nil || len(k) != 32 {
			return nil, errors.New("ATTACHMENT_ENCRYPTION_KEY: must be base64 of 32 bytes")
		}
		blk, _ := aes.NewCipher(k)
		b.aead, _ = cipher.NewGCM(blk)
	}
	if cfg.S3Endpoint != "" {
		u, err := url.Parse(cfg.S3Endpoint)
		if err != nil || u.Host == "" {
			return nil, errors.New("S3_ENDPOINT: must be an http(s) URL")
		}
		lookup := minio.BucketLookupAuto
		if cfg.S3PathStyle {
			lookup = minio.BucketLookupPath
		}
		b.s3, err = minio.New(u.Host, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.S3AccessKey, cfg.S3SecretKey, ""),
			Secure: u.Scheme == "https", Region: cfg.S3Region, BucketLookup: lookup,
		})
		if err != nil {
			return nil, fmt.Errorf("s3 client: %w", err)
		}
	}
	return b, nil
}

var errUnavailable = httpx.NewError(http.StatusServiceUnavailable, "storage_unavailable", "attachment storage is not configured")

func (b *blobs) encrypted() bool { return b.aead != nil }

func (b *blobs) seal(key string, plain []byte) []byte {
	nonce := make([]byte, b.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return b.aead.Seal(nonce, nonce, plain, []byte(key))
}

func (b *blobs) unseal(key string, sealed []byte) ([]byte, error) {
	if b.aead == nil {
		return nil, errors.New("attachment is encrypted but ATTACHMENT_ENCRYPTION_KEY is not set")
	}
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("attachment ciphertext truncated")
	}
	return b.aead.Open(nil, sealed[:n], sealed[n:], []byte(key))
}

// tempDir is where uploads are staged before put (same filesystem as the final path for local).
func (b *blobs) tempDir(profile string) (string, error) {
	if b.backend != "local" {
		return os.TempDir(), nil
	}
	dir := filepath.Join(b.dir, profile)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("attachments dir: %w", err)
	}
	return dir, nil
}

// put moves the finished temp file to key on the current backend (encrypting it when configured).
// It returns whether the stored file is encrypted.
func (b *blobs) put(ctx context.Context, key, tmp string) (bool, error) {
	var sealed []byte
	if b.aead != nil {
		// ponytail: whole file in memory (bounded by MAX_UPLOAD_BYTES); chunked AEAD if limits grow a lot.
		plain, err := os.ReadFile(tmp)
		if err != nil {
			return false, err
		}
		sealed = b.seal(key, plain)
	}
	switch b.backend {
	case "local":
		dst := filepath.Join(b.dir, key)
		if sealed != nil {
			if err := os.WriteFile(tmp, sealed, 0o600); err != nil {
				return false, fmt.Errorf("store attachment: %w", err)
			}
		}
		if err := os.Rename(tmp, dst); err != nil {
			return false, fmt.Errorf("store attachment: %w", err)
		}
	case "s3":
		if b.s3 == nil {
			return false, errUnavailable
		}
		opts := minio.PutObjectOptions{ContentType: "application/octet-stream"}
		if b.sse {
			opts.ServerSideEncryption = encrypt.NewSSE()
		}
		var err error
		if sealed != nil {
			_, err = b.s3.PutObject(ctx, b.bucket, key, bytes.NewReader(sealed), int64(len(sealed)), opts)
		} else {
			_, err = b.s3.FPutObject(ctx, b.bucket, key, tmp, opts)
		}
		if err != nil {
			return false, fmt.Errorf("store attachment in s3: %w", err)
		}
		_ = os.Remove(tmp)
	default:
		return false, errUnavailable
	}
	return sealed != nil, nil
}

// open returns the plaintext content. Missing content is os.ErrNotExist.
func (b *blobs) open(ctx context.Context, backend, key string, sealed bool) (io.ReadSeekCloser, time.Time, error) {
	var rc io.ReadSeekCloser
	var mod time.Time
	switch backend {
	case "local":
		f, err := os.Open(filepath.Join(b.dir, key))
		if err != nil {
			return nil, mod, err
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, mod, err
		}
		rc, mod = f, st.ModTime()
	case "s3":
		if b.s3 == nil {
			return nil, mod, errUnavailable
		}
		obj, err := b.s3.GetObject(ctx, b.bucket, key, minio.GetObjectOptions{})
		if err != nil {
			return nil, mod, err
		}
		st, err := obj.Stat()
		if err != nil {
			obj.Close()
			if minio.ToErrorResponse(err).Code == minio.NoSuchKey {
				return nil, mod, os.ErrNotExist
			}
			return nil, mod, err
		}
		rc, mod = obj, st.LastModified
	default:
		return nil, mod, errUnavailable
	}
	if !sealed {
		return rc, mod, nil
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err == nil {
		data, err = b.unseal(key, data)
	}
	if err != nil {
		return nil, mod, fmt.Errorf("decrypt attachment: %w", err)
	}
	return nopCloser{bytes.NewReader(data)}, mod, nil
}

func (b *blobs) remove(ctx context.Context, backend, key string) error {
	switch backend {
	case "local":
		return os.Remove(filepath.Join(b.dir, key))
	case "s3":
		if b.s3 == nil {
			return errUnavailable
		}
		return b.s3.RemoveObject(ctx, b.bucket, key, minio.RemoveObjectOptions{})
	}
	return errUnavailable
}

type nopCloser struct{ *bytes.Reader }

func (nopCloser) Close() error { return nil }

var readers sync.Map // *config.Config -> *blobs (one S3 client per configuration)

// ErrTooLarge: Content was asked for at most max bytes and the file is bigger.
var ErrTooLarge = errors.New("attachment larger than the requested maximum")

// Content returns a stored file's plaintext from any backend, with server-side encryption undone,
// for other modules (MCP get_attachments). Missing content is os.ErrNotExist.
func Content(ctx context.Context, cfg *config.Config, backend, key string, sealed bool, max int64) ([]byte, error) {
	if !keyRE.MatchString(key) {
		return nil, os.ErrNotExist
	}
	v, ok := readers.Load(cfg)
	if !ok {
		b, err := newBlobs(cfg)
		if err != nil {
			return nil, err
		}
		v, _ = readers.LoadOrStore(cfg, b)
	}
	f, _, err := v.(*blobs).open(ctx, backend, key, sealed)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err == nil && int64(len(data)) > max {
		return nil, ErrTooLarge
	}
	return data, err
}
