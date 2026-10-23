#!/usr/bin/env bash
# Tauri toolchain in docker (infrastructure/docker/tauri.Dockerfile); nothing is installed on the host.
#   scripts/native.sh linux build            Linux bundles (.deb .rpm .AppImage) -> apps/native/dist/linux
#   scripts/native.sh android build          Android .apk/.aab (debug-signed unless a keystore is set up) -> apps/native/dist/android
#   scripts/native.sh linux check            cargo check of the Rust crate
#   scripts/native.sh <linux|android> run <cmd...>   any command in the toolchain (cwd apps/native)
# macOS, iOS and Windows builds need their own OS: see docs/native/README.md (and .github/workflows/native.yml).
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
target="${1:?usage: scripts/native.sh <linux|android> <build|check|run ...>}"
cmd="${2:?missing command}"
shift 2
image="finplat-tauri:$target"
if [ -n "${REBUILD_IMAGE:-}" ] || ! dockerx image inspect "$image" >/dev/null 2>&1; then
  dockerx build -f "$FINPLAT_ROOT/infrastructure/docker/tauri.Dockerfile" --target "$target" -t "$image" \
    "$FINPLAT_ROOT/infrastructure/docker"
fi
# ANDROID_USER_HOME holds the debug keystore: kept in a volume so debug APKs update each other.
finplat_prepare_volumes finplat_cargo finplat_cargo_target finplat_bun finplat_gradle
tty=(); [ -t 0 ] && tty=(-it)
run() {
  dockerx run --rm "${tty[@]}" --user 1000:1000 \
    -v "$FINPLAT_ROOT:/repo" -w /repo/apps/native -e HOME=/tmp \
    -v finplat_cargo:/cache/cargo -v finplat_cargo_target:/cache/target -v finplat_gradle:/cache/gradle \
    -v finplat_bun:/cache/bun -e BUN_INSTALL_CACHE_DIR=/cache/bun -e CI=true \
    -e ANDROID_USER_HOME=/cache/gradle/android-user \
    ${ANDROID_KEYSTORE_PROPERTIES:+-e ANDROID_KEYSTORE_PROPERTIES} \
    "$image" "$@"
}
case "$cmd" in
  check) run bash -c 'cd src-tauri && cargo check' ;;
  build)
    case "$target" in
      linux)
        run bash -c 'bun install --frozen-lockfile >/dev/null && bunx tauri build "$@" && mkdir -p dist/linux && cp -r /cache/target/release/bundle/* dist/linux/' _ "$@" ;;
      android)
        # gen/android is created once by `tauri android init` and committed. (One-line scripts: the
        # `sg docker` fallback in _docker.sh cannot pass newlines.)
        run bash -c 'bun install --frozen-lockfile >/dev/null && { [ -d src-tauri/gen/android ] || bunx tauri android init --ci; } && bunx tauri android build --apk --split-per-abi "$@" && bunx tauri android build --aab "$@" && rm -rf dist/android && mkdir -p dist/android && find src-tauri/gen/android/app/build/outputs \( -name "*.apk" -o -name "*.aab" \) -exec cp {} dist/android/ \;' _ "$@" ;;
    esac ;;
  run) run "$@" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
