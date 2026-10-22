// Package config loads all runtime configuration from environment variables (see .env.example).
package config

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env            string // development | production
	Addr           string // API_ADDR, listen address inside the container
	PublicURL      string // PUBLIC_URL, e.g. https://fin.pr0h0.me
	AllowedOrigins []string
	TrustProxy     bool // trust X-Forwarded-For/-Proto from the gateway

	DatabaseURL    string
	DBMaxConns     int32
	MigrateOnStart bool

	SessionTTL         time.Duration
	CookieSecure       bool
	RegistrationPolicy string // open | invite_only | closed | first_user
	SetupToken         string // SETUP_TOKEN: required to register the first (admin) account; generated and logged when unset in production

	StorageBackend string // local | s3
	AttachmentsDir string
	MaxUploadBytes int64
	S3Endpoint     string
	S3Bucket       string
	S3AccessKey    string
	S3SecretKey    string
	S3Region       string
	S3PathStyle    bool   // S3_FORCE_PATH_STYLE: bucket in the path (MinIO, most self-hosted); default auto
	S3SSE          bool   // S3_SSE: request SSE-S3 (AES256) server-side encryption on every object
	AttachmentKey  string // ATTACHMENT_ENCRYPTION_KEY: base64 32-byte AES-256-GCM key; encrypts new files at rest (empty = plain)

	FXProviders       []string
	FXRefreshInterval time.Duration

	JobsEnabled     bool
	JobsConcurrency int

	SMTPHost     string
	SMTPPort     int
	SMTPUser     string
	SMTPPassword string
	SMTPFrom     string
	SMTPTLS      string // SMTP_TLS: starttls | tls (implicit, port 465) | none

	VAPIDPublicKey  string // VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY: Web Push keys; generated and stored in the DB when unset
	VAPIDPrivateKey string
	VAPIDSubject    string // VAPID_SUBJECT: mailto: or https: contact for push services (default PUBLIC_URL)

	BackupDir           string
	BackupSchedule      string
	BackupRetentionDays int
	BackupKey           string // BACKUP_ENCRYPTION_KEY: base64 32-byte AES-256-GCM key for server backups (empty = unencrypted)

	MCPEnabled    bool
	MCPMaxResults int

	LogLevel  string
	LogFormat string // json | text

	MaxBodyBytes      int64
	RateLimitAuthPM   int
	RateLimitAPIPM    int
	RateLimitSyncPM   int
	RateLimitMCPPM    int
	RateLimitImportPM int
}

func str(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func num[T ~int | ~int32 | ~int64](k string, def T, errs *[]string) T {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		*errs = append(*errs, k+": not an integer")
		return def
	}
	return T(n)
}

func boolean(k string, def bool, errs *[]string) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		*errs = append(*errs, k+": not a boolean")
	}
	return b
}

func dur(k string, def time.Duration, errs *[]string) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		*errs = append(*errs, k+": not a duration")
		return def
	}
	return d
}

