# Deployment

## Single server (Docker Compose)
1. `cp .env.example .env`; set `POSTGRES_PASSWORD` (long random), `PUBLIC_URL`, `ALLOWED_ORIGINS`.
2. `docker compose -p finplat up -d --build` → gateway on `127.0.0.1:3810`.
3. Migrations run on API start (`MIGRATE_ON_START=true`); manual: `docker compose -p finplat run --rm api migrate`.

## HTTPS / public exposure
The gateway speaks plain HTTP and trusts `X-Forwarded-Proto` from the terminator. With `PUBLIC_URL=https://…`
the API marks cookies `Secure`. Options:
- **Cloudflare Tunnel** (used for https://fin.pr0h0.me): a *dedicated* tunnel/ingress rule pointing
  `fin.pr0h0.me → http://127.0.0.1:3810`. Add it as a new tunnel; do not edit other tunnels on the host.
- Caddy/Traefik/nginx with Let's Encrypt in front of 3810.

## Backups
`scripts/backup-db.sh` writes `backups/finplat-<UTC>.dump` (pg_dump custom format).
`scripts/restore-db.sh <file>` restores (asks for confirmation, single transaction).
Application-level encrypted backups (per profile) are Feature 89/90 (`/api/v1/backups`).

## Resources
Postgres limit 1 GB, API 512 MB; web/gateway nginx ~20 MB each.
