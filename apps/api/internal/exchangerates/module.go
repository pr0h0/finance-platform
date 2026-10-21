// Package exchangerates: Exchange-rate providers, snapshots, manual overrides.
//
// Owned routes under /api/v1: /exchange-rates, /exchange-rate-providers
// See docs/api/openapi.yaml for the contract.
package exchangerates

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
