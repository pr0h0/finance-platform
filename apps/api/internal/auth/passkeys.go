package auth

// Passkeys (WebAuthn, github.com/go-webauthn/webauthn): a second way to sign in, added from
// Settings once an account exists (registration stays password-first). Routes:
//
//	POST   /auth/passkeys/register/begin|finish  signed-in session; fresh session or password re-auth
//	POST   /auth/passkeys/login/begin|finish     anonymous; discoverable credentials, optional email-first
//	GET    /auth/passkeys                        list
//	PATCH  /auth/passkeys/{id}                   rename
//	DELETE /auth/passkeys/{id}                   refused when it is the account's last way to sign in
//
// Ceremonies (webauthn_ceremonies) are single use (finish deletes the row) and expire after
// ceremonyTTL. Passkey login creates the same session as password login (startSession), behind the
// same rate limits and audit log.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

const (
	ceremonyTTL = 5 * time.Minute
	// freshSession: a session this young may add a passkey without re-entering the password.
	freshSession = 10 * time.Minute
)

var (
	errPasskeyFailed   = httpx.NewError(http.StatusUnauthorized, "passkey_failed", "passkey sign-in failed")
	errCeremonyInvalid = httpx.NewError(http.StatusBadRequest, "passkey_ceremony_invalid", "passkey request expired or already used; try again")
)

func newWebAuthn(c *config.Config) (*webauthn.WebAuthn, error) {
	return webauthn.New(&webauthn.Config{
		RPID:                  c.WebAuthnRPID,
		RPDisplayName:         "Finance Platform",
		RPOrigins:             c.WebAuthnOrigins,
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: protocol.ResidentKeyRequired(),
			UserVerification:   protocol.VerificationPreferred,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL, TimeoutUVD: ceremonyTTL},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL, TimeoutUVD: ceremonyTTL},
		},
	})
}

func registerPasskeys(r chi.Router, h *handlers) {
	wa, err := newWebAuthn(h.deps.Config)
	if err != nil && h.deps.Log != nil && h.deps.DB != nil {
		h.deps.Log.Warn("passkeys disabled: invalid WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS", "err", err)
	}
	p := &passkeys{h: h, wa: wa}
	r.Post("/auth/passkeys/register/begin", httpx.H(p.registerBegin))
	r.Post("/auth/passkeys/register/finish", httpx.H(p.registerFinish))
	r.Post("/auth/passkeys/login/begin", httpx.H(p.loginBegin))
	r.Post("/auth/passkeys/login/finish", httpx.H(p.loginFinish))
	r.Get("/auth/passkeys", httpx.H(p.list))
	r.Patch("/auth/passkeys/{id}", httpx.H(p.rename))
	r.Delete("/auth/passkeys/{id}", httpx.H(p.remove))
}

type passkeys struct {
	h  *handlers
	wa *webauthn.WebAuthn // nil when the RP config is invalid
}

func (p *passkeys) ready() error {
	if p.wa == nil {
		return httpx.NewError(http.StatusServiceUnavailable, "passkeys_unavailable", "passkeys are not configured on this server")
	}
	return nil
}

// dbtx is satisfied by *pgxpool.Pool and pgx.Tx.
type dbtx interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ---------- webauthn.User ----------

type passkeyUser struct {
	id          uuid.UUID
	email, name string
	hasPassword bool
	creds       []webauthn.Credential
}

