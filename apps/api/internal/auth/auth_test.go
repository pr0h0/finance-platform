package auth_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

func TestPasswordHashing(t *testing.T) {
	h, err := auth.HashPassword(pw)
	if err != nil || !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash %q %v", h, err)
	}
	if ok, err := auth.VerifyPassword(pw, h); !ok || err != nil {
		t.Fatal("correct password rejected")
	}
	if ok, _ := auth.VerifyPassword(pw+"x", h); ok {
		t.Fatal("wrong password accepted")
	}
	h2, _ := auth.HashPassword(pw)
	if h == h2 {
		t.Fatal("salt not random")
	}
	if _, err := auth.VerifyPassword(pw, "$2a$10$bcrypt"); err == nil {
		t.Fatal("foreign hash accepted")
	}
}

func TestLimiter(t *testing.T) {
	l := auth.NewLimiter(2)
	a, _ := l.Allow("k")
	b, _ := l.Allow("k")
	c, retry := l.Allow("k")
	d, _ := l.Allow("other")
	if !a || !b || c || !d || retry < 1 || retry > 61 {
		t.Fatalf("limiter %v %v %v %v %d", a, b, c, d, retry)
	}
}

func TestRegistrationPolicies(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RegistrationPolicy = "first_user"; c.SetupToken = "s3tup" })
	reg := func(email string) resp {
		return e.anon().do("POST", "/api/v1/auth/register", map[string]any{"email": email, "password": pw})
	}
	if r := reg("Admin@Example.com"); r.Status != 403 || r.errCode() != "setup_token_required" {
		t.Fatalf("first user without setup token: %d %s", r.Status, r.Raw)
	}
	if r := e.anon().do("POST", "/api/v1/auth/register", map[string]any{"email": "x@example.com", "password": pw, "setupToken": "wrong"}); r.Status != 403 {
		t.Fatalf("wrong setup token: %d %s", r.Status, r.Raw)
	}
	r := e.anon().do("POST", "/api/v1/auth/register", map[string]any{"email": "Admin@Example.com", "password": pw, "setupToken": "s3tup"})
	if r.Status != 201 || r.Body["isAdmin"] != true || r.Body["passwordHash"] != nil {
		t.Fatalf("first user: %d %s", r.Status, r.Raw)
	}
	if r := reg("second@example.com"); r.Status != 403 || r.errCode() != "registration_closed" {
		t.Fatalf("first_user allowed a second user: %d %s", r.Status, r.Raw)
	}
	if r := reg("bad"); r.Status != 422 {
		t.Fatalf("invalid email: %d", r.Status)
	}
	admin := e.login("admin@example.com", pw) // email is case-insensitive
	if p := admin.firstProfile(); p == "" {
		t.Fatal("no default profile")
	}

	admin.must(200, "PUT", "/api/v1/admin/settings", map[string]any{"registrationPolicy": "open"})
	if r := reg("second@example.com"); r.Status != 201 || r.Body["isAdmin"] != false {
		t.Fatalf("open: %d %s", r.Status, r.Raw)
	}
	if r := reg("SECOND@example.com"); r.Status != 409 || r.errCode() != "email_taken" {
		t.Fatalf("duplicate email: %d %s", r.Status, r.Raw)
	}
	if r := e.anon().do("POST", "/api/v1/auth/register", map[string]any{"email": "short@example.com", "password": "short"}); r.Status != 422 {
		t.Fatalf("short password: %d", r.Status)
	}
	admin.must(200, "PUT", "/api/v1/admin/settings", map[string]any{"registrationPolicy": "invite_only"})
	if r := reg("third@example.com"); r.Status != 403 || r.errCode() != "registration_invite_only" {
		t.Fatalf("invite_only: %d %s", r.Status, r.Raw)
	}
	admin.must(201, "POST", "/api/v1/admin/users", map[string]any{"email": "third@example.com", "password": pw})
	e.login("third@example.com", pw)
	admin.must(200, "PUT", "/api/v1/admin/settings", map[string]any{"registrationPolicy": "closed"})
	if r := reg("fourth@example.com"); r.Status != 403 {
		t.Fatalf("closed: %d", r.Status)
	}
	if r := admin.do("PUT", "/api/v1/admin/settings", map[string]any{"mcpEnabled": true}); r.Status != 422 {
		t.Fatalf("env-only setting changed: %d", r.Status)
	}
}

