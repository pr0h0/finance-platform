package mcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// OAuth 2.1 for the remote MCP endpoint (MCP authorization spec): protected resource metadata
// (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591, public
// clients only), authorization code + PKCE S256, resource indicators (RFC 8707: tokens are bound to
// <PUBLIC_URL>/mcp and checked by auth.Middleware), rotating refresh tokens with reuse detection and
// revocation (RFC 7009). Consent happens in the web app (/agents/authorize): the user picks profiles,
// capabilities and restrictions, which become an mcp_clients row with ordinary grants, so approvals,
// audit and revocation are identical to static-token clients. Only sha256 hashes are stored.

const (
	accessTTL     = time.Hour
	refreshTTL    = 30 * 24 * time.Hour
	codeTTL       = 10 * time.Minute
	accessPrefix  = "fpa_"
	refreshPrefix = "fpr_"
)

func (h *handlers) issuer() string   { return h.deps.Config.PublicURL }
func (h *handlers) resource() string { return h.deps.Config.PublicURL + "/mcp" }

// RegisterOAuth mounts the discovery documents and OAuth endpoints at the server root.
func RegisterOAuth(r chi.Router, deps *app.Deps) {
	h := &handlers{deps: deps}
	limit := auth.RateLimit(auth.NewLimiter(deps.Config.RateLimitAuthPM))
	r.Group(func(g chi.Router) {
		g.Use(h.oauthEnabled, publicCORS)
		for _, p := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
			"/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"} {
			g.Options(p, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
		}
		g.Get("/.well-known/oauth-protected-resource", h.resourceMetadata)
		g.Get("/.well-known/oauth-protected-resource/mcp", h.resourceMetadata)
		g.Get("/.well-known/oauth-authorization-server", h.serverMetadata)
		g.Get("/oauth/authorize", h.authorizeRedirect)
		g.With(limit).Post("/oauth/register", h.register)
		g.With(limit).Post("/oauth/token", h.token)
		g.With(limit).Post("/oauth/revoke", h.revoke)
	})
}

func (h *handlers) oauthEnabled(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.deps.Config.MCPEnabled {
			httpx.WriteError(w, r, httpx.NewError(http.StatusNotFound, "mcp_disabled", "MCP is disabled on this server (MCP_ENABLED=false)"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// publicCORS: discovery, registration and token endpoints take no cookies, so any origin may call
// them (browser-based MCP clients).
func publicCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Access-Control-Allow-Origin", "*")
		hd.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		hd.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
		next.ServeHTTP(w, r)
	})
}

func allScopes() []string { return append(slices.Clone(readScopes), writeScopes...) }

func (h *handlers) resourceMetadata(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"resource": h.resource(), "authorization_servers": []string{h.issuer()}, "bearer_methods_supported": []string{"header"},
		"scopes_supported": allScopes(), "resource_name": "Finance Platform",
		"resource_documentation": "https://github.com/pr0h0/finance-platform/blob/main/docs/mcp/README.md",
	})
}

func (h *handlers) serverMetadata(w http.ResponseWriter, _ *http.Request) {
	iss := h.issuer()
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"issuer": iss, "authorization_endpoint": iss + "/oauth/authorize", "token_endpoint": iss + "/oauth/token",
		"registration_endpoint": iss + "/oauth/register", "revocation_endpoint": iss + "/oauth/revoke",
		"response_types_supported": []string{"code"}, "response_modes_supported": []string{"query"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"revocation_endpoint_auth_methods_supported":     []string{"none"},
		"scopes_supported":                               allScopes(),
		"authorization_response_iss_parameter_supported": true,
	})
}

// oauthJSON writes an RFC 6749 §5.2 error.
func oauthJSON(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

// validRedirect: absolute https URL, or http on a loopback host (native clients, RFC 8252); no
// fragment or userinfo. Matching at /authorize is exact string equality.
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2000 || strings.Contains(raw, "#") || u.User != nil || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	}
	return false
}

