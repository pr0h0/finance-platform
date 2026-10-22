package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

const (
	CookieName = "finplat_session"
	CSRFHeader = "X-CSRF-Token"
)

type tokenKey struct{}

// credential is how the current request authenticated.
type credential struct {
	token     string
	viaCookie bool
}

func credentialFrom(ctx context.Context) (credential, bool) {
	c, ok := ctx.Value(tokenKey{}).(credential)
	return c, ok
}

// csrfExempt: endpoints that do not act on the current session (they authenticate by body).
var csrfExempt = map[string]bool{
	"/api/v1/auth/login": true, "/api/v1/auth/register": true, "/api/v1/auth/recover": true,
}

func unsafeMethod(m string) bool {
	return m != http.MethodGet && m != http.MethodHead && m != http.MethodOptions
}

// Middleware resolves the session cookie / bearer token into an authz.Principal on the request
// context and enforces CSRF for cookie-authenticated unsafe requests (X-CSRF-Token must equal the
// token returned by login / GET /auth/session).
//
// Bearer tokens: device/CLI sessions (sessions.kind = 'bearer'). On /mcp paths only, a bearer token
// may also be an MCP client token (mcp_clients.token_hash = sha256(token), see HashToken) or an OAuth access
// token issued for this server's /mcp resource (mcp_oauth_tokens, internal/mcp/oauth.go); MCP
// principals are never accepted on /api/v1, so an MCP token cannot use the full REST API.
func Middleware(deps *app.Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cred := credential{}
			if h := r.Header.Get("Authorization"); h != "" {
				tok, ok := strings.CutPrefix(h, "Bearer ")
				if !ok && strings.HasPrefix(r.URL.Path, "/oauth/") {
					next.ServeHTTP(w, r) // OAuth token/revoke endpoints read client credentials themselves
					return
				}
				if !ok || tok == "" {
					httpx.WriteError(w, r, httpx.Unauthorized())
					return
				}
				cred.token = strings.TrimSpace(tok)
			} else if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
				cred = credential{token: c.Value, viaCookie: true}
			}
			if cred.token == "" {
				next.ServeHTTP(w, r)
				return
			}
			p, ok, err := resolve(r, deps, cred)
			if err != nil {
				httpx.WriteError(w, r, err)
				return
			}
			if !ok {
				if !cred.viaCookie {
					// An explicit but invalid bearer token is an error, not anonymous access.
					if isMCPPath(r.URL.Path) { // RFC 9728: point MCP clients at the OAuth metadata
						w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="`+deps.Config.PublicURL+`/.well-known/oauth-protected-resource/mcp"`)
					}
					httpx.WriteError(w, r, httpx.NewError(http.StatusUnauthorized, "invalid_token", "token invalid, expired or revoked"))
					return
				}
				next.ServeHTTP(w, r) // stale cookie: behave as anonymous
				return
			}
			if cred.viaCookie && unsafeMethod(r.Method) && !csrfExempt[r.URL.Path] &&
				subtle.ConstantTimeCompare([]byte(r.Header.Get(CSRFHeader)), []byte(CSRFToken(cred.token))) != 1 {
				httpx.WriteError(w, r, httpx.NewError(http.StatusForbidden, "csrf_failed", "missing or invalid X-CSRF-Token header"))
				return
			}
			ctx := authz.WithPrincipal(r.Context(), p)
			ctx = context.WithValue(ctx, tokenKey{}, cred)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func resolve(r *http.Request, deps *app.Deps, cred credential) (authz.Principal, bool, error) {
	ctx := r.Context()
	hash := HashToken(cred.token)
	var p authz.Principal
	var kind string
	err := deps.DB.QueryRow(ctx, `SELECT s.id, s.user_id, s.device_id, s.kind, u.is_admin
		FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN devices d ON d.id = s.device_id
		WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
		  AND u.status = 'active' AND u.deleted_at IS NULL AND d.revoked_at IS NULL`, hash).
		Scan(&p.SessionID, &p.UserID, &p.DeviceID, &kind, &p.IsAdmin)
	switch {
	case err == nil:
		if (kind == "cookie") != cred.viaCookie {
			return p, false, nil // a cookie token is not a bearer token and vice versa
		}
		p.ActorType = authz.ActorUser
		_, err = deps.DB.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, p.SessionID)
		if err == nil && p.DeviceID != nil {
			_, err = deps.DB.Exec(ctx, `UPDATE devices SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`, *p.DeviceID)
		}
		return p, true, err
	case !errors.Is(err, pgx.ErrNoRows):
		return p, false, err
	}
	if cred.viaCookie || !isMCPPath(r.URL.Path) {
		return p, false, nil
	}
	var clientID uuid.UUID
	// Static client token, or an OAuth access token whose audience (RFC 8707) is this server's /mcp.
	err = deps.DB.QueryRow(ctx, `SELECT c.id, c.user_id FROM mcp_clients c JOIN users u ON u.id = c.user_id
		WHERE (c.token_hash = $1 OR c.id = (SELECT t.mcp_client_id FROM mcp_oauth_tokens t WHERE t.token_hash = $1 AND t.kind = 'access'
		    AND t.revoked_at IS NULL AND t.expires_at > now() AND t.resource = $2))
		  AND c.enabled AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
		  AND u.status = 'active' AND u.deleted_at IS NULL`, hash, deps.Config.PublicURL+"/mcp").Scan(&clientID, &p.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, err
	}
	p.ActorType, p.MCPClientID = authz.ActorMCP, &clientID
	_, err = deps.DB.Exec(ctx, `UPDATE mcp_clients SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, clientID)
	return p, true, err
}

func isMCPPath(p string) bool { return p == "/mcp" || strings.HasPrefix(p, "/mcp/") }