func (u *passkeyUser) WebAuthnID() []byte                         { return u.id[:] }
func (u *passkeyUser) WebAuthnName() string                       { return u.email }
func (u *passkeyUser) WebAuthnDisplayName() string                { return u.name }
func (u *passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// loadUser returns an active user with their passkeys (pgx.ErrNoRows when missing or inactive).
func loadUser(ctx context.Context, q dbtx, id uuid.UUID) (*passkeyUser, error) {
	u := &passkeyUser{id: id}
	if err := q.QueryRow(ctx, `SELECT email, coalesce(nullif(display_name, ''), email), password_hash IS NOT NULL
		FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, id).Scan(&u.email, &u.name, &u.hasPassword); err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `SELECT credential_id, public_key, attestation_type, attestation_format, aaguid, sign_count,
		transports, attachment, user_present, user_verified, backup_eligible, backup_state
		FROM user_passkeys WHERE user_id = $1 ORDER BY created_at`, id)
	if err != nil {
		return nil, err
	}
	u.creds, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (webauthn.Credential, error) {
		var c webauthn.Credential
		var count int64
		var transports []string
		var attachment string
		err := row.Scan(&c.ID, &c.PublicKey, &c.AttestationType, &c.AttestationFormat, &c.Authenticator.AAGUID, &count,
			&transports, &attachment, &c.Flags.UserPresent, &c.Flags.UserVerified, &c.Flags.BackupEligible, &c.Flags.BackupState)
		c.Authenticator.SignCount = uint32(count)
		c.Authenticator.Attachment = protocol.AuthenticatorAttachment(attachment)
		for _, t := range transports {
			c.Transport = append(c.Transport, protocol.AuthenticatorTransport(t))
		}
		return c, err
	})
	return u, err
}

// ---------- ceremonies ----------

func saveCeremony(ctx context.Context, q dbtx, kind string, sessionID, expectedUser *uuid.UUID, sd *webauthn.SessionData) (uuid.UUID, error) {
	data, err := json.Marshal(sd)
	if err != nil {
		return uuid.Nil, err
	}
	if _, err := q.Exec(ctx, `DELETE FROM webauthn_ceremonies WHERE expires_at < now()`); err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = q.QueryRow(ctx, `INSERT INTO webauthn_ceremonies (kind, session_id, expected_user, data, expires_at)
		VALUES ($1, $2, $3, $4, $5) RETURNING id`, kind, sessionID, expectedUser, data, time.Now().Add(ceremonyTTL)).Scan(&id)
	return id, err
}

// takeCeremony consumes (deletes) a live ceremony; a second finish with the same id fails.
func takeCeremony(ctx context.Context, q dbtx, id uuid.UUID, kind string, sessionID *uuid.UUID) (webauthn.SessionData, *uuid.UUID, error) {
	var sd webauthn.SessionData
	var data []byte
	var expected *uuid.UUID
	err := q.QueryRow(ctx, `DELETE FROM webauthn_ceremonies WHERE id = $1 AND kind = $2 AND expires_at > now()
		AND session_id IS NOT DISTINCT FROM $3 RETURNING data, expected_user`, id, kind, sessionID).Scan(&data, &expected)
	if errors.Is(err, pgx.ErrNoRows) {
		return sd, nil, errCeremonyInvalid
	}
	if err != nil {
		return sd, nil, err
	}
	return sd, expected, json.Unmarshal(data, &sd)
}

// ---------- registration ----------

func (p *passkeys) registerBegin(w http.ResponseWriter, r *http.Request) error {
	if err := p.ready(); err != nil {
		return err
	}
	pr, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	var in struct {
		Password string `json:"password"`
	}
	if r.ContentLength != 0 {
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
	}
	if err := p.h.limit(w, r, "user:"+pr.UserID.String()); err != nil {
		return err
	}
	ctx := r.Context()
	var fresh bool
	var hash *string
	if err := p.h.deps.DB.QueryRow(ctx, `SELECT s.created_at > now() - make_interval(secs => $2), u.password_hash
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, pr.SessionID, freshSession.Seconds()).Scan(&fresh, &hash); err != nil {
		return err
	}
	if !fresh {
		ok := false
		if hash != nil && in.Password != "" && len(in.Password) <= MaxPasswordLen {
			ok, _ = VerifyPassword(in.Password, *hash)
		}
		if !ok {
			return httpx.NewError(http.StatusUnauthorized, "reauth_required", "confirm your password to add a passkey")
		}
	}
	u, err := loadUser(ctx, p.h.deps.DB, pr.UserID)
	if err != nil {
		return err
	}
	exclude := webauthn.Credentials(u.creds).CredentialDescriptors()
	creation, sd, err := p.wa.BeginRegistration(u, webauthn.WithExclusions(exclude),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired))
	if err != nil {
		return err
	}
	id, err := saveCeremony(ctx, p.h.deps.DB, "register", &pr.SessionID, nil, sd)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ceremonyId": id, "options": creation.Response})
	return nil
}

type passkeyOut struct {
	ID             uuid.UUID  `json:"id"`
	Name           string     `json:"name"`
	Transports     []string   `json:"transports"`
	BackupEligible bool       `json:"backupEligible"`
	BackupState    bool       `json:"backupState"`
	CreatedAt      time.Time  `json:"createdAt"`
	LastUsedAt     *time.Time `json:"lastUsedAt"`
}

