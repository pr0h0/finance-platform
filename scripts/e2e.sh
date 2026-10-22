#!/usr/bin/env bash
# Run the Playwright E2E suite (tests/e2e) in the official image against the running stack.
# Usage: scripts/e2e.sh [playwright test args]   (E2E_BASE_URL defaults to http://127.0.0.1:3810)
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
tty=(); [ -t 0 ] && tty=(-it)
dockerx run --rm "${tty[@]}" --user 1000:1000 --network host --ipc host \
  -v "$FINPLAT_ROOT:/repo" -w /repo/tests/e2e -e HOME=/tmp \
  -e E2E_BASE_URL="${E2E_BASE_URL:-http://127.0.0.1:3810}" ${CI:+-e CI=1} \
  mcr.microsoft.com/playwright:v1.63.0-noble node node_modules/@playwright/test/cli.js test "$@"