func (h *handlers) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RedirectURIs  []string `json:"redirect_uris"`
		ClientName    string   `json:"client_name"`
		ClientURI     string   `json:"client_uri"`
		GrantTypes    []string `json:"grant_types"`
		ResponseTypes []string `json:"response_types"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		oauthJSON(w, http.StatusBadRequest, "invalid_client_metadata", "body must be a JSON client metadata object")
		return
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 {
		oauthJSON(w, http.StatusBadRequest, "invalid_redirect_uri", "1 to 10 redirect_uris are required")
		return
	}
	for _, u := range in.RedirectURIs {
		if !validRedirect(u) {
			oauthJSON(w, http.StatusBadRequest, "invalid_redirect_uri", "redirect URIs must be https, or http on localhost/127.0.0.1/[::1], without fragment: "+u)
			return
		}
	}
	for _, g := range in.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			oauthJSON(w, http.StatusBadRequest, "invalid_client_metadata", "unsupported grant type "+g)
			return
		}
	}
	for _, t := range in.ResponseTypes {
		if t != "code" {
			oauthJSON(w, http.StatusBadRequest, "invalid_client_metadata", "unsupported response type "+t)
			return
		}
	}
	name := strings.TrimSpace(in.ClientName)
	if name == "" {
		name = "MCP client"
	}
	if rs := []rune(name); len(rs) > 100 {
		name = string(rs[:100])
	}
	var clientURI *string
	if u, err := url.Parse(in.ClientURI); err == nil && u.Scheme == "https" && u.Host != "" && len(in.ClientURI) <= 2000 {
		clientURI = &in.ClientURI
	}
	var id uuid.UUID
	var created time.Time
	if err := h.deps.DB.QueryRow(r.Context(), `INSERT INTO mcp_oauth_clients (client_name, client_uri, redirect_uris) VALUES ($1,$2,$3)
		RETURNING id, created_at`, name, clientURI, in.RedirectURIs).Scan(&id, &created); err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusCreated, map[string]any{
		"client_id": id.String(), "client_id_issued_at": created.Unix(), "client_name": name, "client_uri": clientURI,
		"redirect_uris": in.RedirectURIs, "grant_types": []string{"authorization_code", "refresh_token"},
		"response_types": []string{"code"}, "token_endpoint_auth_method": "none",
	})
}

type oauthClient struct {
	ID           uuid.UUID
	Name         string
	URI          *string
	RedirectURIs []string
}

// authRequest is a validated authorization request (RFC 6749 §4.1.1 + PKCE + RFC 8707).
type authRequest struct {
	client      oauthClient
	redirectURI string
	state       string
	challenge   string
	resource    string
	scopes      []string // requested scopes we know; only preselects the consent form
}

// authError: redirect=false means the error must be shown to the user, never sent to the redirect URI
// (unknown client or unregistered redirect URI, RFC 6749 §4.1.2.1).
type authError struct {
	code, desc string
	redirect   bool
}

func (h *handlers) parseAuthorize(ctx context.Context, q url.Values) (authRequest, *authError) {
	var a authRequest
	id, err := uuid.Parse(q.Get("client_id"))
	if err == nil {
		err = h.deps.DB.QueryRow(ctx, `SELECT id, client_name, client_uri, redirect_uris FROM mcp_oauth_clients WHERE id = $1`, id).
			Scan(&a.client.ID, &a.client.Name, &a.client.URI, &a.client.RedirectURIs)
	}
	if err != nil {
		return a, &authError{"invalid_client", "unknown client_id; register the client first (" + h.issuer() + "/oauth/register)", false}
	}
	a.redirectURI = q.Get("redirect_uri")
	if !slices.Contains(a.client.RedirectURIs, a.redirectURI) {
		return a, &authError{"invalid_request", "redirect_uri is not registered for this client (exact match required)", false}
	}
	a.state = q.Get("state")
	if q.Get("response_type") != "code" {
		return a, &authError{"unsupported_response_type", "only response_type=code is supported", true}
	}
	a.challenge = q.Get("code_challenge")
	if q.Get("code_challenge_method") != "S256" || len(a.challenge) < 43 || len(a.challenge) > 128 {
		return a, &authError{"invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256", true}
	}
	a.resource = h.resource()
	if res := q.Get("resource"); res != "" && strings.TrimRight(res, "/") != a.resource {
		return a, &authError{"invalid_target", "resource must be " + a.resource, true}
	}
	for _, s := range strings.Fields(q.Get("scope")) {
		if slices.Contains(allScopes(), s) && !slices.Contains(a.scopes, s) {
			a.scopes = append(a.scopes, s)
		}
	}
	return a, nil
}

// withParams adds query parameters to a redirect URI, keeping its own query.
func withParams(raw string, kv map[string]string) string {
	u, _ := url.Parse(raw)
	q := u.Query()
	for k, v := range kv {
		if v != "" {
			q.Set(k, v)
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func (h *handlers) errorRedirect(a authRequest, e *authError) string {
	return withParams(a.redirectURI, map[string]string{"error": e.code, "error_description": e.desc, "state": a.state, "iss": h.issuer()})
}

// authorizeRedirect (GET /oauth/authorize) validates the request and sends the browser to the
// consent page of the web app, which signs the user in first if needed.
func (h *handlers) authorizeRedirect(w http.ResponseWriter, r *http.Request) {
	a, e := h.parseAuthorize(r.Context(), r.URL.Query())
	switch {
	case e != nil && !e.redirect:
		oauthJSON(w, http.StatusBadRequest, e.code, e.desc)
	case e != nil:
		http.Redirect(w, r, h.errorRedirect(a, e), http.StatusFound)
	default:
		http.Redirect(w, r, h.issuer()+"/agents/authorize?"+r.URL.Query().Encode(), http.StatusFound)
	}
}

func (h *handlers) humanAuthorize(r *http.Request) (authRequest, authz.Principal, error) {
	p, err := requireHuman(r)
	if err != nil {
		return authRequest{}, p, err
	}
	a, e := h.parseAuthorize(r.Context(), r.URL.Query())
	if e != nil {
		return a, p, httpx.NewError(http.StatusBadRequest, e.code, e.desc)
	}
	return a, p, nil
}

// describeAuthorize (GET /api/v1/mcp/oauth/authorize?<authorization request>) tells the consent page
// who is asking, and the user's current grants if this client is already connected.
func (h *handlers) describeAuthorize(w http.ResponseWriter, r *http.Request) error {
	a, p, err := h.humanAuthorize(r)
	if err != nil {
		return err
	}
	u, _ := url.Parse(a.redirectURI)
	out := map[string]any{"clientId": a.client.ID, "clientName": a.client.Name, "clientUri": a.client.URI, "redirectUri": a.redirectURI,
		"redirectHost": u.Host, "resource": a.resource, "requestedScopes": a.scopes, "connection": nil}
	if a.scopes == nil {
		out["requestedScopes"] = []string{}
	}
	var id uuid.UUID
	err = h.deps.DB.QueryRow(r.Context(), `SELECT id FROM mcp_clients WHERE user_id = $1 AND oauth_client_id = $2 AND revoked_at IS NULL`, p.UserID, a.client.ID).Scan(&id)
	if err == nil {
		c, err := h.getClient(r.Context(), p.UserID, id)
		if err != nil {
			return err
		}
		out["connection"] = c
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

// approveAuthorize (POST /api/v1/mcp/oauth/authorize?<authorization request>) records the user's
// decision. Approval creates or updates the connection (one per user and OAuth client), replaces its
// grants and issues a single-use code; the page then navigates to redirectUrl.
func (h *handlers) approveAuthorize(w http.ResponseWriter, r *http.Request) error {
	a, p, err := h.humanAuthorize(r)
	if err != nil {
		return err
	}
	var in struct {
		Approve bool    `json:"approve"`
		Grants  []Grant `json:"grants"`
	}
	if err := httpx.DecodeJSON(r, &in); err != nil {
		return err
	}
	if !in.Approve {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"redirectUrl": h.errorRedirect(a, &authError{"access_denied", "the user denied access", true})})
		return nil
	}
	if len(in.Grants) == 0 || len(in.Grants) > 200 {
		return httpx.Validation(map[string]string{"grants": "grant at least one capability (at most 200)"})
	}
	if err := h.validateGrants(r.Context(), in.Grants); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE mcp_clients SET enabled = true, name = $3, updated_at = now()
		WHERE user_id = $1 AND oauth_client_id = $2 AND revoked_at IS NULL RETURNING id`, p.UserID, a.client.ID, a.client.Name).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		id = uuid.New()
		_, unusable := auth.NewToken() // OAuth connections have no static token
		u, _ := url.Parse(a.redirectURI)
		if _, err = tx.Exec(ctx, `INSERT INTO mcp_clients (id, user_id, name, description, token_hash, token_prefix, oauth_client_id)
			VALUES ($1,$2,$3,$4,$5,'oauth',$6)`, id, p.UserID, a.client.Name, "OAuth · "+u.Host, unusable, a.client.ID); err != nil {
			return err
		}
		err = changes.Audit(ctx, tx, changes.Entry{Action: "mcp.client.create", EntityType: "mcp_clients", EntityID: &id,
			Metadata: map[string]any{"name": a.client.Name, "oauth": true}})
	}
	if err != nil {
		return err
	}
	if err := replaceGrants(ctx, tx, id, in.Grants); err != nil {
		return err
	}
	code, hash := auth.NewToken()
	if _, err := tx.Exec(ctx, `INSERT INTO mcp_oauth_codes (code_hash, mcp_client_id, family_id, redirect_uri, code_challenge, resource, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`, hash, id, uuid.New(), a.redirectURI, a.challenge, a.resource, time.Now().Add(codeTTL)); err != nil {
		return err
	}
	if err := changes.Audit(ctx, tx, changes.Entry{Action: "mcp.oauth.authorize", EntityType: "mcp_clients", EntityID: &id,
		Metadata: map[string]any{"oauthClientId": a.client.ID, "redirectUri": a.redirectURI}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"redirectUrl": withParams(a.redirectURI, map[string]string{"code": code, "state": a.state, "iss": h.issuer()})})
	return nil
}