const passkeyColumns = `id, name, transports, backup_eligible, backup_state, created_at, last_used_at`

func scanPasskey(row pgx.Row) (passkeyOut, error) {
	var k passkeyOut
	err := row.Scan(&k.ID, &k.Name, &k.Transports, &k.BackupEligible, &k.BackupState, &k.CreatedAt, &k.LastUsedAt)
	return k, err
}

func validName(name *string, def string) error {
	*name = strings.TrimSpace(*name)
	if *name == "" {
		*name = def
	}
	if *name == "" || len([]rune(*name)) > 100 {
		return httpx.Validation(map[string]string{"name": "1-100 characters"})
	}
	return nil
}

func (p *passkeys) registerFinish(w http.ResponseWriter, r *http.Request) error {
	if err := p.ready(); err != nil {
		return err
	}
	pr, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	var in struct {
		CeremonyID uuid.UUID       `json:"ceremonyId"`
		Name       string          `json:"name"`
		Credential json.RawMessage `json:"credential"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := validName(&in.Name, "Passkey"); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := p.h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	sd, _, err := takeCeremony(ctx, tx, in.CeremonyID, "register", &pr.SessionID)
	if err != nil {
		return err
	}
	u, err := loadUser(ctx, tx, pr.UserID)
	if err != nil {
		return err
	}
	bad := httpx.NewError(http.StatusBadRequest, "passkey_invalid", "the passkey could not be verified")
	parsed, err := protocol.ParseCredentialCreationResponseBytes(in.Credential)
	if err != nil {
		return bad
	}
	cred, err := p.wa.CreateCredential(u, sd, parsed)
	if err != nil {
		return bad
	}
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	k, err := scanPasskey(tx.QueryRow(ctx, `INSERT INTO user_passkeys (user_id, credential_id, public_key, attestation_type,
		attestation_format, aaguid, sign_count, transports, attachment, user_present, user_verified, backup_eligible, backup_state, name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING `+passkeyColumns,
		pr.UserID, cred.ID, cred.PublicKey, cred.AttestationType, cred.AttestationFormat, cred.Authenticator.AAGUID,
		int64(cred.Authenticator.SignCount), transports, string(cred.Authenticator.Attachment), cred.Flags.UserPresent,
		cred.Flags.UserVerified, cred.Flags.BackupEligible, cred.Flags.BackupState, in.Name))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return httpx.NewError(http.StatusConflict, "passkey_exists", "this passkey is already registered")
	}
	if err != nil {
		return err
	}
	if err := changes.Audit(ctx, tx, changes.Entry{Action: "auth.passkey_add", EntityType: "user_passkeys", EntityID: &k.ID,
		IP: ClientIP(r), Metadata: map[string]any{"name": k.Name}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusCreated, k)
	return nil
}

// ---------- login ----------

func (p *passkeys) loginBegin(w http.ResponseWriter, r *http.Request) error {
	if err := p.ready(); err != nil {
		return err
	}
	var in struct {
		Email string `json:"email"`
	}
	if r.ContentLength != 0 {
		if err := httpx.DecodeJSON(r, &in); err != nil {
			return err
		}
	}
	in.Email = strings.TrimSpace(in.Email)
	if err := p.h.limit(w, r, in.Email); err != nil {
		return err
	}
	ctx := r.Context()
	// Every credential is discoverable (resident keys are required at registration), so options never
	// list credentials: email-first only pins who may finish, and an unknown email looks the same.
	var expected *uuid.UUID
	if in.Email != "" {
		id := uuid.New()
		err := p.h.deps.DB.QueryRow(ctx, `SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`, in.Email).Scan(&id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		expected = &id
	}
	assertion, sd, err := p.wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationPreferred))
	if err != nil {
		return err
	}
	id, err := saveCeremony(ctx, p.h.deps.DB, "login", nil, expected, sd)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ceremonyId": id, "options": assertion.Response})
	return nil
}

func (p *passkeys) loginFinish(w http.ResponseWriter, r *http.Request) error {
	if err := p.ready(); err != nil {
		return err
	}
	var in struct {
		CeremonyID uuid.UUID       `json:"ceremonyId"`
		Credential json.RawMessage `json:"credential"`
		Device     *deviceReq      `json:"device"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := p.h.limit(w, r, ""); err != nil {
		return err
	}
	ctx := r.Context()
	sd, expected, err := takeCeremony(ctx, p.h.deps.DB, in.CeremonyID, "login", nil)
	if err != nil {
		return err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(in.Credential)
	if err != nil {
		return errPasskeyFailed
	}
	var user *passkeyUser
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		id, err := uuid.FromBytes(userHandle)
		if err != nil {
			return nil, err
		}
		if user, err = loadUser(ctx, p.h.deps.DB, id); err != nil {
			return nil, err
		}
		return user, nil
	}
	_, cred, verr := p.wa.ValidatePasskeyLogin(handler, sd, parsed)
	if user != nil {
		if err := p.h.limit(w, r, user.email); err != nil {
			return err
		}
	}
	fail := func(reason string) error {
		if user != nil {
			actx := authz.WithPrincipal(ctx, authz.Principal{UserID: user.id, ActorType: authz.ActorUser})
			_ = changes.Audit(actx, p.h.deps.DB, changes.Entry{Action: "auth.login_failed", EntityType: "users", EntityID: &user.id,
				IP: ClientIP(r), Metadata: map[string]any{"method": "passkey", "reason": reason}})
		}
		return errPasskeyFailed
	}
	switch {
	case verr != nil:
		return fail("verification")
	case expected != nil && *expected != user.id:
		return fail("wrong_account")
	case cred.Authenticator.CloneWarning:
		// The signature counter went backwards: a copy of the private key may exist. Refuse (go-webauthn leaves
		// the decision to the RP); the user can remove the passkey and sign in with the password.
		return fail("clone_warning")
	}
	if _, err := p.h.deps.DB.Exec(ctx, `UPDATE user_passkeys SET sign_count = $3, user_verified = $4, backup_state = $5,
		last_used_at = now() WHERE user_id = $1 AND credential_id = $2`, user.id, cred.ID, int64(cred.Authenticator.SignCount),
		cred.Flags.UserVerified, cred.Flags.BackupState); err != nil {
		return err
	}
	return p.h.startSession(w, r, user.id, in.Device, "passkey")
}

// ---------- management ----------

func (p *passkeys) list(w http.ResponseWriter, r *http.Request) error {
	pr, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	rows, err := p.h.deps.DB.Query(r.Context(), `SELECT `+passkeyColumns+` FROM user_passkeys WHERE user_id = $1 ORDER BY created_at`, pr.UserID)
	if err != nil {
		return err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (passkeyOut, error) { return scanPasskey(row) })
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.List[passkeyOut]{Items: items})
	return nil
}

func (p *passkeys) rename(w http.ResponseWriter, r *http.Request) error {
	pr, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return httpx.NotFound("passkey")
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if err := validName(&in.Name, ""); err != nil {
		return err
	}
	k, err := scanPasskey(p.h.deps.DB.QueryRow(r.Context(), `UPDATE user_passkeys SET name = $3 WHERE id = $1 AND user_id = $2
		RETURNING `+passkeyColumns, id, pr.UserID, in.Name))
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("passkey")
	}
	if err != nil {
		return err
	}
	if err := changes.Audit(r.Context(), p.h.deps.DB, changes.Entry{Action: "auth.passkey_rename", EntityType: "user_passkeys", EntityID: &id, IP: ClientIP(r)}); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, k)
	return nil
}

func (p *passkeys) remove(w http.ResponseWriter, r *http.Request) error {
	pr, err := requireUserSession(r.Context())
	if err != nil {
		return err
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return httpx.NotFound("passkey")
	}
	ctx := r.Context()
	tx, err := p.h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Lock the user row so two concurrent deletes cannot both pass the last-credential check.
	var hasPassword bool
	var others int
	if err := tx.QueryRow(ctx, `SELECT password_hash IS NOT NULL FROM users WHERE id = $1 FOR UPDATE`, pr.UserID).Scan(&hasPassword); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM user_passkeys WHERE user_id = $1 AND id <> $2`, pr.UserID, id).Scan(&others); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2`, id, pr.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("passkey")
	}
	if !hasPassword && others == 0 {
		return httpx.NewError(http.StatusConflict, "last_credential", "this is your only way to sign in; set a password or add another passkey first")
	}
	if err := changes.Audit(ctx, tx, changes.Entry{Action: "auth.passkey_remove", EntityType: "user_passkeys", EntityID: &id, IP: ClientIP(r)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
