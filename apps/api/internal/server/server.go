// Package server builds the HTTP router and wires every module.
package server

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/pr0h0/finance-platform/apps/api/internal/accounts"
	"github.com/pr0h0/finance-platform/apps/api/internal/admin"
	"github.com/pr0h0/finance-platform/apps/api/internal/analytics"
	"github.com/pr0h0/finance-platform/apps/api/internal/app"
	"github.com/pr0h0/finance-platform/apps/api/internal/attachments"
	"github.com/pr0h0/finance-platform/apps/api/internal/audit"
	"github.com/pr0h0/finance-platform/apps/api/internal/auth"
	"github.com/pr0h0/finance-platform/apps/api/internal/automation"
	"github.com/pr0h0/finance-platform/apps/api/internal/backups"
	"github.com/pr0h0/finance-platform/apps/api/internal/budgets"
	"github.com/pr0h0/finance-platform/apps/api/internal/categories"
	"github.com/pr0h0/finance-platform/apps/api/internal/currency"
	"github.com/pr0h0/finance-platform/apps/api/internal/database"
	"github.com/pr0h0/finance-platform/apps/api/internal/exchangerates"
	"github.com/pr0h0/finance-platform/apps/api/internal/forecasting"
	"github.com/pr0h0/finance-platform/apps/api/internal/households"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
	"github.com/pr0h0/finance-platform/apps/api/internal/imports"
	"github.com/pr0h0/finance-platform/apps/api/internal/ledger"
	"github.com/pr0h0/finance-platform/apps/api/internal/mcp"
	"github.com/pr0h0/finance-platform/apps/api/internal/merchants"
	"github.com/pr0h0/finance-platform/apps/api/internal/notifications"
	"github.com/pr0h0/finance-platform/apps/api/internal/planning"
	"github.com/pr0h0/finance-platform/apps/api/internal/profiles"
	"github.com/pr0h0/finance-platform/apps/api/internal/recurrence"
	"github.com/pr0h0/finance-platform/apps/api/internal/savings"
	"github.com/pr0h0/finance-platform/apps/api/internal/sync"
	"github.com/pr0h0/finance-platform/apps/api/internal/transactions"
	"github.com/pr0h0/finance-platform/apps/api/internal/users"
)

// modules are mounted on /api/v1 in this order. Each owns a disjoint set of paths
// (see the package doc of each module). Add a module = one line here.
var modules = []func(chi.Router, *app.Deps){
	auth.Register, users.Register, profiles.Register, households.Register,
	accounts.Register, ledger.Register, transactions.Register, categories.Register, merchants.Register,
	budgets.Register, planning.Register, recurrence.Register, currency.Register, exchangerates.Register,
	forecasting.Register, analytics.Register, savings.Register, imports.Register, attachments.Register,
	automation.Register, notifications.Register, sync.Register, mcp.Register, backups.Register,
	admin.Register, audit.Register,
}

func New(deps *app.Deps) http.Handler {
	r := chi.NewRouter()
	r.NotFound(httpx.NotFoundHandler)
	r.MethodNotAllowed(httpx.MethodNotAllowedHandler)
	r.Use(middleware.RequestID)
	if deps.Config.TrustProxy {
		r.Use(httpx.RealIP) // only the gateway can reach the API container
	}
	r.Use(httpx.AccessLog(deps.Log), httpx.Recoverer(deps.Log), httpx.MaxBody(deps.Config.MaxBodyBytes))
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(auth.Middleware(deps))

	r.Get("/api/health", health(deps))
	r.Route("/api/v1", func(v chi.Router) {
		v.NotFound(httpx.NotFoundHandler)
		v.MethodNotAllowed(httpx.MethodNotAllowedHandler)
		v.Get("/meta", meta(deps))
		for _, register := range modules {
			register(v, deps)
		}
	})
	r.Route("/mcp", func(m chi.Router) { mcp.RegisterTransport(m, deps) })
	mcp.RegisterOAuth(r, deps) // /.well-known/oauth-*, /oauth/* (OAuth 2.1 for /mcp)
	return r
}

func health(deps *app.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := deps.DB.Ping(r.Context()); err != nil {
			httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "database": "down"})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "database": "ok"})
	}
}

// meta lets clients verify server identity and compatibility before connecting (Feature 107).
func meta(deps *app.Deps) http.HandlerFunc {
	return httpx.H(func(w http.ResponseWriter, r *http.Request) error {
		sv, err := database.SchemaVersion(r.Context(), deps.DB)
		if err != nil {
			return err
		}
		policy, err := auth.EffectivePolicy(r.Context(), deps.DB, deps.Config)
		if err != nil {
			return err
		}
		var users int
		if err := deps.DB.QueryRow(r.Context(), `SELECT count(*) FROM users`).Scan(&users); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"setupTokenRequired":  auth.SetupTokenRequired(deps.Config, users, policy),
			"name":                "finance-platform",
			"apiVersion":          app.APIVersion,
			"schemaVersion":       sv,
			"syncProtocolVersion": app.SyncProtocolVersion,
			"publicUrl":           deps.Config.PublicURL,
			"registrationPolicy":  policy,
			"mcpEnabled":          deps.Config.MCPEnabled,
		})
		return nil
	})
}
