// Package auth: Registration, login/logout, sessions, CSRF, account recovery.
//
// Owned routes under /api/v1: /auth/*, /sessions
// See docs/api/openapi.yaml for the contract.
package auth

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}

// Middleware resolves the session cookie / bearer token into an authz.Principal on the request
// context. Until the auth module implements it, no principal is set, so every endpoint that
// calls authz.Require returns 401.
func Middleware(deps *app.Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return next }
}
