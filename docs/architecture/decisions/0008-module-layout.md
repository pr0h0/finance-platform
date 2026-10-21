# 0008 — Backend module layout, route ownership, migrations

Status: accepted (Phase 0)

## Layout
```
apps/api/
  cmd/api/main.go            serve | migrate | status | healthcheck
  migrations/*.sql           goose, embedded (migrations.FS)
  internal/app               Deps{Config, DB, Log}, APIVersion, SyncProtocolVersion
  internal/httpx             JSON, Error format, H(), DecodeJSON, pagination, Idempotent, middleware
  internal/authz             Principal in ctx, RequireProfile, ProfileFromRequest (X-Profile-ID)
  internal/changes           Record (sync change + audit), Audit
  internal/money             exact money
  internal/testdb            per-test migrated database
  internal/server            router; mounts every module
  internal/<module>/         one dir per PLAN §40 module, `func Register(r chi.Router, deps *app.Deps)`
```
Inside a module, keep transport (handlers), domain logic and SQL separate files (`handlers.go`,
`service.go`, `store.go`) — no repositories-of-interfaces unless there are two implementations.

## Route ownership
Each module registers only the paths listed in its `module.go` package comment and its OpenAPI tag.
`internal/server/server.go` is the only shared file; it already registers every module.

## Migrations
- Location: `apps/api/migrations/` only.
- Name: `YYYYMMDDHHMMSS_<module>_<description>.sql` (UTC now), goose annotations (`-- +goose Up` /
  `-- +goose Down`; wrap `$$` bodies in `StatementBegin/End`).
- Out-of-order application is enabled, so parallel branches never block each other; therefore a migration
  must not depend on another unmerged migration.
- Never edit a committed migration; add a new one. No destructive changes without a data-preserving path.