func list(k, def string) []string {
	var out []string
	for _, s := range strings.Split(str(k, def), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Load reads and validates the environment.
func Load() (*Config, error) {
	var errs []string
	c := &Config{
		Env:                 str("FINPLAT_ENV", "production"),
		Addr:                str("API_ADDR", ":8080"),
		PublicURL:           strings.TrimRight(str("PUBLIC_URL", "http://localhost:3810"), "/"),
		TrustProxy:          boolean("TRUST_PROXY_HEADERS", true, &errs),
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		DBMaxConns:          num[int32]("DB_MAX_CONNS", 10, &errs),
		MigrateOnStart:      boolean("MIGRATE_ON_START", true, &errs),
		SessionTTL:          dur("SESSION_TTL", 30*24*time.Hour, &errs),
		RegistrationPolicy:  str("REGISTRATION_POLICY", "first_user"),
		SetupToken:          os.Getenv("SETUP_TOKEN"),
		StorageBackend:      str("STORAGE_BACKEND", "local"),
		AttachmentsDir:      str("ATTACHMENTS_DIR", "/data/attachments"),
		MaxUploadBytes:      num[int64]("MAX_UPLOAD_BYTES", 25<<20, &errs),
		S3Endpoint:          os.Getenv("S3_ENDPOINT"),
		S3Bucket:            os.Getenv("S3_BUCKET"),
		S3AccessKey:         os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:         os.Getenv("S3_SECRET_KEY"),
		S3Region:            str("S3_REGION", "us-east-1"),
		S3PathStyle:         boolean("S3_FORCE_PATH_STYLE", false, &errs),
		S3SSE:               boolean("S3_SSE", false, &errs),
		AttachmentKey:       os.Getenv("ATTACHMENT_ENCRYPTION_KEY"),
		FXProviders:         list("FX_PROVIDERS", "ecb"),
		FXRefreshInterval:   dur("FX_REFRESH_INTERVAL", 6*time.Hour, &errs),
		JobsEnabled:         boolean("JOBS_ENABLED", true, &errs),
		JobsConcurrency:     num[int]("JOBS_CONCURRENCY", 2, &errs),
		SMTPHost:            os.Getenv("SMTP_HOST"),
		SMTPPort:            num[int]("SMTP_PORT", 587, &errs),
		SMTPUser:            os.Getenv("SMTP_USER"),
		SMTPPassword:        os.Getenv("SMTP_PASSWORD"),
		SMTPFrom:            os.Getenv("SMTP_FROM"),
		SMTPTLS:             os.Getenv("SMTP_TLS"),
		VAPIDPublicKey:      os.Getenv("VAPID_PUBLIC_KEY"),
		VAPIDPrivateKey:     os.Getenv("VAPID_PRIVATE_KEY"),
		VAPIDSubject:        os.Getenv("VAPID_SUBJECT"),
		BackupDir:           str("BACKUP_DIR", "/data/backups"),
		BackupSchedule:      str("BACKUP_SCHEDULE", "24h"),
		BackupRetentionDays: num[int]("BACKUP_RETENTION_DAYS", 30, &errs),
		BackupKey:           os.Getenv("BACKUP_ENCRYPTION_KEY"),
		MCPEnabled:          boolean("MCP_ENABLED", false, &errs),
		MCPMaxResults:       num[int]("MCP_MAX_RESULTS", 500, &errs),
		LogLevel:            str("LOG_LEVEL", "info"),
		LogFormat:           str("LOG_FORMAT", "json"),
		MaxBodyBytes:        num[int64]("MAX_BODY_BYTES", 1<<20, &errs),
		RateLimitAuthPM:     num[int]("RATE_LIMIT_AUTH_PER_MIN", 10, &errs),
		RateLimitAPIPM:      num[int]("RATE_LIMIT_API_PER_MIN", 600, &errs),
		RateLimitSyncPM:     num[int]("RATE_LIMIT_SYNC_PER_MIN", 120, &errs),
		RateLimitMCPPM:      num[int]("RATE_LIMIT_MCP_PER_MIN", 120, &errs),
		RateLimitImportPM:   num[int]("RATE_LIMIT_IMPORT_PER_MIN", 20, &errs),
	}
	u, err := url.Parse(c.PublicURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		errs = append(errs, "PUBLIC_URL: must be an absolute URL")
	} else {
		// Behind a TLS-terminating proxy the public scheme decides cookie security.
		c.CookieSecure = boolean("COOKIE_SECURE", u.Scheme == "https", &errs)
	}
	c.AllowedOrigins = list("ALLOWED_ORIGINS", c.PublicURL)
	if c.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL: required")
	}
	switch c.RegistrationPolicy {
	case "open", "invite_only", "closed", "first_user":
	default:
		errs = append(errs, "REGISTRATION_POLICY: must be open|invite_only|closed|first_user")
	}
	switch c.StorageBackend {
	case "local":
	case "s3":
		if c.S3Endpoint == "" || c.S3Bucket == "" || c.S3AccessKey == "" || c.S3SecretKey == "" {
			errs = append(errs, "STORAGE_BACKEND=s3: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY are required")
		} else if u, err := url.Parse(c.S3Endpoint); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			errs = append(errs, "S3_ENDPOINT: must be an http(s) URL")
		}
	default:
		errs = append(errs, "STORAGE_BACKEND: must be local|s3")
	}
	if c.AttachmentKey != "" {
		if k, err := base64.StdEncoding.DecodeString(c.AttachmentKey); err != nil || len(k) != 32 {
			errs = append(errs, "ATTACHMENT_ENCRYPTION_KEY: must be base64 of 32 bytes")
		}
	}
	if c.SMTPTLS == "" {
		c.SMTPTLS = "starttls"
		if c.SMTPPort == 465 {
			c.SMTPTLS = "tls"
		}
	}
	if c.SMTPTLS != "starttls" && c.SMTPTLS != "tls" && c.SMTPTLS != "none" {
		errs = append(errs, "SMTP_TLS: must be starttls|tls|none")
	}
	if c.SMTPHost != "" && c.SMTPFrom == "" {
		errs = append(errs, "SMTP_FROM: required when SMTP_HOST is set")
	}
	if (c.VAPIDPublicKey == "") != (c.VAPIDPrivateKey == "") {
		errs = append(errs, "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY: set both or neither")
	}
	if c.VAPIDSubject == "" {
		c.VAPIDSubject = c.PublicURL
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("invalid configuration: %s", strings.Join(errs, "; "))
	}
	return c, nil
}

func (c *Config) IsDev() bool { return c.Env == "development" }
