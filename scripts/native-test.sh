#!/usr/bin/env bash
# Smoke tests of the built native apps, in docker. Screenshots land in tests/native/results/.
#   scripts/native-test.sh [linux]   the Linux binary (scripts/native.sh linux build) under Xvfb over WebDriver
#                                    (tauri-driver + WebKitWebDriver): tests/native/smoke.ts
#   scripts/native-test.sh linux-connected   the Linux binary against the isolated E2E server stack
#                                    (compose project finplat-e2e, removed afterwards): register, bearer
#                                    token, sync, restart: tests/native/smoke-connected.ts
#   scripts/native-test.sh android   the debug APK (scripts/native.sh android run bunx tauri android build
#                                    --debug --apk --target x86_64) in a headless emulator (needs /dev/kvm),
#                                    its WebView driven over CDP: tests/native/android-smoke.ts
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
target="${1:-linux}"
image="finplat-tauri:${target%-connected}-test"
if [ -n "${REBUILD_IMAGE:-}" ] || ! dockerx image inspect "$image" >/dev/null 2>&1; then
  dockerx build -f "$FINPLAT_ROOT/infrastructure/docker/tauri.Dockerfile" --target "${target%-connected}-test" -t "$image" \
    "$FINPLAT_ROOT/infrastructure/docker"
fi
case "$target" in
  linux)
    # Fresh HOME per run: a clean app data directory (SQLite, WebKit localStorage).
    dockerx run --rm --user 1000:1000 -v "$FINPLAT_ROOT:/repo" -w /repo \
      -v finplat_cargo_target:/cache/target:ro -e HOME=/tmp/home "$image" \
      bash -c 'mkdir -p $HOME && Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1; tauri-driver --port 4444 >/tmp/driver.log 2>&1 & sleep 2; bun tests/native/smoke.ts; rc=$?; [ $rc -eq 0 ] || tail -30 /tmp/driver.log; exit $rc' ;;
  linux-connected)
    compose=(compose -p finplat-e2e -f "$FINPLAT_ROOT/docker-compose.yml" -f "$FINPLAT_ROOT/docker-compose.e2e.yml")
    dockerx "${compose[@]}" up -d --build --wait
    cleanup() { [ -n "${KEEP_E2E_STACK:-}" ] || dockerx "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; }
    trap cleanup EXIT
    # Inside the gateway's network namespace the server is http://localhost:8080 (plain http is only
    # accepted for localhost).
    dockerx run --rm --user 1000:1000 --network container:finplat-e2e-gateway-1 -v "$FINPLAT_ROOT:/repo" -w /repo \
      -v finplat_cargo_target:/cache/target:ro -e HOME=/tmp/home "$image" \
      bash -c 'mkdir -p $HOME && Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1; tauri-driver --port 4444 >/tmp/driver.log 2>&1 & sleep 2; bun tests/native/smoke-connected.ts; rc=$?; [ $rc -eq 0 ] || tail -30 /tmp/driver.log; exit $rc' ;;
  android)
    apk=apps/native/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
    [ -f "$FINPLAT_ROOT/$apk" ] || { echo "missing $apk: build the debug APK first" >&2; exit 1; }
    kvm_gid=$(stat -c %g /dev/kvm)
    # One-line script: the `sg docker` fallback of _docker.sh cannot pass newlines.
    # A fixed name: a run killed from outside (timeout) must not leave its emulator running.
    dockerx rm -f finplat-android-test >/dev/null 2>&1 || true
    trap 'dockerx rm -f finplat-android-test >/dev/null 2>&1 || true' EXIT
    dockerx run --rm --name finplat-android-test --user 1000:1000 --device /dev/kvm --group-add "$kvm_gid" -v "$FINPLAT_ROOT:/repo" -w /repo \
      -e HOME=/tmp/home -e DEBUG "$image" \
      bash -c "mkdir -p \$HOME && (emulator -avd test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -accel on >/tmp/emulator.log 2>&1 &) && adb wait-for-device && for i in \$(seq 1 120); do [ \"\$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')\" = 1 ] && break; sleep 2; done && echo emulator booted && adb shell settings put global window_animation_scale 0 && adb install -r $apk >/dev/null && echo apk installed && bun tests/native/android-smoke.ts; rc=\$?; [ \$rc -eq 0 ] || tail -20 /tmp/emulator.log; exit \$rc" ;;
  *) echo "usage: scripts/native-test.sh [linux|linux-connected|android]" >&2; exit 2 ;;
esac
