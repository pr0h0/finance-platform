#!/usr/bin/env bash
# Run the Playwright E2E suite (tests/e2e) in the official image against an ISOLATED stack:
# compose project finplat-e2e (prod images, fresh database, no host ports); the browser shares the
# e2e gateway's network namespace, so the app is http://localhost:8080 (a secure context).
# The public instance (finplat, 127.0.0.1:3810) is never touched. The e2e stack and its volumes
# are removed afterwards (KEEP_E2E_STACK=1 keeps it).
# The real-API sync/parity tests run first against the same stack.
# Usage: scripts/e2e.sh [playwright test args]
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
compose=(compose -p finplat-e2e -f "$FINPLAT_ROOT/docker-compose.yml" -f "$FINPLAT_ROOT/docker-compose.e2e.yml")
dockerx "${compose[@]}" up -d --build --wait
cleanup() { [ -n "${KEEP_E2E_STACK:-}" ] || dockerx "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT
tty=(); [ -t 0 ] && tty=(-it)
# The first account on a server is its admin: register a known one before anything else
# (tests/e2e/specs/admin.spec.ts signs in with it). A rerun on a kept stack gets 409: fine.
admin='{"email":"admin@e2e.test","password":"correct horse battery staple","displayName":"E2E admin"}'
dockerx run --rm --network finplat-e2e_default -e "ADMIN=$admin" oven/bun:1.4 bun -e 'const r = await fetch("http://api:8080/api/v1/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: process.env.ADMIN }); if (r.status !== 201 && r.status !== 409) { console.error(r.status, await r.text()); process.exit(1); }'
# client sync engine + TS engine vs the real Go API (packages/sync-client/src/real-server.test.ts)
dockerx run --rm ${tty[@]+"${tty[@]}"} --user 1000:1000 --network finplat-e2e_default \
  -v "$FINPLAT_ROOT:/repo" -w /repo -v finplat_bun:/cache/bun -e BUN_INSTALL_CACHE_DIR=/cache/bun -e HOME=/tmp \
  -e FINPLAT_API_URL=http://api:8080 oven/bun:1.4 bun test packages/sync-client/src/real-server.test.ts
dockerx run --rm ${tty[@]+"${tty[@]}"} --user 1000:1000 --network container:finplat-e2e-gateway-1 --ipc host \
  -v "$FINPLAT_ROOT:/repo" -w /repo/tests/e2e -e HOME=/tmp \
  -e E2E_BASE_URL=http://localhost:8080 ${CI:+-e CI=1} \
  mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test "$@"