func TestCookieSessionAndCSRF(t *testing.T) {
	e := newEnv(t, nil)
	e.anon().must(201, "POST", "/api/v1/auth/register", map[string]any{"email": "a@example.com", "password": pw})
	c := e.anon()
	r := c.must(200, "POST", "/api/v1/auth/login", map[string]any{"email": "a@example.com", "password": pw},
		"X-Forwarded-Proto", "https")
	set := r.Header.Get("Set-Cookie")
	for _, want := range []string{"finplat_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"} {
		if !strings.Contains(set, want) {
			t.Fatalf("cookie %q lacks %s", set, want)
		}
	}
	if r.str("token") != "" || r.str("csrfToken") == "" {
		t.Fatalf("cookie login must not return a bearer token: %s", r.Raw)
	}
	c.csrf = r.str("csrfToken")
	c.must(200, "GET", "/api/v1/users/me", nil)
	if s := c.must(200, "GET", "/api/v1/auth/session", nil); s.str("csrfToken") != c.csrf {
		t.Fatal("session endpoint returns a different csrf token")
	}

	c.noCSRF = true
	if r := c.do("PATCH", "/api/v1/users/me", map[string]any{"displayName": "X"}); r.Status != 403 || r.errCode() != "csrf_failed" {
		t.Fatalf("missing CSRF accepted: %d %s", r.Status, r.Raw)
	}
	if r := c.do("PATCH", "/api/v1/users/me", map[string]any{"displayName": "X"}, auth.CSRFHeader, "forged"); r.Status != 403 {
		t.Fatalf("forged CSRF accepted: %d", r.Status)
	}
	c.noCSRF = false
	if r := c.must(200, "PATCH", "/api/v1/users/me", map[string]any{"displayName": " Alice ", "timezone": "Europe/Sarajevo"}); r.str("displayName") != "Alice" {
		t.Fatalf("patch: %s", r.Raw)
	}
	if r := c.do("PATCH", "/api/v1/users/me", map[string]any{"timezone": "Mars/Olympus"}); r.Status != 422 {
		t.Fatalf("bad tz: %d", r.Status)
	}
	c.must(200, "PUT", "/api/v1/users/me/settings", map[string]any{"theme": "dark", "widgets": []any{"balance"}})
	if r := c.must(200, "GET", "/api/v1/users/me/settings", nil); r.Body["theme"] != "dark" {
		t.Fatalf("settings: %s", r.Raw)
	}

	// bearer clients need no CSRF; a cookie token is not accepted as a bearer token
	d, _ := e.device("a@example.com", "Phone")
	d.must(200, "PATCH", "/api/v1/users/me", map[string]any{"displayName": "Bearer"})
	if r := (&client{e: e, bearer: c.cookie}).do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("cookie token as bearer: %d", r.Status)
	}
	if r := (&client{e: e, cookie: d.bearer}).do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("bearer token as cookie: %d", r.Status)
	}
	if r := e.anon().do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("anonymous: %d", r.Status)
	}
	if r := (&client{e: e, bearer: "garbage"}).do("GET", "/api/v1/users/me", nil); r.Status != 401 || r.errCode() != "invalid_token" {
		t.Fatalf("garbage bearer: %d %s", r.Status, r.Raw)
	}

	// logout revokes the session server-side
	c.must(204, "POST", "/api/v1/auth/logout", nil)
	if r := c.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("after logout: %d", r.Status)
	}
}

