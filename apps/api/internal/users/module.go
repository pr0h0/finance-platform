// Package users: Current user and user settings.
//
// Owned routes under /api/v1: /users/me, /users/me/settings
// See docs/api/openapi.yaml for the contract.
package users

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
