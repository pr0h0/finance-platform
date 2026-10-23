#!/usr/bin/env bash
# Smoke tests of the built native apps, in docker. Screenshots land in tests/native/results/.
#   scripts/native-test.sh [linux]   the Linux binary (scripts/native.sh linux build) under Xvfb over WebDriver
#                                    (tauri-driver + WebKitWebDriver): tests/native/smoke.ts
#   scripts/native-test.sh android   the debug APK (scripts/native.sh android run bunx tauri android build
#                                    --debug --apk --target x86_64) in a headless emulator (needs /dev/kvm),
#                                    its WebView driven over CDP: tests/native/android-smoke.ts
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
target="${1:-linux}"
image="finplat-tauri:$target-test"
if [ -n "${REBUILD_IMAGE:-}" ] || ! dockerx image inspect "$image" >/dev/null 2>&1; then
  dockerx build -f "$FINPLAT_ROOT/infrastructure/docker/tauri.Dockerfile" --target "$target-test" -t "$image" \
    "$FINPLAT_ROOT/infrastructure/docker"
fi
case "$target" in
  linux)
    # Fresh HOME per run: a clean app data directory (SQLite, WebKit localStorage).
    dockerx run --rm --user 1000:1000 -v "$FINPLAT_ROOT:/repo" -w /repo \
      -v finplat_cargo_target:/cache/target:ro -e HOME=/tmp/home "$image" \
      bash -c 'mkdir -p $HOME && Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 1; tauri-driver --port 4444 >/tmp/driver.log 2>&1 & sleep 2; bun tests/native/smoke.ts; rc=$?; [ $rc -eq 0 ] || tail -30 /tmp/driver.log; exit $rc' ;;
  android)
    apk=apps/native/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
    [ -f "$FINPLAT_ROOT/$apk" ] || { echo "missing $apk: build the debug APK first" >&2; exit 1; }
    kvm_gid=$(stat -c %g /dev/kvm)
    # One-line script: the `sg docker` fallback of _docker.sh cannot pass newlines.
    dockerx run --rm --user 1000:1000 --device /dev/kvm --group-add "$kvm_gid" -v "$FINPLAT_ROOT:/repo" -w /repo \
      -e HOME=/tmp/home "$image" \
      bash -c "mkdir -p \$HOME && (emulator -avd test -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -accel on >/tmp/emulator.log 2>&1 &) && adb wait-for-device && for i in \$(seq 1 120); do [ \"\$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')\" = 1 ] && break; sleep 2; done && echo emulator booted && adb shell settings put global window_animation_scale 0 && adb install -r $apk >/dev/null && echo apk installed && bun tests/native/android-smoke.ts; rc=\$?; [ \$rc -eq 0 ] || tail -20 /tmp/emulator.log; exit \$rc" ;;
  *) echo "usage: scripts/native-test.sh [linux|android]" >&2; exit 2 ;;
esac