func TestLoginFailuresAndRateLimit(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.RateLimitAuthPM = 5 })
	e.anon().must(201, "POST", "/api/v1/auth/register", map[string]any{"email": "a@example.com", "password": pw})
	bad := e.anon()
	bad.ip = "203.0.113.7"
	r1 := bad.do("POST", "/api/v1/auth/login", map[string]any{"email": "a@example.com", "password": "wrong password!"})
	r2 := bad.do("POST", "/api/v1/auth/login", map[string]any{"email": "nobody@example.com", "password": "wrong password!"})
	if r1.Status != 401 || r2.Status != 401 || r1.errCode() != r2.errCode() {
		t.Fatalf("login errors must not reveal accounts: %s / %s", r1.Raw, r2.Raw)
	}
	var last resp
	for range 5 {
		last = bad.do("POST", "/api/v1/auth/login", map[string]any{"email": "x@example.com", "password": "wrong password!"})
	}
	if last.Status != 429 || last.Header.Get("Retry-After") == "" {
		t.Fatalf("no rate limit after repeated failures: %d", last.Status)
	}
	// per-account limit holds across IPs (distributed guessing)
	for i := range 6 {
		last = (&client{e: e, ip: fmt.Sprintf("198.51.100.%d", i+1)}).do("POST", "/api/v1/auth/login",
			map[string]any{"email": "victim@example.com", "password": "wrong password!"})
	}
	if last.Status != 429 {
		t.Fatalf("per-account limit missing: %d", last.Status)
	}
	var n int
	_ = e.pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_log WHERE action = 'auth.login_failed'`).Scan(&n)
	if n != 1 {
		t.Fatalf("expected 1 audited failure for the existing account, got %d", n)
	}
}

func TestSessionListRevocationAndPasswordChange(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	other := e.login("a@example.com", pw)
	phone, _ := e.device("a@example.com", "Phone")
	items := a.must(200, "GET", "/api/v1/sessions", nil).items()
	if len(items) != 3 {
		t.Fatalf("sessions: %d", len(items))
	}
	var otherID string
	current := 0
	for _, it := range items {
		m := it.(map[string]any)
		if m["current"] == true {
			current++
		}
	}
	for _, it := range other.must(200, "GET", "/api/v1/sessions", nil).items() {
		if m := it.(map[string]any); m["current"] == true {
			otherID = m["id"].(string)
		}
	}
	if current != 1 || otherID == "" {
		t.Fatal("current flag wrong")
	}
	// another user cannot revoke it (no existence oracle: 404)
	b := e.signup("b@example.com")
	if r := b.do("DELETE", "/api/v1/sessions/"+otherID, nil); r.Status != 404 {
		t.Fatalf("IDOR session revoke: %d", r.Status)
	}
	other.must(200, "GET", "/api/v1/users/me", nil)
	a.must(204, "DELETE", "/api/v1/sessions/"+otherID, nil)
	if r := other.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("revoked session still works: %d", r.Status)
	}

	// password change: wrong current rejected; success revokes all other sessions, keeps this one
	if r := a.do("POST", "/api/v1/auth/password", map[string]any{"currentPassword": "nope nope nope", "newPassword": "another long password"}); r.Status != 401 {
		t.Fatalf("wrong current password: %d", r.Status)
	}
	a.must(204, "POST", "/api/v1/auth/password", map[string]any{"currentPassword": pw, "newPassword": "another long password"})
	a.must(200, "GET", "/api/v1/users/me", nil)
	if r := phone.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("device session survived password change: %d", r.Status)
	}
	if r := e.anon().do("POST", "/api/v1/auth/login", map[string]any{"email": "a@example.com", "password": pw}); r.Status != 401 {
		t.Fatal("old password still works")
	}
	e.login("a@example.com", "another long password")

	// expired sessions are rejected
	if _, err := e.pool.Exec(context.Background(), `UPDATE sessions SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if r := a.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("expired session works: %d", r.Status)
	}
}

