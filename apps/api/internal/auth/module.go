// Package auth: Registration, login/logout, sessions, CSRF, account recovery.
//
// Owned routes under /api/v1: /auth/* (including /auth/passkeys*, see passkeys.go), /sessions
// See docs/api/openapi.yaml for the contract.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/profiles"
	"github.com/pr0h0/finance-platform/apps/api/internal/users"
)

const recoveryCodeCount = 10

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	h := &handlers{deps: deps, ipLimit: NewLimiter(deps.Config.RateLimitAuthPM), keyLimit: NewLimiter(deps.Config.RateLimitAuthPM)}
	ensureSetupToken(deps)
	r.Post("/auth/register", httpx.H(h.register))
	r.Post("/auth/login", httpx.H(h.login))
	r.Post("/auth/logout", httpx.H(h.logout))
	r.Get("/auth/session", httpx.H(h.session))
	r.Post("/auth/password", httpx.H(h.changePassword))
	r.Post("/auth/recovery-codes", httpx.H(h.recoveryCodes))
	r.Post("/auth/recover", httpx.H(h.recover))
	r.Get("/sessions", httpx.H(h.listSessions))
	registerPasskeys(r, h)
	r.Delete("/sessions/{id}", httpx.H(h.revokeSession))
}

type handlers struct {
	deps     *app.Deps
	ipLimit  *Limiter // per client IP
	keyLimit *Limiter // per target account (email), against distributed guessing
}

func (h *handlers) limit(w http.ResponseWriter, r *http.Request, email string) error {
	if ok, retry := h.ipLimit.Allow(ClientIP(r)); !ok {
		return TooMany(w, retry)
	}
	if email != "" {
		if ok, retry := h.keyLimit.Allow(strings.ToLower(email)); !ok {
			return TooMany(w, retry)
		}
	}
	return nil
}

// ---------- registration ----------

// EffectivePolicy is the registration policy: the admin setting (settings scope=server) overrides
// REGISTRATION_POLICY from the environment.
func EffectivePolicy(ctx context.Context, q authz.Querier, cfg *config.Config) (string, error) {
	var v string
	err := q.QueryRow(ctx, `SELECT value #>> '{}' FROM settings WHERE scope = 'server' AND owner_id IS NULL AND key = 'registration_policy'`).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg.RegistrationPolicy, nil
	}
	return v, err
}

type registerReq struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	SetupToken  string `json:"setupToken"`
}

// ensureSetupToken protects the first (admin) registration on a fresh public server: in
// production an unset SETUP_TOKEN is generated and logged while the server has no users, so only
// someone with access to the server logs or .env can claim the admin account.
func ensureSetupToken(deps *app.Deps) {
	c := deps.Config
	if c.SetupToken != "" || c.Env != "production" || deps.DB == nil {
		return
	}
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	c.SetupToken = base64.RawURLEncoding.EncodeToString(b)
	var n int
	if err := deps.DB.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&n); err == nil && n == 0 {
		deps.Log.Warn("no users yet: the first account (server admin) needs this setup token; set SETUP_TOKEN to choose your own",
			"setupToken", c.SetupToken)
	}
}

// SetupTokenRequired reports whether the next registration must present the setup token.
func SetupTokenRequired(c *config.Config, userCount int, policy string) bool {
	return c.SetupToken != "" && userCount == 0 && policy == "first_user"
}

func (in *registerReq) validate() error {
	return ValidateRegistration(&in.Email, in.Password, &in.DisplayName)
}

