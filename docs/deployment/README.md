# Deployment

## Single server (Docker Compose)
1. `cp .env.example .env` and set at least:
   - `POSTGRES_PASSWORD` — `openssl rand -base64 36`
   - `BACKUP_ENCRYPTION_KEY` — `openssl rand -base64 32` (server backups are unencrypted without it)
   - `PUBLIC_URL=https://fin.example.com` (https ⇒ Secure cookies) and `ALLOWED_ORIGINS` (same origin;
     add `http://127.0.0.1:3810` only if you also browse to the loopback port)
   - `REGISTRATION_POLICY=first_user` (first account becomes admin, later sign-ups refused)
   - `MCP_ENABLED=true` if AI agents should reach `/mcp`
   `.env` is git-ignored; never commit it.
2. `docker compose -p finplat up -d --build` (with rootless group access: `sg docker -c "docker compose -p finplat up -d --build"`).
   Only the gateway is published, on `127.0.0.1:3810`; it serves the web app, `/api` and `/mcp`.
3. Migrations run on API start (`MIGRATE_ON_START=true`); manual: `docker compose -p finplat run --rm api migrate`.
4. Check: `curl -s 127.0.0.1:3810/api/health` → `{"database":"ok","status":"ok"}`;
   `curl -s 127.0.0.1:3810/api/v1/meta` shows `publicUrl`, `schemaVersion` (latest migration) and `mcpEnabled`.
5. Update: `git pull && docker compose -p finplat up -d --build`. Stop: `docker compose -p finplat down`
   (never `down -v`: it deletes the database volume).

## HTTPS with a Cloudflare Tunnel (used for https://fin.pr0h0.me)
The gateway speaks plain HTTP and trusts `X-Forwarded-Proto` from the terminator; cloudflared sets it to
`https`. Use a **dedicated** tunnel so other tunnels on the host are never touched:

```sh
cloudflared tunnel login                         # once per machine (creates ~/.cloudflared/cert.pem)
cloudflared tunnel create finplat                # new tunnel + credentials file <UUID>.json
cloudflared tunnel route dns finplat fin.pr0h0.me
```

Config in its own file, e.g. `~/.cloudflared/finplat.yml` (do not edit other tunnels' configs):

```yaml
tunnel: finplat
credentials-file: /home/<user>/.cloudflared/<UUID>.json
ingress:
  - hostname: fin.pr0h0.me
    service: http://127.0.0.1:3810
    originRequest:
      noTLSVerify: false
  - service: http_status:404
```

Run it as its own process/service: `cloudflared tunnel --config ~/.cloudflared/finplat.yml run finplat`
(for systemd, a separate unit such as `cloudflared-finplat.service` with that ExecStart). Streaming
responses (`/mcp`, sync) work through the tunnel; the gateway disables proxy buffering for them.

Alternatives: Caddy/Traefik/nginx with Let's Encrypt in front of 3810 (forward `X-Forwarded-Proto`).

## First run on the public URL
With `REGISTRATION_POLICY=first_user`, open https://fin.example.com, choose "Connect to server" and create
the first account: it becomes the admin. Admins can change the policy at runtime under /admin.

## Backups
- `scripts/backup-db.sh` writes `backups/finplat-<UTC>.dump` (pg_dump custom format);
  `scripts/restore-db.sh <file>` restores (asks for confirmation, single transaction).
- Application-level per-profile backups: `BACKUP_SCHEDULE` (default 24h) into the `apidata` volume
  (`/data/backups`), AES-256-GCM with `BACKUP_ENCRYPTION_KEY`; also `/api/v1/backups` and Settings → Backups.

## Tests against a running stack
`scripts/e2e.sh` runs the Playwright suite (tests/e2e) against `E2E_BASE_URL` (default 127.0.0.1:3810). It
registers test users, so on a public instance run it only with `REGISTRATION_POLICY=open` and reset the
database afterwards (`docker compose -p finplat down && docker volume rm finplat_pgdata && docker compose -p finplat up -d`).

## Resources
Postgres limit 1 GB, API 512 MB; web/gateway nginx ~20 MB each.
