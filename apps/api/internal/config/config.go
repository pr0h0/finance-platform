// Package config loads all runtime configuration from environment variables (see .env.example).
package config

import (
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

	StorageBackend string // local | s3
	AttachmentsDir string
	MaxUploadBytes int64
	S3Endpoint     string
	S3Bucket       string
	S3AccessKey    string
	S3SecretKey    string
	S3Region       string

	FXProviders       []string
	FXRefreshInterval time.Duration

	JobsEnabled     bool
	JobsConcurrency int

	SMTPHost     string
	SMTPPort     int
	SMTPUser     string
	SMTPPassword string
	SMTPFrom     string

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
		StorageBackend:      str("STORAGE_BACKEND", "local"),
		AttachmentsDir:      str("ATTACHMENTS_DIR", "/data/attachments"),
		MaxUploadBytes:      num[int64]("MAX_UPLOAD_BYTES", 25<<20, &errs),
		S3Endpoint:          os.Getenv("S3_ENDPOINT"),
		S3Bucket:            os.Getenv("S3_BUCKET"),
		S3AccessKey:         os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:         os.Getenv("S3_SECRET_KEY"),
		S3Region:            str("S3_REGION", "us-east-1"),
		FXProviders:         list("FX_PROVIDERS", "ecb"),
		FXRefreshInterval:   dur("FX_REFRESH_INTERVAL", 6*time.Hour, &errs),
		JobsEnabled:         boolean("JOBS_ENABLED", true, &errs),
		JobsConcurrency:     num[int]("JOBS_CONCURRENCY", 2, &errs),
		SMTPHost:            os.Getenv("SMTP_HOST"),
		SMTPPort:            num[int]("SMTP_PORT", 587, &errs),
		SMTPUser:            os.Getenv("SMTP_USER"),
		SMTPPassword:        os.Getenv("SMTP_PASSWORD"),
		SMTPFrom:            os.Getenv("SMTP_FROM"),
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
	if len(errs) > 0 {
		return nil, fmt.Errorf("invalid configuration: %s", strings.Join(errs, "; "))
	}
	return c, nil
}

func (c *Config) IsDev() bool { return c.Env == "development" }