// ValidateRegistration normalizes (trims) and checks registration fields.
func ValidateRegistration(email *string, password string, displayName *string) error {
	fields := map[string]string{}
	*email = strings.TrimSpace(*email)
	if a, err := mail.ParseAddress(*email); err != nil || a.Address != *email || len(*email) > 254 {
		fields["email"] = "invalid email address"
	}
	if msg := checkPassword(password); msg != "" {
		fields["password"] = msg
	}
	*displayName = strings.TrimSpace(*displayName)
	if len(*displayName) > 200 {
		fields["displayName"] = "at most 200 characters"
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	return nil
}

func checkPassword(pw string) string {
	switch {
	case len([]rune(pw)) < MinPasswordLen:
		return "at least 12 characters"
	case len(pw) > MaxPasswordLen:
		return "at most 1024 bytes"
	}
	return ""
}

// CreateUser inserts an active user and their default "Personal" profile inside tx.
// Used by registration and by admin user creation.
func CreateUser(ctx context.Context, tx pgx.Tx, email, password, displayName string, isAdmin bool) (users.User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return users.User{}, err
	}
	u, err := users.Scan(tx.QueryRow(ctx, `INSERT INTO users (email, display_name, password_hash, is_admin)
		VALUES ($1, $2, $3, $4) RETURNING `+users.Columns, email, displayName, hash, isAdmin))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return u, httpx.NewError(http.StatusConflict, "email_taken", "an account with this email already exists")
	}
	if err != nil {
		return u, err
	}
	if _, err := profiles.Create(ctx, tx, u.ID, profiles.Input{Name: "Personal"}); err != nil {
		return u, err
	}
	return u, nil
}

