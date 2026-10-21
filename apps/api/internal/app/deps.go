// Package app holds the dependencies shared by every HTTP module.
package app

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

// APIVersion is the REST contract version (docs/api/openapi.yaml info.version).
// Clients compare it (major) for compatibility; bump minor for additive changes.
const APIVersion = "1.0.0"

// SyncProtocolVersion is the sync wire protocol version (docs/architecture/sync-protocol.md).
const SyncProtocolVersion = 1

// Deps is passed to every module's Register. Add fields only for genuinely shared services.
type Deps struct {
	Config *config.Config
	DB     *pgxpool.Pool
	Log    *slog.Logger
}
