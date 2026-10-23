#!/usr/bin/env bash
# Publish a native app release (auto-update feed): scripts/release.sh <version> ["release notes"]
#   1. sets the version (tauri.conf.json, Cargo.toml), commits "release vX" and pushes the tag vX
#   2. the native workflow builds the signed desktop bundles (secrets TAURI_SIGNING_PRIVATE_KEY*);
#      this script waits for it and downloads them
#   3. builds the signed Android APKs here (apps/native/.signing)
#   4. writes latest.json (desktop updater) and android.json, and copies everything into the gateway's
#      downloads volume: https://fin.pr0h0.me/downloads/ (installed apps see the update within 6 hours)
# Needs: gh (signed in), docker, a clean main branch. Resume after a failure with SKIP_TAG=1.
set -euo pipefail
source "$(dirname "$0")/_docker.sh"
v="${1:?usage: scripts/release.sh <version, e.g. 0.2.0> [notes]}"; v="${v#v}"
notes="${2:-Finance Platform $v}"
base="${DOWNLOADS_URL:-https://fin.pr0h0.me/downloads}"
cd "$FINPLAT_ROOT"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z" >&2; exit 2; }

if [ -z "${SKIP_TAG:-}" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
  sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$v\"/" apps/native/src-tauri/tauri.conf.json
  sed -i "0,/^version = \"[^\"]*\"/s//version = \"$v\"/" apps/native/src-tauri/Cargo.toml
  scripts/native.sh linux run bash -c 'cd src-tauri && cargo metadata --format-version 1 >/dev/null' # Cargo.lock
  git add apps/native/src-tauri/tauri.conf.json apps/native/src-tauri/Cargo.toml apps/native/src-tauri/Cargo.lock
  git commit -q -m "release v$v"
  git tag "v$v"
  git push -q origin HEAD "v$v"
  sleep 15 # let GitHub create the run
fi

run=$(gh run list --workflow native.yml --branch "v$v" --limit 1 --json databaseId --jq '.[0].databaseId')
[ -n "$run" ] || { echo "no native workflow run for v$v" >&2; exit 1; }
echo "waiting for https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/actions/runs/$run"
gh run watch "$run" --exit-status >/dev/null

out="$FINPLAT_ROOT/apps/native/dist/release/$v"
rm -rf "$out" && mkdir -p "$out/gh"
gh run download "$run" -D "$out/gh" -n finplat-linux -n finplat-windows -n finplat-macos

scripts/native.sh android build
cp apps/native/dist/android/app-*-release.apk "$out/"

# Flat, space-free file names: <version>/<file> on the server.
one() { find "$out/gh" -path "$1" | head -1; }
pick() { # pattern, published name -> copies bundle + reads its signature
  local f; f=$(one "$1"); [ -n "$f" ] || { echo "missing $1 in the workflow artifacts" >&2; exit 1; }
  cp "$f" "$out/$2"; [ -f "$f.sig" ] && cp "$f.sig" "$out/$2.sig"; true
}
pick '*/appimage/*.AppImage' "finance-platform_${v}_amd64.AppImage"
pick '*/deb/*.deb' "finance-platform_${v}_amd64.deb"
pick '*/rpm/*.rpm' "finance-platform-${v}.x86_64.rpm"
pick '*/nsis/*.exe' "finance-platform_${v}_x64-setup.exe"
pick '*/msi/*.msi' "finance-platform_${v}_x64.msi"
pick '*/macos/*.app.tar.gz' "finance-platform_${v}_universal.app.tar.gz"
pick '*/dmg/*.dmg' "finance-platform_${v}_universal.dmg"
rm -rf "$out/gh"
for f in AppImage setup.exe app.tar.gz; do
  ls "$out"/*"$f".sig >/dev/null || { echo "no signature for *$f: is TAURI_SIGNING_PRIVATE_KEY set on GitHub?" >&2; exit 1; }
done

sig() { tr -d '\n' < "$out/$1.sig"; }
url() { echo "$base/$v/$1"; }
app="finance-platform_${v}_universal.app.tar.gz"
cat > "$out/latest.json" <<EOF
{
  "version": "$v",
  "notes": "$(printf '%s' "$notes" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "linux-x86_64": { "signature": "$(sig "finance-platform_${v}_amd64.AppImage")", "url": "$(url "finance-platform_${v}_amd64.AppImage")" },
    "windows-x86_64": { "signature": "$(sig "finance-platform_${v}_x64-setup.exe")", "url": "$(url "finance-platform_${v}_x64-setup.exe")" },
    "darwin-aarch64": { "signature": "$(sig "$app")", "url": "$(url "$app")" },
    "darwin-x86_64": { "signature": "$(sig "$app")", "url": "$(url "$app")" }
  }
}
EOF
cat > "$out/android.json" <<EOF
{ "version": "$v", "url": "$(url app-arm64-release.apk)" }
EOF

# Bundles first, the feeds last: an app never sees a feed pointing at a file not there yet.
dockerx run --rm -v finplat_downloads:/srv/downloads -v "$out:/in:ro" alpine:3 sh -c \
  "mkdir -p /srv/downloads/$v && cp /in/* /srv/downloads/$v/ && cp /in/latest.json /in/android.json /srv/downloads/ && chmod -R a+rX /srv/downloads"
echo "published v$v: $base/latest.json"
# ponytail: old versions stay in the volume; delete /srv/downloads/<old version> by hand when space matters.
