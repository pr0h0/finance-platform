# 0001 — Technology stack

Status: accepted (Phase 0)

## Context
PLAN Part III fixes the baseline. Several agents build in parallel, so choices must be boring and
well known.

## Decision
- **Backend**: Go 1.26+, `go-chi/chi/v5` router, `jackc/pgx/v5` (pool, no ORM — explicit SQL, parameterized
  only), `pressly/goose/v3` migrations embedded in the binary (run on startup and via `api migrate`),
  `log/slog` JSON logging with key-based redaction, `google/uuid`. Money uses stdlib `math/big` (no decimal
  library needed — ADR 0002).
- **Database**: PostgreSQL 17. Money in `NUMERIC`, rates `NUMERIC(38,18)`, enums as `text + CHECK`.
- **Background jobs**: `background_jobs` table polled with `FOR UPDATE SKIP LOCKED` (no Redis).
- **Frontend**: React 19, TypeScript strict, Vite 7, Tailwind 4, TanStack Query, Zustand, React Router,
  Recharts. Bun workspaces; packages are consumed as TypeScript source (no build step).
- **Validation**: Go validates authoritatively; `zod` 4 schemas in `packages/validation` mirror the rules
  for clients and MCP argument checks.
- **Lint/format**: Biome (TS/JSON), `go vet` + `gofmt` (Go).
- **Containers**: distroless non-root API, unprivileged nginx for web + gateway, Compose for dev/prod.

## Consequences
No codegen step yet: `docs/api/openapi.yaml` is hand-maintained and `packages/domain` types mirror it.
If drift becomes a problem, generate TS types from the OpenAPI spec (openapi-typescript) in CI.
