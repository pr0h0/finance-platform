// Package mcp: MCP client management, grants, proposed changes; MCP transport at /mcp.
//
// Owned routes under /api/v1: /mcp/clients, /mcp/proposals (REST) and /mcp (protocol, RegisterTransport)
// See docs/api/openapi.yaml for the contract.
package mcp

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}

// RegisterTransport mounts the MCP protocol endpoint (Streamable HTTP) at /mcp.
func RegisterTransport(r chi.Router, deps *app.Deps) {}
