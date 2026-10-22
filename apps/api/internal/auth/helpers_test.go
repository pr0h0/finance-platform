package auth_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/admin"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/audit"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/backups"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/households"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/profiles"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
	"github.com/pr0h0/finance-platform/apps/api/internal/users"
)

const pw = "correct horse battery staple"

type env struct {
	t    *testing.T
	pool *pgxpool.Pool
	cfg  *config.Config
	deps *app.Deps
	url  string
}

// newEnv serves this agent's modules behind the same middleware chain as server.New
// (request id, real ip, body limit, auth) against a fresh test database.
func newEnv(t *testing.T, mut func(*config.Config)) *env {
	t.Helper()
	pool := testdb.New(t)
	cfg := &config.Config{Env: "test", PublicURL: "https://fin.example.test", CookieSecure: true, TrustProxy: true,
		SessionTTL: time.Hour, RegistrationPolicy: "open", MaxBodyBytes: 1 << 20, MaxUploadBytes: 20 << 20,
		BackupDir: t.TempDir(), BackupSchedule: "24h", BackupRetentionDays: 30, RateLimitAuthPM: 1000,
		StorageBackend: "local", AttachmentsDir: t.TempDir(), FXProviders: []string{"ecb"}}
	if mut != nil {
		mut(cfg)
	}
	deps := &app.Deps{Config: cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := chi.NewRouter()
	r.Use(middleware.RequestID, httpx.RealIP, httpx.MaxBody(cfg.MaxBodyBytes), auth.Middleware(deps))
	r.Route("/api/v1", func(v chi.Router) {
		for _, reg := range []func(chi.Router, *app.Deps){auth.Register, users.Register, profiles.Register, households.Register,
			sync.Register, backups.Register, admin.Register, audit.Register} {
			reg(v, deps)
		}
	})
	r.Get("/mcp/whoami", httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		p, err := authz.Require(r.Context())
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, 200, map[string]any{"actor": p.ActorType, "user": p.UserID})
		return nil
	}))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &env{t: t, pool: pool, cfg: cfg, deps: deps, url: srv.URL}
}

type client struct {
	e      *env
	cookie string
	csrf   string
	bearer string
	ip     string
	noCSRF bool
	userID string
}

type resp struct {
	Status int
	Body   map[string]any
	Raw    []byte
	Header http.Header
}

func (r resp) str(k string) string { s, _ := r.Body[k].(string); return s }
func (r resp) items() []any        { l, _ := r.Body["items"].([]any); return l }
func (r resp) errCode() string {
	e, _ := r.Body["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func (c *client) do(method, path string, body any, hdr ...string) resp {
	c.e.t.Helper()
	var rd io.Reader
	ct := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	case *bytes.Buffer:
		rd = b
	default:
		j, _ := json.Marshal(b)
		rd, ct = bytes.NewReader(j), "application/json"
	}
	req, _ := http.NewRequest(method, c.e.url+path, rd)
	if ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	if c.cookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: c.cookie})
	}
	if c.csrf != "" && !c.noCSRF {
		req.Header.Set(auth.CSRFHeader, c.csrf)
	}
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	if c.ip != "" {
		req.Header.Set("X-Real-IP", c.ip)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{Status: res.StatusCode, Raw: raw, Header: res.Header}
	_ = json.Unmarshal(raw, &out.Body)
	for _, ck := range res.Cookies() {
		if ck.Name == auth.CookieName {
			c.cookie = ck.Value
		}
	}
	return out
}

func (c *client) must(want int, method, path string, body any, hdr ...string) resp {
	c.e.t.Helper()
	r := c.do(method, path, body, hdr...)
	if r.Status != want {
		c.e.t.Fatalf("%s %s: want %d got %d %s", method, path, want, r.Status, r.Raw)
	}
	return r
}

func (e *env) anon() *client { return &client{e: e} }

// signup registers email and returns a logged-in cookie client.
func (e *env) signup(email string) *client {
	e.t.Helper()
	e.anon().must(201, "POST", "/api/v1/auth/register", map[string]any{"email": email, "password": pw, "displayName": strings.Split(email, "@")[0]})
	return e.login(email, pw)
}

func (e *env) login(email, password string) *client {
	e.t.Helper()
	c := e.anon()
	r := c.must(200, "POST", "/api/v1/auth/login", map[string]any{"email": email, "password": password})
	c.csrf = r.str("csrfToken")
	c.userID, _ = r.Body["user"].(map[string]any)["id"].(string)
	return c
}

// device logs in as a native device (bearer token) and returns the client and device id.
func (e *env) device(email, name string) (*client, string) {
	e.t.Helper()
	c := e.anon()
	r := c.must(200, "POST", "/api/v1/auth/login", map[string]any{"email": email, "password": pw,
		"device": map[string]any{"name": name, "platform": "android", "clientVersion": "1.0.0"}})
	c.bearer = r.str("token")
	c.userID, _ = r.Body["user"].(map[string]any)["id"].(string)
	return c, r.str("deviceId")
}

// firstProfile returns the id of the user's first profile (the default "Personal").
func (c *client) firstProfile() string {
	c.e.t.Helper()
	items := c.must(200, "GET", "/api/v1/profiles", nil).items()
	if len(items) == 0 {
		c.e.t.Fatal("no profiles")
	}
	return items[0].(map[string]any)["id"].(string)
}
