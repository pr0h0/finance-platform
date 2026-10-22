# AGENTS.md — instructions for humans and AI agents

Read first: `PLAN.md` (product scope), `docs/implementation-status.md` (what exists),
`docs/architecture/financial-invariants.md`, `docs/architecture/sync-protocol.md`,
`docs/architecture/decisions/` (ADRs), `docs/known-issues.md`, `docs/next-steps.md`.

## Scope right now
Backend (Go) + web app. Mobile (Phase 3) and desktop/Tauri (Phase 4) are **DEFERRED_TO_PHASE** — do not
build them; keep the architecture compatible (shared packages, `LocalStore`, `mcp-contracts`).
Raiffeisen BiH (PDF "IZVOD") is built from the user's real statements in `samples/` (git-ignored). **Never**
commit, copy or quote anything from `samples/` (names, IBANs, amounts, merchants); fixtures are invented data
that only mimic the layout. Automatic bank integrations (feature 102) are deferred indefinitely.

## Host rules (non-negotiable)
- **Never install toolchains on the host.** Everything runs in Docker: `scripts/go.sh`, `scripts/bun.sh`,
  compose files. Bun is the only JS package manager (no npm/pnpm/yarn).
- Docker access: the user may not be in the `docker` group. Use `sg docker -c "docker …"`; the scripts do
  this automatically. Containers run as uid 1000 so files stay owned by the user.
- **This host runs other projects' containers and cloudflared tunnels.** Never stop/remove/prune
  containers, images, volumes or networks that are not ours; never run `docker system|image|volume prune`;
  never modify other tunnels or `~/.cloudflared` configs belonging to other services.
- Our compose projects: `finplat` (prod-like, `docker-compose.yml`) and `finplat-dev` (`docker-compose.dev.yml`).
  Our named volumes start with `finplat`. Host ports (127.0.0.1 only): 3810 gateway, 3811 dev api,
  3812 vite, 5440 dev postgres, 3813 dev Mailpit UI (`--profile integrations`).

## Commands
```sh
scripts/bun.sh install                      # install workspace deps (bun.lock committed)
scripts/bun.sh test packages apps/web/src   # all TS tests  (or: scripts/bun.sh run test)
scripts/bun.sh run typecheck                # tsc --noEmit in every workspace
scripts/bun.sh run lint                     # biome check (TS/JSON)
scripts/go.sh test ./...                    # Go tests (DB tests run when the dev stack is up)
scripts/go.sh vet ./...
scripts/ci.sh                               # everything .github/workflows/ci.yml runs, locally in docker
scripts/e2e.sh                              # Playwright (Chromium, Firefox, WebKit) on an isolated finplat-e2e stack
scripts/go.sh run ./cmd/api migrate         # needs DATABASE_URL in env, see below

sg docker -c "docker compose -f docker-compose.dev.yml up -d"                 # postgres:5440 + api:3811
sg docker -c "docker compose -f docker-compose.dev.yml --profile web up -d"   # + vite:3812
sg docker -c "docker compose -f docker-compose.dev.yml restart api"           # pick up Go changes
sg docker -c "docker compose -f docker-compose.dev.yml down"                  # NOT -v (removes shared caches)

sg docker -c "docker compose -p finplat up -d --build"   # prod-like on 127.0.0.1:3810 (needs .env)
sg docker -c "docker compose -p finplat down"
```
DB tests: `internal/testdb.New(t)` creates and drops a throwaway database on the dev postgres
(`TEST_DATABASE_URL` is set automatically by `scripts/go.sh` when the dev stack is up; tests skip otherwise).
Browser tests: `scripts/e2e.sh` (`mcr.microsoft.com/playwright:v1.63.0-noble`, Chromium + Firefox + WebKit, axe a11y gate)
against an isolated `finplat-e2e` stack (with Mailpit); never against the public instance.

## Architecture in one screen
- Monorepo: `apps/api` (Go), `apps/web` (React/Vite), `packages/*` (TS source, no build step).
- API modules: `apps/api/internal/<module>/` each exposes `Register(r chi.Router, deps *app.Deps)` and owns
  the routes listed in its package comment (= its OpenAPI tag). Do not register paths owned by another module.
  `internal/server/server.go` already mounts all modules under `/api/v1`.
- Contract: `docs/api/openapi.yaml` (source of truth) ↔ `packages/domain` types ↔ `packages/validation` zod.
  Change all three together for your module.
- Money: `{amount: "150.00", currency: "BAM"}` everywhere (ADR 0002). Go `internal/money`, TS
  `@finplat/finance-engine`. Never floats. New money logic needs a conformance fixture both sides pass.
- Ledger: transactions + immutable postings + splits (ADR 0003). Imported raw records immutable.
- Every syncable mutation: write + `changes.Record(...)` in the same `pgx.Tx` (sync change + audit).
- Authorization: `authz.ProfileFromRequest(r, deps.DB, authz.RoleEditor)` (reads `X-Profile-ID`), then
  filter every query by `profile_id`. Unknown/foreign ids → 403/404 without leaking existence.
- Errors: return `*httpx.Error` (`httpx.Validation`, `NotFound`, `Conflict`, `Unprocessable`…) from
  handlers wrapped in `httpx.H`; JSON format `{"error":{code,message,details,requestId}}`.
- Lists: cursor pagination `httpx.ParsePage` / `EncodeCursor` / `httpx.List[T]`.
- Important mutations: wrap with `httpx.Idempotent(deps.DB)` (Idempotency-Key header).
- Updates send `version`; mismatch → 409 `conflict`.

## Code standards
- Boring, explicit Go: handlers → service funcs → SQL with pgx. No ORM, no interfaces with one impl.
- Parameterized SQL only. `gofmt`. Errors wrapped with context.
- TS strict; no `any` in exported APIs; Biome formatting.
- Logs: never log bodies, tokens, passwords, attachment contents (slog redaction covers common keys).

## Migrations
`apps/api/migrations/YYYYMMDDHHMMSS_<module>_<desc>.sql` (UTC timestamp), goose format, out-of-order
allowed. Never edit a committed migration. Extending a CHECK enum = drop + re-add the constraint.

## Testing requirements
Unit tests for pure logic, DB tests (`testdb`) for SQL/invariants, API tests with `httptest` against
`server.New`, Playwright for web journeys. PLAN §46 critical cases must each map to a test. Report honestly.

## Definition of done
PLAN §51. Update `docs/implementation-status.md` (status + tests + limitations) in the same commit.
Unfinished/blocked work goes to `docs/known-issues.md`. Never mark DEFERRED/BLOCKED as done, never ship
mocks or placeholder buttons.

## Git
Commit only your own paths (`git add <paths>`, never `-A`). Author `pr0h0 <abdulah@shopcircle.co>`.