func pkceOK(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// activeSQL: the connection is usable (same conditions as auth.Middleware).
const activeSQL = `m.enabled AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND u.status = 'active' AND u.deleted_at IS NULL`

func (h *handlers) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if err := r.ParseForm(); err != nil {
		oauthJSON(w, http.StatusBadRequest, "invalid_request", "body must be application/x-www-form-urlencoded")
		return
	}
	f := r.PostForm
	clientID := f.Get("client_id")
	if u, _, ok := r.BasicAuth(); ok && clientID == "" {
		clientID = u
	}
	if clientID == "" {
		oauthJSON(w, http.StatusUnauthorized, "invalid_client", "client_id is required")
		return
	}
	var res string
	if v := f.Get("resource"); v != "" {
		if res = strings.TrimRight(v, "/"); res != h.resource() {
			oauthJSON(w, http.StatusBadRequest, "invalid_target", "resource must be "+h.resource())
			return
		}
	}
	ctx := r.Context()
	tx, err := h.deps.DB.Begin(ctx)
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	defer tx.Rollback(ctx)
	var conn, family uuid.UUID
	var oauthID *uuid.UUID
	var resource string
	var used, dead, active bool
	fail := func(msg string) { oauthJSON(w, http.StatusBadRequest, "invalid_grant", msg) }
	switch f.Get("grant_type") {
	case "authorization_code":
		var redirect, challenge string
		err = tx.QueryRow(ctx, `SELECT c.mcp_client_id, m.oauth_client_id, c.family_id, c.redirect_uri, c.code_challenge, c.resource,
			c.used_at IS NOT NULL, c.expires_at < now(), `+activeSQL+`
			FROM mcp_oauth_codes c JOIN mcp_clients m ON m.id = c.mcp_client_id JOIN users u ON u.id = m.user_id
			WHERE c.code_hash = $1 FOR UPDATE OF c`, auth.HashToken(f.Get("code"))).
			Scan(&conn, &oauthID, &family, &redirect, &challenge, &resource, &used, &dead, &active)
		switch {
		case errors.Is(err, pgx.ErrNoRows) || err == nil && (oauthID == nil || oauthID.String() != clientID):
			fail("unknown authorization code")
			return
		case err != nil:
			httpx.WriteError(w, r, err)
			return
		case used: // replayed code: revoke everything issued from it (RFC 6749 §4.1.2)
			h.revokeFamily(ctx, tx, family)
			_ = tx.Commit(ctx)
			fail("authorization code already used")
			return
		case dead:
			fail("authorization code expired")
			return
		case f.Get("redirect_uri") != redirect:
			fail("redirect_uri does not match the authorization request")
			return
		case !pkceOK(f.Get("code_verifier"), challenge):
			fail("PKCE verification failed (code_verifier)")
			return
		case !active:
			fail("the connection was disabled or revoked")
			return
		}
		_, err = tx.Exec(ctx, `UPDATE mcp_oauth_codes SET used_at = now() WHERE code_hash = $1`, auth.HashToken(f.Get("code")))
	case "refresh_token":
		hash := auth.HashToken(f.Get("refresh_token"))
		err = tx.QueryRow(ctx, `SELECT t.mcp_client_id, m.oauth_client_id, t.family_id, t.resource, t.used_at IS NOT NULL,
			t.revoked_at IS NOT NULL OR t.expires_at < now(), `+activeSQL+`
			FROM mcp_oauth_tokens t JOIN mcp_clients m ON m.id = t.mcp_client_id JOIN users u ON u.id = m.user_id
			WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`, hash).
			Scan(&conn, &oauthID, &family, &resource, &used, &dead, &active)
		switch {
		case errors.Is(err, pgx.ErrNoRows) || err == nil && (oauthID == nil || oauthID.String() != clientID):
			fail("unknown refresh token")
			return
		case err != nil:
			httpx.WriteError(w, r, err)
			return
		case used && !dead: // a rotated token came back: assume theft, revoke the whole grant (OAuth 2.1 §4.3.1)
			h.revokeFamily(ctx, tx, family)
			_ = tx.Commit(ctx)
			fail("refresh token reuse detected; the grant was revoked, authorize again")
			return
		case used || dead || !active:
			fail("refresh token expired or revoked")
			return
		}
		_, err = tx.Exec(ctx, `UPDATE mcp_oauth_tokens SET used_at = now() WHERE token_hash = $1`, hash)
	default:
		oauthJSON(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
		return
	}
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	if res != "" && res != resource {
		oauthJSON(w, http.StatusBadRequest, "invalid_target", "resource differs from the authorization request")
		return
	}
	out, err := issueTokens(ctx, tx, conn, family, resource)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		httpx.WriteError(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func issueTokens(ctx context.Context, tx pgx.Tx, conn, family uuid.UUID, resource string) (map[string]any, error) {
	a, _ := auth.NewToken()
	rt, _ := auth.NewToken()
	access, refresh := accessPrefix+a, refreshPrefix+rt
	if _, err := tx.Exec(ctx, `INSERT INTO mcp_oauth_tokens (token_hash, kind, mcp_client_id, family_id, resource, expires_at)
		VALUES ($1,'access',$3,$4,$5,$6), ($2,'refresh',$3,$4,$5,$7)`, auth.HashToken(access), auth.HashToken(refresh), conn, family, resource,
		time.Now().Add(accessTTL), time.Now().Add(refreshTTL)); err != nil {
		return nil, err
	}
	var scopes []string
	rows, err := tx.Query(ctx, `SELECT DISTINCT scope FROM mcp_permission_grants WHERE mcp_client_id = $1 AND revoked_at IS NULL ORDER BY 1`, conn)
	if err == nil {
		scopes, err = pgx.CollectRows(rows, pgx.RowTo[string])
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessTTL.Seconds()),
		"refresh_token": refresh, "scope": strings.Join(scopes, " ")}, nil
}

func (h *handlers) revokeFamily(ctx context.Context, tx pgx.Tx, family uuid.UUID) {
	_, _ = tx.Exec(ctx, `UPDATE mcp_oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, family)
}

// revoke (RFC 7009): revoking either token of a grant revokes the whole grant (access + refresh).
// The response is 200 whether or not the token existed.
func (h *handlers) revoke(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil || r.PostForm.Get("token") == "" {
		oauthJSON(w, http.StatusBadRequest, "invalid_request", "token is required")
		return
	}
	clientID := r.PostForm.Get("client_id")
	if u, _, ok := r.BasicAuth(); ok && clientID == "" {
		clientID = u
	}
	ctx := r.Context()
	var conn uuid.UUID
	err := h.deps.DB.QueryRow(ctx, `WITH t AS (
			SELECT t.family_id, t.mcp_client_id FROM mcp_oauth_tokens t JOIN mcp_clients m ON m.id = t.mcp_client_id
			WHERE t.token_hash = $1 AND m.oauth_client_id::text = $2)
		UPDATE mcp_oauth_tokens x SET revoked_at = coalesce(x.revoked_at, now()) FROM t WHERE x.family_id = t.family_id
		RETURNING t.mcp_client_id`, auth.HashToken(r.PostForm.Get("token")), clientID).Scan(&conn)
	if err == nil {
		_ = changes.Audit(ctx, h.deps.DB, changes.Entry{Action: "mcp.oauth.revoke", EntityType: "mcp_clients", EntityID: &conn})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}