func (h *handlers) register(w http.ResponseWriter, r *http.Request) error {
	var in registerReq
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := h.limit(w, r, ""); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize registrations so "first user becomes admin" cannot race.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('finplat.registration'))`); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
		return err
	}
	policy, err := EffectivePolicy(ctx, tx, h.deps.Config)
	if err != nil {
		return err
	}
	if SetupTokenRequired(h.deps.Config, count, policy) &&
		subtle.ConstantTimeCompare([]byte(in.SetupToken), []byte(h.deps.Config.SetupToken)) != 1 {
		return httpx.NewError(http.StatusForbidden, "setup_token_required", "the first account needs the server setup token (SETUP_TOKEN, or see the API log)")
	}
	switch {
	case policy == "open", count == 0 && policy == "first_user":
	case policy == "invite_only":
		return httpx.NewError(http.StatusForbidden, "registration_invite_only", "registration is by invitation; ask the administrator to create your account")
	default:
		return httpx.NewError(http.StatusForbidden, "registration_closed", "registration is closed on this server")
	}
	u, err := CreateUser(ctx, tx, in.Email, in.Password, in.DisplayName, count == 0)
	if err != nil {
		return err
	}
	actx := authz.WithPrincipal(ctx, authz.Principal{UserID: u.ID, ActorType: authz.ActorUser})
	if err := changes.Audit(actx, tx, changes.Entry{Action: "auth.register", EntityType: "users", EntityID: &u.ID,
		IP: ClientIP(r), Metadata: map[string]any{"admin": u.IsAdmin, "policy": policy}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, u)
	return nil
}

// ---------- login / session ----------

type deviceReq struct {
	Name          string `json:"name"`
	Platform      string `json:"platform"`
	ClientVersion string `json:"clientVersion"`
	PublicKey     string `json:"publicKey"`
}

var platforms = map[string]bool{"web": true, "android": true, "ios": true, "macos": true, "windows": true, "linux": true, "cli": true, "other": true}

// CreateDevice validates and inserts a device for userID (also used by POST /devices).
func CreateDevice(ctx context.Context, q authz.Querier, userID uuid.UUID, d DeviceInput) (Device, error) {
	fields := map[string]string{}
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" || len(d.Name) > 100 {
		fields["name"] = "1-100 characters"
	}
	if !platforms[d.Platform] {
		fields["platform"] = "one of web, android, ios, macos, windows, linux, cli, other"
	}
	if len(d.ClientVersion) > 50 {
		fields["clientVersion"] = "at most 50 characters"
	}
	var pub []byte
	if d.PublicKey != "" {
		var err error
		if pub, err = base64.StdEncoding.DecodeString(d.PublicKey); err != nil || len(pub) != 32 {
			fields["publicKey"] = "base64 X25519 public key (32 bytes)"
		}
	}
	if len(fields) > 0 {
		return Device{}, httpx.Validation(fields)
	}
	return ScanDevice(q.QueryRow(ctx, `INSERT INTO devices (user_id, name, platform, client_version, public_key)
		VALUES ($1,$2,$3,$4,$5) RETURNING `+DeviceColumns, userID, d.Name, d.Platform, d.ClientVersion, pub))
}

// DeviceInput is the OpenAPI DeviceRegistration.
type DeviceInput = deviceReq

// Device is the OpenAPI Device shape.
type Device struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Platform      string     `json:"platform"`
	ClientVersion string     `json:"clientVersion"`
	LastSeenAt    *time.Time `json:"lastSeenAt"`
	LastSyncAt    *time.Time `json:"lastSyncAt"`
	RevokedAt     *time.Time `json:"revokedAt"`
	CreatedAt     time.Time  `json:"createdAt"`
}

const DeviceColumns = `id, name, platform, client_version, last_seen_at, last_sync_at, revoked_at, created_at`

func ScanDevice(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.Name, &d.Platform, &d.ClientVersion, &d.LastSeenAt, &d.LastSyncAt, &d.RevokedAt, &d.CreatedAt)
	return d, err
}

type loginResp struct {
	User      users.User `json:"user"`
	CSRFToken string     `json:"csrfToken,omitempty"`
	Token     string     `json:"token,omitempty"`
	DeviceID  *uuid.UUID `json:"deviceId,omitempty"`
}

var errBadCredentials = httpx.NewError(http.StatusUnauthorized, "invalid_credentials", "invalid email or password")

func (h *handlers) login(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email    string     `json:"email"`
		Password string     `json:"password"`
		Device   *deviceReq `json:"device"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	in.Email = strings.TrimSpace(in.Email)
	if err := h.limit(w, r, in.Email); err != nil {
		return err
	}
	if in.Email == "" || in.Password == "" || len(in.Password) > MaxPasswordLen {
		return errBadCredentials
	}
	ctx := r.Context()
	var userID uuid.UUID
	var hash *string
	var status string
	err := h.deps.DB.QueryRow(ctx, `SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
		in.Email).Scan(&userID, &hash, &status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	phc := dummyHash
	if hash != nil {
		phc = *hash
	}
	ok, verr := VerifyPassword(in.Password, phc)
	if hash == nil || verr != nil || !ok || status != "active" {
		if userID != uuid.Nil {
			actx := authz.WithPrincipal(ctx, authz.Principal{UserID: userID, ActorType: authz.ActorUser})
			_ = changes.Audit(actx, h.deps.DB, changes.Entry{Action: "auth.login_failed", EntityType: "users", EntityID: &userID, IP: ClientIP(r)})
		}
		return errBadCredentials
	}
	return h.startSession(w, r, userID, in.Device, "password")
}

// startSession signs userID in after a successful password or passkey check: a cookie session
// (+ csrfToken) for the web, or a bearer token for a native device; audited as auth.login.
func (h *handlers) startSession(w http.ResponseWriter, r *http.Request, userID uuid.UUID, device *deviceReq, method string) error {
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var deviceID *uuid.UUID
	kind := "cookie"
	if device != nil {
		d, err := CreateDevice(ctx, tx, userID, *device)
		if err != nil {
			return err
		}
		deviceID = &d.ID
		if d.Platform != "web" {
			kind = "bearer" // native apps / CLI keep a bearer token in secure storage
		}
	}
	token, tokenHash := NewToken()
	var sessionID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO sessions (user_id, device_id, token_hash, kind, ip, user_agent, expires_at)
		VALUES ($1,$2,$3,$4,NULLIF($5,'')::inet,$6,$7) RETURNING id`, userID, deviceID, tokenHash, kind, ClientIP(r),
		truncate(r.UserAgent(), 500), time.Now().Add(h.deps.Config.SessionTTL)).Scan(&sessionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID); err != nil {
		return err
	}
	u, err := users.Get(ctx, tx, userID)
	if err != nil {
		return err
	}
	actx := authz.WithPrincipal(ctx, authz.Principal{UserID: userID, ActorType: authz.ActorUser, SessionID: sessionID, DeviceID: deviceID})
	if err := changes.Audit(actx, tx, changes.Entry{Action: "auth.login", EntityType: "sessions", EntityID: &sessionID,
		IP: ClientIP(r), Metadata: map[string]any{"kind": kind, "method": method}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	resp := loginResp{User: u, DeviceID: deviceID}
	if kind == "cookie" {
		h.setCookie(w, r, token, int(h.deps.Config.SessionTTL.Seconds()))
		resp.CSRFToken = CSRFToken(token)
	} else {
		resp.Token = token
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, resp)
	return nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (h *handlers) setCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	secure := h.deps.Config.CookieSecure || r.TLS != nil ||
		(h.deps.Config.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https")
	if maxAge == 0 {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

func (h *handlers) logout(w http.ResponseWriter, r *http.Request) error {
	p, err := authz.Require(r.Context())
	if err != nil {
		return err
	}
	if p.SessionID == uuid.Nil {
		return httpx.Forbidden()
	}
	if _, err := h.deps.DB.Exec(r.Context(), `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, p.SessionID); err != nil {
		return err
	}
	if err := changes.Audit(r.Context(), h.deps.DB, changes.Entry{Action: "auth.logout", EntityType: "sessions", EntityID: &p.SessionID, IP: ClientIP(r)}); err != nil {
		return err
	}
	if c, _ := credentialFrom(r.Context()); c.viaCookie {
		h.setCookie(w, r, "", 0)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (h *handlers) session(w http.ResponseWriter, r *http.Request) error {
	p, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	u, err := users.Get(r.Context(), h.deps.DB, p.UserID)
	if err != nil {
		return err
	}
	resp := loginResp{User: u, DeviceID: p.DeviceID}
	if c, _ := credentialFrom(r.Context()); c.viaCookie {
		resp.CSRFToken = CSRFToken(c.token)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, resp)
	return nil
}

// requireUserSession: account-management endpoints are for human sessions, never MCP clients.
func requireUserSession(ctx context.Context) (authz.Principal, error) {
	p, err := authz.Require(ctx)
	if err == nil && (p.ActorType != authz.ActorUser || p.SessionID == uuid.Nil) {
		err = authz.ErrForbidden
	}
	return p, err
}

// ---------- password & recovery ----------

func setPassword(ctx context.Context, tx pgx.Tx, userID uuid.UUID, pw string, keepSession uuid.UUID) error {
	hash, err := HashPassword(pw)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, hash); err != nil {
		return err
	}
	// A password change ends every other session (stolen sessions die with the old password).
	_, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, userID, keepSession)
	return err
}

func (h *handlers) changePassword(w http.ResponseWriter, r *http.Request) error {
	p, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := h.limit(w, r, "user:"+p.UserID.String()); err != nil {
		return err
	}
	if msg := checkPassword(in.NewPassword); msg != "" {
		return httpx.Validation(map[string]string{"newPassword": msg})
	}
	ctx := r.Context()
	var hash *string
	if err := h.deps.DB.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, p.UserID).Scan(&hash); err != nil {
		return err
	}
	if hash == nil {
		return httpx.NewError(http.StatusUnauthorized, "invalid_credentials", "current password is incorrect")
	}
	if ok, err := VerifyPassword(in.CurrentPassword, *hash); err != nil || !ok {
		return httpx.NewError(http.StatusUnauthorized, "invalid_credentials", "current password is incorrect")
	}
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := setPassword(ctx, tx, p.UserID, in.NewPassword, p.SessionID); err != nil {
		return err
	}
	if err := changes.Audit(ctx, tx, changes.Entry{Action: "auth.password_change", EntityType: "users", EntityID: &p.UserID, IP: ClientIP(r)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// recoveryCodes replaces all unused recovery codes with a new set (shown once; only hashes stored).
func (h *handlers) recoveryCodes(w http.ResponseWriter, r *http.Request) error {
	p, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM user_recovery_codes WHERE user_id = $1`, p.UserID); err != nil {
		return err
	}
	codes := make([]string, recoveryCodeCount)
	for i := range codes {
		codes[i] = newRecoveryCode()
		if _, err := tx.Exec(ctx, `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, p.UserID, hashRecoveryCode(codes[i])); err != nil {
			return err
		}
	}
	if err := changes.Audit(ctx, tx, changes.Entry{Action: "auth.recovery_codes_generate", EntityType: "users", EntityID: &p.UserID, IP: ClientIP(r)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"codes": codes})
	return nil
}

// recover resets the password with a single-use recovery code (no SMTP needed) and revokes all sessions.
func (h *handlers) recover(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Email       string `json:"email"`
		Code        string `json:"code"`
		NewPassword string `json:"newPassword"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := h.limit(w, r, strings.TrimSpace(in.Email)); err != nil {
		return err
	}
	if msg := checkPassword(in.NewPassword); msg != "" {
		return httpx.Validation(map[string]string{"newPassword": msg})
	}
	bad := httpx.NewError(http.StatusUnauthorized, "invalid_recovery", "invalid email or recovery code")
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var userID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE user_recovery_codes c SET used_at = now() FROM users u
		WHERE c.user_id = u.id AND lower(u.email) = lower($1) AND u.deleted_at IS NULL AND u.status = 'active'
		  AND c.code_hash = $2 AND c.used_at IS NULL RETURNING u.id`, strings.TrimSpace(in.Email), hashRecoveryCode(in.Code)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return bad
	}
	if err != nil {
		return err
	}
	if err := setPassword(ctx, tx, userID, in.NewPassword, uuid.Nil); err != nil {
		return err
	}
	actx := authz.WithPrincipal(ctx, authz.Principal{UserID: userID, ActorType: authz.ActorUser})
	if err := changes.Audit(actx, tx, changes.Entry{Action: "auth.recover", EntityType: "users", EntityID: &userID, IP: ClientIP(r)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---------- sessions ----------

type sessionOut struct {
	ID         uuid.UUID  `json:"id"`
	DeviceID   *uuid.UUID `json:"deviceId"`
	UserAgent  string     `json:"userAgent"`
	IP         *string    `json:"ip"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastSeenAt time.Time  `json:"lastSeenAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	Current    bool       `json:"current"`
}

func (h *handlers) listSessions(w http.ResponseWriter, r *http.Request) error {
	p, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	rows, err := h.deps.DB.Query(r.Context(), `SELECT id, device_id, user_agent, host(ip), created_at, last_seen_at, expires_at
		FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 200`, p.UserID)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (sessionOut, error) {
		var s sessionOut
		err := row.Scan(&s.ID, &s.DeviceID, &s.UserAgent, &s.IP, &s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt)
		s.Current = s.ID == p.SessionID
		return s, err
	})
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.List[sessionOut]{Items: items})
	return nil
}

func (h *handlers) revokeSession(w http.ResponseWriter, r *http.Request) error {
	p, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return httpx.NotFound("session")
	}
	tag, err := h.deps.DB.Exec(r.Context(), `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, id, p.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("session")
	}
	if err := changes.Audit(r.Context(), h.deps.DB, changes.Entry{Action: "auth.session_revoke", EntityType: "sessions", EntityID: &id, IP: ClientIP(r)}); err != nil {
		return err
	}
	if c, _ := credentialFrom(r.Context()); c.viaCookie && id == p.SessionID {
		h.setCookie(w, r, "", 0)
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
