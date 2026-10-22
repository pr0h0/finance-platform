#!/usr/bin/env bash
# Run the Playwright E2E suite (tests/e2e) in the official image against an ISOLATED stack:
# compose project finplat-e2e (prod images, fresh database, no host ports); the browser shares the
# e2e gateway's network namespace, so the app is http://localhost:8080 (a secure context).
# The public instance (finplat, 127.0.0.1:3810) is never touched. The e2e stack and its volumes
# are removed afterwards (KEEP_E2E_STACK=1 keeps it).
# Usage: scripts/e2e.sh [playwright test args]
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
compose=(compose -p finplat-e2e -f "$FINPLAT_ROOT/docker-compose.yml" -f "$FINPLAT_ROOT/docker-compose.e2e.yml")
dockerx "${compose[@]}" up -d --build --wait
cleanup() { [ -n "${KEEP_E2E_STACK:-}" ] || dockerx "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT
tty=(); [ -t 0 ] && tty=(-it)
dockerx run --rm "${tty[@]}" --user 1000:1000 --network container:finplat-e2e-gateway-1 --ipc host \
  -v "$FINPLAT_ROOT:/repo" -w /repo/tests/e2e -e HOME=/tmp \
  -e E2E_BASE_URL=http://localhost:8080 ${CI:+-e CI=1} \
  mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test "$@"
