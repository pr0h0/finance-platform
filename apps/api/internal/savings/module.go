// Package savings: Savings goals and contributions.
//
// Owned routes under /api/v1: /goals
// See docs/api/openapi.yaml for the contract.
package savings

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
