#!/usr/bin/env bash
# Run the Go toolchain inside docker against apps/api. Usage: scripts/go.sh test ./...
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
finplat_prepare_volumes finplat_gomod finplat_gobuild
# DB tests (internal/testdb) create throwaway databases on the dev postgres when it is running.
if [ -z "${TEST_DATABASE_URL:-}" ] && finplat_dev_up; then
  TEST_DATABASE_URL="postgres://finplat:finplat@postgres:5432/finplat?sslmode=disable"
fi
tty=(); [ -t 0 ] && tty=(-it)
# shellcheck disable=SC2046
exec_args=(run --rm ${tty[@]+"${tty[@]}"} --user 1000:1000 $(finplat_network_args)
  -v "$FINPLAT_ROOT:/repo" -w /repo/apps/api
  -v finplat_gomod:/cache/go -v finplat_gobuild:/cache/gobuild
  -e GOCACHE=/cache/gobuild -e GOPATH=/cache/go -e HOME=/tmp -e GOFLAGS=-buildvcs=false
  -e TEST_DATABASE_URL="${TEST_DATABASE_URL:-}"
  ${GO_ENV:+-e $GO_ENV} "${GO_IMAGE:-golang:1.27-alpine}" go "$@")
dockerx "${exec_args[@]}"
