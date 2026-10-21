# CLAUDE.md

Follow **[AGENTS.md](AGENTS.md)** — it is the single source of project rules. Key docs:
`docs/implementation-status.md`, `docs/architecture/financial-invariants.md`,
`docs/architecture/sync-protocol.md`, `docs/architecture/decisions/`, `docs/api/openapi.yaml`.

Critical reminders for Claude Code sessions:
- Run every toolchain in Docker via `scripts/go.sh` / `scripts/bun.sh`; use `sg docker -c "docker …"` if
  plain `docker` is denied. Never install anything on the host. Bun only (no npm/pnpm/yarn).
- Never stop, remove or prune containers/volumes/images/networks that are not `finplat*`. Never touch other
  cloudflared tunnels. Only bind 127.0.0.1 ports 3810–3812 and 5440.
- Money is `{amount: decimal string, currency}`; never floats. Mutations call `changes.Record` in the same tx.
- Mobile/desktop are DEFERRED_TO_PHASE; Raiffeisen BiH is BLOCKED_EXTERNAL.
