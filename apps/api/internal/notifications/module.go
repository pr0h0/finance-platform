// Package notifications: In-app notifications and reminders.
//
// Owned routes under /api/v1: /notifications
// See docs/api/openapi.yaml for the contract.
package notifications

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
