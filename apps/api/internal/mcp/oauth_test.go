package mcp_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/config"
	"github.com/pr0h0/finance-platform/apps/api/internal/mcp"
	"github.com/pr0h0/finance-platform/apps/api/internal/testdb"
)

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// form posts an x-www-form-urlencoded body (token / revoke endpoints).
func (e *env) form(path string, v url.Values) (int, map[string]any) {
	e.t.Helper()
	res, err := http.PostForm(e.url+path, v)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (e *env) get(path string) *http.Response {
	e.t.Helper()
	res, err := noRedirect.Get(e.url + path)
	if err != nil {
		e.t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func pkce() (verifier, challenge string) {
	verifier = strings.Repeat("v", 20) + uuid.NewString() // 56 chars
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func (e *env) register(redirects ...string) string {
	e.t.Helper()
	st, c := e.http("POST", "/oauth/register", "", map[string]any{"client_name": "Claude", "redirect_uris": redirects,
		"grant_types": []string{"authorization_code", "refresh_token"}, "token_endpoint_auth_method": "none"})
	if st != 201 || c["token_endpoint_auth_method"] != "none" {
		e.t.Fatalf("register %d %v", st, c)
	}
	return c["client_id"].(string)
}

func authQuery(clientID, redirect, challenge, resource string) url.Values {
	return url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "state": {"st4te"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "resource": {resource}, "scope": {"read_aggregates"}}
}

// consent approves an authorization request as the signed-in human and returns the code.
func (e *env) consent(q url.Values, grants ...map[string]any) string {
	e.t.Helper()
	for _, g := range grants {
		g["profileId"] = e.profile
	}
	st, out := e.http("POST", "/api/v1/mcp/oauth/authorize?"+q.Encode(), e.human, map[string]any{"approve": true, "grants": grants})
	if st != 200 {
		e.t.Fatalf("consent %d %v", st, out)
	}
	u, _ := url.Parse(out["redirectUrl"].(string))
	if u.Query().Get("state") != "st4te" || u.Query().Get("iss") != e.url || u.Query().Get("code") == "" {
		e.t.Fatalf("redirect %v", u)
	}
	return u.Query().Get("code")
}

func (e *env) exchange(clientID, code, redirect, verifier string) (int, map[string]any) {
	return e.form("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code},
		"redirect_uri": {redirect}, "code_verifier": {verifier}, "resource": {e.url + "/mcp"}})
}

func TestOAuthFullFlow(t *testing.T) {
	e := newEnv(t)
	resource := e.url + "/mcp"
	redirect := "https://claude.example/api/mcp/auth_callback"

	// Discovery: 401 points at the protected resource metadata, which names the authorization server.
	req, _ := http.NewRequest("POST", e.url+"/mcp", strings.NewReader(`{}`))
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 401 || !strings.Contains(res.Header.Get("WWW-Authenticate"), `resource_metadata="`+e.url+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("401 %d %q", res.StatusCode, res.Header.Get("WWW-Authenticate"))
	}
	if st, prm := e.http("GET", "/.well-known/oauth-protected-resource/mcp", "", nil); st != 200 || prm["resource"] != resource ||
		prm["authorization_servers"].([]any)[0] != e.url {
		t.Fatalf("prm %d %v", st, prm)
	}
	st, asm := e.http("GET", "/.well-known/oauth-authorization-server", "", nil)
	if st != 200 || asm["issuer"] != e.url || asm["code_challenge_methods_supported"].([]any)[0] != "S256" || asm["registration_endpoint"] != e.url+"/oauth/register" {
		t.Fatalf("as metadata %d %v", st, asm)
	}

	// DCR: only https or loopback redirect URIs.
	for _, bad := range []string{"http://evil.example/cb", "https://x.example/cb#frag", "javascript:alert(1)", "myapp://cb"} {
		if st, out := e.http("POST", "/oauth/register", "", map[string]any{"redirect_uris": []string{bad}}); st != 400 || out["error"] != "invalid_redirect_uri" {
			t.Errorf("register %s: %d %v", bad, st, out)
		}
	}
	client := e.register(redirect, "http://127.0.0.1:33418/callback")
	verifier, challenge := pkce()
	q := authQuery(client, redirect, challenge, resource)

	// /oauth/authorize: unregistered redirect is never redirected to; other errors go back to the client.
	bad := authQuery(client, "https://claude.example/other", challenge, resource)
	if r := e.get("/oauth/authorize?" + bad.Encode()); r.StatusCode != 400 || r.Header.Get("Location") != "" {
		t.Fatalf("redirect mismatch %d %q", r.StatusCode, r.Header.Get("Location"))
	}
	noPKCE := authQuery(client, redirect, "", resource)
	noPKCE.Del("code_challenge_method")
	if r := e.get("/oauth/authorize?" + noPKCE.Encode()); r.StatusCode != 302 || !strings.HasPrefix(r.Header.Get("Location"), redirect+"?") ||
		!strings.Contains(r.Header.Get("Location"), "error=invalid_request") || !strings.Contains(r.Header.Get("Location"), "state=st4te") {
		t.Fatalf("missing pkce %d %q", r.StatusCode, r.Header.Get("Location"))
	}
	plain := authQuery(client, redirect, challenge, resource)
	plain.Set("code_challenge_method", "plain")
	if r := e.get("/oauth/authorize?" + plain.Encode()); !strings.Contains(r.Header.Get("Location"), "error=invalid_request") {
		t.Fatalf("plain pkce accepted %q", r.Header.Get("Location"))
	}
	wrongAud := authQuery(client, redirect, challenge, "https://other.example/mcp")
	if r := e.get("/oauth/authorize?" + wrongAud.Encode()); !strings.Contains(r.Header.Get("Location"), "error=invalid_target") {
		t.Fatalf("wrong resource %q", r.Header.Get("Location"))
	}
	if r := e.get("/oauth/authorize?" + q.Encode()); r.StatusCode != 302 || !strings.HasPrefix(r.Header.Get("Location"), e.url+"/agents/authorize?") {
		t.Fatalf("authorize %d %q", r.StatusCode, r.Header.Get("Location"))
	}

	// Consent page data, then approval (read-only grant). Without a human session: 401.
	if st, _ := e.http("GET", "/api/v1/mcp/oauth/authorize?"+q.Encode(), "", nil); st != 401 {
		t.Fatalf("anonymous consent %d", st)
	}
	st, info := e.http("GET", "/api/v1/mcp/oauth/authorize?"+q.Encode(), e.human, nil)
	if st != 200 || info["clientName"] != "Claude" || info["redirectHost"] != "claude.example" || info["connection"] != nil {
		t.Fatalf("describe %d %v", st, info)
	}
	if st, out := e.http("POST", "/api/v1/mcp/oauth/authorize?"+q.Encode(), e.human, map[string]any{"approve": true, "grants": []any{}}); st != 422 && st != 400 {
		t.Fatalf("empty grants %d %v", st, out)
	}
	st, deny := e.http("POST", "/api/v1/mcp/oauth/authorize?"+q.Encode(), e.human, map[string]any{"approve": false})
	if st != 200 || !strings.Contains(deny["redirectUrl"].(string), "error=access_denied") {
		t.Fatalf("deny %d %v", st, deny)
	}
	code := e.consent(q, map[string]any{"scope": "read_aggregates"})

	// Token: PKCE failure and redirect mismatch are rejected; then the real exchange works.
	if st, out := e.exchange(client, code, redirect, strings.Repeat("x", 50)); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("bad verifier %d %v", st, out)
	}
	if st, out := e.exchange(client, code, "http://127.0.0.1:33418/callback", verifier); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("redirect mismatch at token %d %v", st, out)
	}
	if st, out := e.form("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "client_id": {client}, "code": {code},
		"redirect_uri": {redirect}, "code_verifier": {verifier}, "resource": {"https://other.example/mcp"}}); st != 400 || out["error"] != "invalid_target" {
		t.Fatalf("wrong audience at token %d %v", st, out)
	}
	st, tok := e.exchange(client, code, redirect, verifier)
	if st != 200 || tok["token_type"] != "Bearer" || tok["scope"] != "read_aggregates" || tok["expires_in"].(float64) != 3600 {
		t.Fatalf("token %d %v", st, tok)
	}
	access, refresh := tok["access_token"].(string), tok["refresh_token"].(string)
	if n := e.scalar(`SELECT count(*)::text FROM mcp_oauth_tokens WHERE token_hash = $1`, []byte(access)); n != "0" {
		t.Fatal("token stored in plain text")
	}

	// MCP call with the OAuth token; read-only connection cannot write.
	if r, isErr := e.call(access, "get_spending_by_category", map[string]any{"dateFrom": "2026-10-01", "dateTo": "2026-10-31"}); isErr || r["total"].(map[string]any)["amount"] != "190.00" {
		t.Fatalf("mcp call %v", r)
	}
	if r, isErr := e.call(access, "update_transaction_category", map[string]any{"transactionId": e.tx1, "categoryId": e.groceries}); !isErr || errCode(r) != "scope_missing" {
		t.Fatalf("read-only write %v", r)
	}
	if e.category(e.tx1) != "<nil>" {
		t.Fatal("read-only OAuth client changed data")
	}
	// The connection shows up in the MCP clients admin, audited like any client.
	_, list := e.http("GET", "/api/v1/mcp/clients", e.human, nil)
	items := list["items"].([]any)
	conn := items[0].(map[string]any)
	if len(items) != 1 || conn["kind"] != "oauth" || conn["name"] != "Claude" {
		t.Fatalf("clients %v", list)
	}
	if n := e.scalar(`SELECT count(*)::text FROM audit_log WHERE action IN ('mcp.oauth.authorize','mcp.client.create','mcp.tool_call') AND entity_id = $1`, conn["id"]); n == "0" || n == "1" || n == "2" {
		t.Fatalf("audit entries %s", n)
	}

	// Code replay fails and revokes what the code produced.
	if st, out := e.exchange(client, code, redirect, verifier); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("code replay %d %v", st, out)
	}
	if st, _ := e.rpc(access, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("access after code replay %d", st)
	}
	if st, out := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {refresh}}); st != 400 {
		t.Fatalf("refresh after code replay %d %v", st, out)
	}

	// Second authorization reuses the connection (no duplicate); refresh rotates; reuse revokes the grant.
	verifier, challenge = pkce()
	q = authQuery(client, redirect, challenge, resource)
	_, tok = e.exchange(client, e.consent(q, map[string]any{"scope": "read_aggregates"}, map[string]any{"scope": "read_transactions"}), redirect, verifier)
	if tok["scope"] != "read_aggregates read_transactions" {
		t.Fatalf("token 2 %v", tok)
	}
	st, rot := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {tok["refresh_token"].(string)}, "resource": {resource}})
	if st != 200 || rot["refresh_token"] == tok["refresh_token"] {
		t.Fatalf("refresh %d %v", st, rot)
	}
	if _, isErr := e.call(rot["access_token"].(string), "list_transactions", map[string]any{"limit": 1}); isErr {
		t.Fatal("refreshed access token")
	}
	if st, out := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {"00000000-0000-0000-0000-000000000000"}, "refresh_token": {rot["refresh_token"].(string)}}); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("refresh by another client %d %v", st, out)
	}
	if st, out := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {tok["refresh_token"].(string)}}); st != 400 || !strings.Contains(out["error_description"].(string), "reuse") {
		t.Fatalf("refresh reuse %d %v", st, out)
	}
	if st, _ := e.rpc(rot["access_token"].(string), []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("access after refresh reuse %d", st)
	}
	_, list = e.http("GET", "/api/v1/mcp/clients", e.human, nil)
	if len(list["items"].([]any)) != 1 {
		t.Fatalf("duplicate connection %v", list)
	}

	// Revocation endpoint (RFC 7009).
	verifier, challenge = pkce()
	q = authQuery(client, redirect, challenge, resource)
	_, tok = e.exchange(client, e.consent(q, map[string]any{"scope": "read_aggregates"}), redirect, verifier)
	if st, _ := e.form("/oauth/revoke", url.Values{"token": {tok["refresh_token"].(string)}, "client_id": {client}}); st != 200 {
		t.Fatalf("revoke %d", st)
	}
	if st, _ := e.rpc(tok["access_token"].(string), []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("access after revoke %d", st)
	}
	if st, _ := e.form("/oauth/revoke", url.Values{"token": {"unknown"}, "client_id": {client}}); st != 200 {
		t.Fatalf("revoke unknown %d", st)
	}

	// Revoking the connection in the admin kills its tokens and refresh.
	verifier, challenge = pkce()
	q = authQuery(client, redirect, challenge, resource)
	_, tok = e.exchange(client, e.consent(q, map[string]any{"scope": "read_aggregates"}), redirect, verifier)
	if st, _ := e.http("DELETE", "/api/v1/mcp/clients/"+conn["id"].(string), e.human, nil); st != 204 {
		t.Fatalf("revoke connection %d", st)
	}
	if st, _ := e.rpc(tok["access_token"].(string), []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("access after admin revoke %d", st)
	}
	if st, out := e.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {client}, "refresh_token": {tok["refresh_token"].(string)}}); st != 400 || out["error"] != "invalid_grant" {
		t.Fatalf("refresh after admin revoke %d %v", st, out)
	}
}

