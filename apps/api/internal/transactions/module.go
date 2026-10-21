// Package transactions: Transactions, postings, splits, tags, refunds, transfers, templates, bulk edit.
//
// Owned routes under /api/v1: /transactions, /transactions/{id}/splits, /tags, /transaction-templates, /split-templates
// See docs/api/openapi.yaml for the contract.
package transactions

import (
	"github.com/go-chi/chi/v5"

	"github.com/pr0h0/finance-platform/apps/api/internal/app"
)

// Register mounts this module's routes on the /api/v1 router.
func Register(r chi.Router, deps *app.Deps) {}
