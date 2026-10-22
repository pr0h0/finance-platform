#!/usr/bin/env bash
# Runs the built Linux desktop app (scripts/native.sh linux build) under a virtual display and drives
# it over WebDriver: tests/native/smoke.ts. Screenshots land in tests/native/results/.
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
image=finplat-tauri:linux-test
if [ -n "${REBUILD_IMAGE:-}" ] || ! dockerx image inspect "$image" >/dev/null 2>&1; then
  dockerx build -f "$FINPLAT_ROOT/infrastructure/docker/tauri.Dockerfile" --target linux-test -t "$image" \
    "$FINPLAT_ROOT/infrastructure/docker"
fi
# Fresh HOME per run: a clean app data directory (SQLite, WebKit localStorage).
dockerx run --rm --user 1000:1000 -v "$FINPLAT_ROOT:/repo" -w /repo \
  -v finplat_cargo_target:/cache/target:ro -e HOME=/tmp/home "$image" \
  bash -c 'mkdir -p $HOME && Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1; tauri-driver --port 4444 >/tmp/driver.log 2>&1 & sleep 2; bun tests/native/smoke.ts; rc=$?; [ $rc -eq 0 ] || tail -30 /tmp/driver.log; exit $rc'