func TestOAuthWrongAudienceToken(t *testing.T) {
	e := newEnv(t)
	client := e.register("https://claude.example/cb")
	verifier, challenge := pkce()
	q := authQuery(client, "https://claude.example/cb", challenge, e.url+"/mcp")
	_, tok := e.exchange(client, e.consent(q, map[string]any{"scope": "read_aggregates"}), "https://claude.example/cb", verifier)
	access := tok["access_token"].(string)
	if st, _ := e.rpc(access, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 200 {
		t.Fatalf("valid audience %d", st)
	}
	// The same token is useless for another resource: change the server's identity.
	e.exec(`UPDATE mcp_oauth_tokens SET resource = 'https://other.example/mcp' WHERE token_hash = $1`, auth.HashToken(access))
	if st, _ := e.rpc(access, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)); st != 401 {
		t.Fatalf("wrong audience accepted %d", st)
	}
	// OAuth tokens never work on the REST API.
	if st, _ := e.http("GET", "/api/v1/mcp/clients", tok["refresh_token"].(string), nil); st != 401 {
		t.Fatalf("refresh token on REST %d", st)
	}
}

func TestOAuthTokenRateLimit(t *testing.T) {
	pool := testdb.New(t)
	cfg := &config.Config{MCPEnabled: true, RateLimitAuthPM: 2}
	r := chi.NewRouter()
	mcp.RegisterOAuth(r, &app.Deps{Config: cfg, DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	last := 0
	for range 3 {
		res, err := http.PostForm(srv.URL+"/oauth/token", url.Values{"grant_type": {"refresh_token"}, "client_id": {"x"}, "refresh_token": {"y"}})
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		last = res.StatusCode
	}
	if last != 429 {
		t.Fatalf("third token request: %d, want 429", last)
	}
}

func TestStreamableHTTPCompliance(t *testing.T) {
	e := newEnv(t)
	_, tok := e.newClient(map[string]any{"scope": "read_aggregates"})
	req, _ := http.NewRequest("GET", e.url+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "text/event-stream")
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 405 || res.Header.Get("Allow") != "POST" {
		t.Fatalf("GET /mcp %d allow=%q (no SSE stream: 405)", res.StatusCode, res.Header.Get("Allow"))
	}
	// Version negotiation: a supported version is echoed, an unknown one gets the server's latest.
	for v, want := range map[string]string{"2025-11-25": "2025-11-25", "2025-03-26": "2025-03-26", "1999-01-01": ""} {
		st, raw := e.rpc(tok, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"`+v+`","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`))
		var out struct {
			Result struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"result"`
		}
		_ = json.Unmarshal(raw, &out)
		if st != 200 || (want != "" && out.Result.ProtocolVersion != want) || out.Result.ProtocolVersion == "" {
			t.Errorf("initialize %s: %d %s", v, st, raw)
		}
	}
	// An unsupported MCP-Protocol-Version header is rejected.
	req, _ = http.NewRequest("POST", e.url+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2020-01-01")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("bad protocol header %d", res.StatusCode)
	}
}

func TestAttachmentsAndIncomeByCategory(t *testing.T) {
	e := newEnv(t)
	e.cfg.AttachmentsDir = t.TempDir()
	png := []byte("\x89PNG\r\n\x1a\nnot-a-real-image")
	att := uuid.New()
	key := e.profile.String() + "/" + att.String()
	if err := os.MkdirAll(filepath.Join(e.cfg.AttachmentsDir, e.profile.String()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.cfg.AttachmentsDir, key), png, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(png)
	e.exec(`INSERT INTO attachments (id, profile_id, transaction_id, file_name, content_type, size_bytes, sha256, storage_key)
		VALUES ($1,$2,$3,'receipt.png','image/png',$4,$5,$6)`, att, e.profile, e.tx1, len(png), sum[:], key)

	_, noAtt := e.newClient(map[string]any{"scope": "read_aggregates"})
	if r, isErr := e.call(noAtt, "get_attachments", map[string]any{}); !isErr || errCode(r) != "scope_missing" {
		t.Fatalf("without grant %v", r)
	}
	_, tok := e.newClient(map[string]any{"scope": "read_attachments"})
	if r, isErr := e.call(tok, "get_attachments", map[string]any{"transactionId": e.tx1}); isErr || len(r["attachments"].([]any)) != 1 {
		t.Fatalf("list %v", r)
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 9, "method": "tools/call",
		"params": map[string]any{"name": "get_attachments", "arguments": map[string]any{"attachmentId": att, "includeContent": true}}})
	_, raw := e.rpc(tok, body)
	var out struct {
		Result struct {
			Content []struct {
				Type, MimeType, Data string
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Result.Content) != 2 || out.Result.Content[1].Type != "image" ||
		out.Result.Content[1].Data != base64.StdEncoding.EncodeToString(png) {
		t.Fatalf("content %s", raw)
	}
	// Account-restricted to the card: the checking transaction's receipt is invisible.
	_, restricted := e.newClient(map[string]any{"scope": "read_attachments", "accountIds": []uuid.UUID{e.acc2}})
	if r, isErr := e.call(restricted, "get_attachments", map[string]any{"attachmentId": att}); !isErr || errCode(r) != "not_found" {
		t.Fatalf("restricted %v", r)
	}

	// Income per top-level category (subcategory rolled up), largest first.
	work, bonus, side := uuid.New(), uuid.New(), uuid.New()
	e.exec(`INSERT INTO categories (id, profile_id, name, kind) VALUES ($1,$2,'Work','income'), ($3,$2,'Side jobs','income')`, work, e.profile, side)
	e.exec(`INSERT INTO categories (id, profile_id, name, kind, parent_id) VALUES ($1,$2,'Bonus','income',$3)`, bonus, e.profile, work)
	for _, x := range []struct {
		cat    uuid.UUID
		amount string
	}{{work, "1000.00"}, {bonus, "250.50"}, {side, "80.00"}} {
		id := uuid.New()
		e.exec(`INSERT INTO transactions (id, profile_id, kind, booking_date, description) VALUES ($1,$2,'income','2026-10-02','Income')`, id, e.profile)
		e.exec(`INSERT INTO postings (profile_id, transaction_id, account_id, amount, currency) VALUES ($1,$2,$3,$4::numeric,'BAM')`, e.profile, id, e.acc1, x.amount)
		e.exec(`INSERT INTO transaction_splits (profile_id, transaction_id, amount, currency, category_id) VALUES ($1,$2,$3,'BAM',$4)`, e.profile, id, x.amount, x.cat)
	}
	_, agg := e.newClient(map[string]any{"scope": "read_aggregates"})
	r, isErr := e.call(agg, "get_income_summary", map[string]any{"dateFrom": "2026-10-01", "dateTo": "2026-10-31"})
	if isErr {
		t.Fatalf("income %v", r)
	}
	rows := r["byCategory"].([]any)
	first := rows[0].(map[string]any)
	if len(rows) != 2 || first["label"] != "Work" || first["amount"].(map[string]any)["amount"] != "1250.50" || first["count"].(float64) != 2 ||
		r["total"].(map[string]any)["amount"] != "1330.50" {
		t.Fatalf("income by category %v", r)
	}
}
