// Package imports: Importer registry, staging, preview, commit, rollback, reprocessing, templates.
//
// Owned routes under /api/v1: /imports, /importers, /import-templates
// See docs/api/openapi.yaml for the contract.
package imports

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