func TestRecoveryCodes(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	codes := a.must(200, "POST", "/api/v1/auth/recovery-codes", nil).Body["codes"].([]any)
	if len(codes) != 10 {
		t.Fatalf("codes: %d", len(codes))
	}
	var stored string
	_ = e.pool.QueryRow(context.Background(), `SELECT code_hash FROM user_recovery_codes LIMIT 1`).Scan(&stored)
	for _, c := range codes {
		if strings.Contains(stored, c.(string)) {
			t.Fatal("recovery code stored in clear")
		}
	}
	code := codes[3].(string)
	anon := e.anon()
	if r := anon.do("POST", "/api/v1/auth/recover", map[string]any{"email": "a@example.com", "code": "AAAAA-BBBBB-CCCCC-DDDDD", "newPassword": "recovered password 1"}); r.Status != 401 {
		t.Fatalf("bad code: %d", r.Status)
	}
	// forgiving entry: lower case, spaces instead of dashes
	typed := strings.ToLower(strings.ReplaceAll(code, "-", " "))
	anon.must(204, "POST", "/api/v1/auth/recover", map[string]any{"email": "A@example.com", "code": typed, "newPassword": "recovered password 1"})
	if r := a.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatal("sessions must be revoked after recovery")
	}
	if r := anon.do("POST", "/api/v1/auth/recover", map[string]any{"email": "a@example.com", "code": code, "newPassword": "recovered password 2"}); r.Status != 401 {
		t.Fatal("recovery code reused")
	}
	a2 := e.login("a@example.com", "recovered password 1")
	// regenerating invalidates the old set
	a2.must(200, "POST", "/api/v1/auth/recovery-codes", nil)
	if r := anon.do("POST", "/api/v1/auth/recover", map[string]any{"email": "a@example.com", "code": codes[5].(string), "newPassword": "recovered password 3"}); r.Status != 401 {
		t.Fatal("old recovery code valid after regeneration")
	}
}

func TestDeviceRevocationEndsSessions(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	phone, phoneID := e.device("a@example.com", "Phone")
	phone.must(200, "GET", "/api/v1/users/me", nil)
	devs := a.must(200, "GET", "/api/v1/devices", nil).items()
	if len(devs) != 1 || devs[0].(map[string]any)["name"] != "Phone" {
		t.Fatalf("devices: %v", devs)
	}
	a.must(200, "PATCH", "/api/v1/devices/"+phoneID, map[string]any{"name": "Old phone"})
	b := e.signup("b@example.com")
	if r := b.do("DELETE", "/api/v1/devices/"+phoneID, nil); r.Status != 404 {
		t.Fatalf("IDOR device revoke: %d", r.Status)
	}
	if r := b.do("PATCH", "/api/v1/devices/"+phoneID, map[string]any{"name": "mine"}); r.Status != 404 {
		t.Fatalf("IDOR device rename: %d", r.Status)
	}
	a.must(204, "DELETE", "/api/v1/devices/"+phoneID, nil)
	if r := phone.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("revoked device still authenticated: %d", r.Status)
	}
	// enrolling a device from a web session binds that session to it
	web := e.login("a@example.com", pw)
	d := web.must(201, "POST", "/api/v1/devices", map[string]any{"name": "Browser", "platform": "web"})
	a.must(204, "DELETE", "/api/v1/devices/"+d.str("id"), nil)
	if r := web.do("GET", "/api/v1/users/me", nil); r.Status != 401 {
		t.Fatalf("session bound to revoked device still works: %d", r.Status)
	}
	if r := a.do("POST", "/api/v1/devices", map[string]any{"name": "x", "platform": "symbian"}); r.Status != 422 {
		t.Fatalf("bad platform: %d", r.Status)
	}
}

func TestMCPTokenOnlyOnMCPPaths(t *testing.T) {
	e := newEnv(t, nil)
	a := e.signup("a@example.com")
	tok, hash := auth.NewToken()
	if _, err := e.pool.Exec(context.Background(), `INSERT INTO mcp_clients (user_id, name, token_hash, token_prefix)
		VALUES ($1, 'agent', $2, 'x')`, a.userID, hash); err != nil {
		t.Fatal(err)
	}
	m := &client{e: e, bearer: tok}
	if r := m.must(200, "GET", "/mcp/whoami", nil); r.str("actor") != "mcp" {
		t.Fatalf("mcp principal: %s", r.Raw)
	}
	if r := m.do("GET", "/api/v1/profiles", nil); r.Status != 401 {
		t.Fatalf("MCP token used on REST API: %d", r.Status)
	}
	if _, err := e.pool.Exec(context.Background(), `UPDATE mcp_clients SET revoked_at = now()`); err != nil {
		t.Fatal(err)
	}
	if r := m.do("GET", "/mcp/whoami", nil); r.Status != 401 {
		t.Fatalf("revoked MCP client: %d", r.Status)
	}
}
