// Package mcp: remote MCP server (Features 132–145) — client registry with tokens, per-client
// grants with profile/account/period scope, read tools, write tools that produce proposals,
// human approval, audit of every call. Tool semantics come from packages/mcp-contracts
// (tools.json) so the future local desktop MCP server (Feature 131, DEFERRED) behaves the same.
//
// Owned routes under /api/v1: /mcp/clients, /mcp/proposals, /mcp/tools, /mcp/oauth (REST, humans only);
// /mcp (Streamable HTTP protocol endpoint, RegisterTransport); /.well-known/oauth-* and /oauth/*
// (OAuth 2.1 authorization server, RegisterOAuth in oauth.go). See docs/mcp/README.md.
package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

type handlers struct{ deps *app.Deps }

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {
	h := &handlers{deps: deps}
	idem := httpx.Idempotent(deps.DB)
	r.Get("/mcp/clients", httpx.H(h.listClients))
	r.Post("/mcp/clients", httpx.H(h.createClient))
	r.Patch("/mcp/clients/{id}", httpx.H(h.patchClient))
	r.Delete("/mcp/clients/{id}", httpx.H(h.deleteClient))
	r.Put("/mcp/clients/{id}/grants", httpx.H(h.putGrants))
	r.Get("/mcp/proposals", httpx.H(h.listProposals))
	r.With(idem).Post("/mcp/proposals/approve-batch", httpx.H(h.approveBatch))
	r.With(idem).Post("/mcp/proposals/{id}/approve", httpx.H(h.approve))
	r.Post("/mcp/proposals/{id}/reject", httpx.H(h.reject))
	r.Get("/mcp/tools", httpx.H(h.tools))
	r.Get("/mcp/oauth/authorize", httpx.H(h.describeAuthorize))
	r.Post("/mcp/oauth/authorize", httpx.H(h.approveAuthorize))
}

func (h *handlers) tools(w http.ResponseWriter, r *http.Request) error {
	if _, err := authz.Require(r.Context()); err != nil {
		return err
	}
	out := make([]map[string]any, len(catalogue))
	for i, d := range catalogue {
		out[i] = map[string]any{"name": d.Name, "description": d.Description, "annotations": d.Annotations, "inputSchema": d.InputSchema, "scopes": d.Scopes}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
	return nil
}

const instructions = `Personal finance data of the user who issued this token, limited to the profiles, accounts, period and
capabilities they granted. Money is always {amount: decimal string, currency}; never assume floats.
Prefer aggregate tools (get_spending_by_category, get_financial_overview, get_cash_flow_forecast) over listing
transactions. Every result has meta.complete/warnings/missingRates: say so when data is incomplete.
Write tools never change data directly unless the user pre-authorized that low-risk capability: they return a
proposal (status pending) that the user approves in the app; then call apply_approved_changes. Use preview_changes
to validate a batch first. Data you read leaves the user's server and goes to your AI provider.`

type sessionKey struct{}

// RegisterTransport mounts the MCP protocol endpoint (Streamable HTTP, stateless, JSON responses) at
// /mcp. Authentication is the client bearer token (resolved by auth.Middleware into an MCP
// principal); grants are re-read on every request so revocation is immediate.
func RegisterTransport(r chi.Router, deps *app.Deps) {
	handler := sdk.NewStreamableHTTPHandler(func(req *http.Request) *sdk.Server {
		s, _ := req.Context().Value(sessionKey{}).(*session)
		if s == nil {
			return nil
		}
		return newServer(s)
	}, &sdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	limit := auth.RateLimit(auth.NewLimiter(deps.Config.RateLimitMCPPM))
	r.With(limit).Handle("/", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !deps.Config.MCPEnabled {
			httpx.WriteError(w, req, httpx.NewError(http.StatusNotFound, "mcp_disabled", "the MCP endpoint is disabled on this server (MCP_ENABLED=false)"))
			return
		}
		p, ok := authz.FromContext(req.Context())
		if !ok || p.ActorType != authz.ActorMCP {
			// RFC 9728 §5.1: tell OAuth clients where to discover the authorization server.
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+deps.Config.PublicURL+`/.well-known/oauth-protected-resource/mcp"`)
			httpx.WriteError(w, req, httpx.NewError(http.StatusUnauthorized, "unauthenticated", "an MCP token is required (OAuth access token or Authorization: Bearer fpm_...)"))
			return
		}
		s, err := newSession(req.Context(), deps.DB, deps.Config.MCPMaxResults, p)
		if err != nil {
			httpx.WriteError(w, req, err)
			return
		}
		s.attachmentsDir = deps.Config.AttachmentsDir
		handler.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), sessionKey{}, s)))
	}))
}

// newServer builds the per-request MCP server bound to the caller's session.
func newServer(s *session) *sdk.Server {
	srv := sdk.NewServer(&sdk.Implementation{Name: "finance-platform", Title: "Finance Platform", Version: app.APIVersion},
		&sdk.ServerOptions{Instructions: instructions})
	for _, d := range catalogue {
		def := d
		readOnly := def.Annotations.ReadOnlyHint
		destructive := false
		srv.AddTool(&sdk.Tool{Name: def.Name, Description: def.Description, InputSchema: def.InputSchema,
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: readOnly, DestructiveHint: &destructive, OpenWorldHint: &destructive}},
			func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
				res, err := s.call(ctx, def.Name, req.Params.Arguments)
				if err != nil {
					res = errorPayload(err)
				}
				file, _ := res.(*fileResult)
				if file != nil {
					res = file.result
				}
				b, _ := json.Marshal(res)
				content := []sdk.Content{&sdk.TextContent{Text: string(b)}}
				switch {
				case file == nil:
				case strings.HasPrefix(file.mime, "image/"):
					content = append(content, &sdk.ImageContent{Data: file.data, MIMEType: file.mime})
				default:
					content = append(content, &sdk.EmbeddedResource{Resource: &sdk.ResourceContents{URI: file.uri, MIMEType: file.mime, Blob: file.data}})
				}
				return &sdk.CallToolResult{Content: content, StructuredContent: json.RawMessage(b), IsError: err != nil}, nil
			})
	}
	return srv
}
