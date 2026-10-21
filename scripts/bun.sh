#!/usr/bin/env bash
# Run bun inside docker at the repo root. Usage: scripts/bun.sh install | scripts/bun.sh run test
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
finplat_prepare_volumes finplat_bun
tty=(); [ -t 0 ] && tty=(-it)
workdir="/repo${BUN_WORKDIR:+/$BUN_WORKDIR}"
# shellcheck disable=SC2046
dockerx run --rm "${tty[@]}" --user 1000:1000 $(finplat_network_args) \
  -v "$FINPLAT_ROOT:/repo" -w "$workdir" \
  -v finplat_bun:/cache/bun -e BUN_INSTALL_CACHE_DIR=/cache/bun -e HOME=/tmp \
  ${BUN_PORTS:+-p $BUN_PORTS} \
  oven/bun:1.4 bun "$@"
