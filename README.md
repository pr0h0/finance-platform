# Finance Platform

Open-source, local-first personal finance: expenses and income across accounts and currencies, planned
and recurring payments, budgets, analytics, forecasting, savings goals, bank-statement import with
immutable source records, optional self-hosted sync with an end-to-end-encryption design, and controlled AI
agent access through MCP. Scope: see [PLAN.md](PLAN.md); progress: [docs/implementation-status.md](docs/implementation-status.md).

**Status:** Phase 0 (foundation) complete — backend modules and the web app are being built. Mobile and
desktop apps are later phases.

## Quick start (self-hosting, Docker only)
```sh
cp .env.example .env        # set POSTGRES_PASSWORD and PUBLIC_URL
docker compose -p finplat up -d --build
curl http://127.0.0.1:3810/api/health
```
The gateway listens on `127.0.0.1:3810` and serves the web app (`/`), the REST API (`/api/v1`) and MCP
(`/mcp`). Put a TLS-terminating reverse proxy or tunnel in front of it — see
[docs/deployment/README.md](docs/deployment/README.md). Backups: `scripts/backup-db.sh`, `scripts/restore-db.sh`.

Resources: ~1 GB RAM for a single household (postgres 1 GB limit, api 512 MB), <1 GB disk + data.

## Development
Everything runs in containers; nothing is installed on the host. See [AGENTS.md](AGENTS.md) for commands,
architecture and rules, and [CONTRIBUTING.md](CONTRIBUTING.md).

| Path | What |
|---|---|
| `apps/api` | Go API (chi, pgx, goose) |
| `apps/web` | React + Vite + Tailwind web app |
| `packages/*` | shared TS: domain, finance-engine, validation, mcp-contracts, storage, sync-client, … |
| `docs/` | architecture, ADRs, API contract, status |

## License
[AGPL-3.0-only](LICENSE) — see [ADR 0007](docs/architecture/decisions/0007-license.md).
