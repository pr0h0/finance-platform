#!/usr/bin/env bash
# Run the same checks as .github/workflows/ci.yml locally, every toolchain in docker.
# Go DB tests use the dev postgres (started if needed; the dev stack is never stopped).
# Usage: scripts/ci.sh            (SKIP_DOCKER_BUILD=1 skips the image builds)
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
cd "$FINPLAT_ROOT"
step() { printf '\n==> %s\n' "$*"; }

step "gofmt"
out=$(dockerx run --rm --user 1000:1000 -v "$FINPLAT_ROOT/apps/api:/src" -w /src golang:1.27-alpine gofmt -l .)
[ -z "$out" ] || { echo "$out"; exit 1; }

step "dev postgres for DB tests"
dockerx compose -f docker-compose.dev.yml up -d --wait postgres

step "go vet"
scripts/go.sh vet ./...
step "go test -race"
# -race needs cgo: the debian golang image has gcc.
GO_IMAGE=golang:1.27 GO_ENV=CGO_ENABLED=1 scripts/go.sh test -race -count=1 ./...

step "bun install --frozen-lockfile"
scripts/bun.sh install --frozen-lockfile
step "typecheck";            scripts/bun.sh run typecheck
step "lint";                 scripts/bun.sh run lint
step "test";                 scripts/bun.sh run test
step "generated API types";  scripts/bun.sh run api:check
step "openapi lint"
dockerx run --rm --user 1000:1000 -v "$FINPLAT_ROOT:/spec" -w /spec redocly/cli:2.67.1 lint docs/api/openapi.yaml
step "web build";            BUN_WORKDIR=apps/web scripts/bun.sh run build

if [ -z "${SKIP_DOCKER_BUILD:-}" ]; then
  for img in api web gateway; do
    step "docker build $img"
    dockerx build -q -t "finplat-ci-$img:local" -f "infrastructure/docker/$img.Dockerfile" .
  done
fi
printf '\nci: all checks passed\n'
