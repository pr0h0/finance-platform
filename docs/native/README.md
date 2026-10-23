# Native apps (desktop + mobile)

One Tauri 2 project, `apps/native`, builds the Finance Platform app for **Linux, Windows, macOS,
Android and iOS** around the same React web app (`apps/web`). Read this file first when you continue
native work on another machine or in a new session: it says what is done, what was verified where,
and what is left per platform.

Last updated: 2026-10-23 (macOS and iOS tested on a Mac).

## Status per platform

| Platform | Builds | Verified | Where it was verified | Left to do |
|---|---|---|---|---|
| Linux | ✅ `.deb`, `.rpm`, `.AppImage` (docker: `scripts/native.sh linux build`; also GitHub Actions) | ✅ two automated smoke tests drive the real binary: local mode (`scripts/native-test.sh`) and connected mode against a real server (`scripts/native-test.sh linux-connected`) | this Linux server, Xvfb + WebDriver | a real desktop session: tray icon, global shortcut, OS notifications |
| Android | ✅ signed per-ABI `.apk` + `.aab` (docker: `scripts/native.sh android build`; GitHub Actions unsigned) | ✅ automated smoke test in an emulator (`scripts/native-test.sh android`): local mode, restart, back button | this Linux server, Android 15 emulator (KVM) | a real phone: biometrics, camera, notifications, connected mode (checklist) |
| Windows | ✅ `.msi` + setup `.exe` (GitHub Actions `native`, 2026-10-23) | ⬜ not run on Windows yet | — | install on Windows/VM, checklist below; code signing |
| macOS | ✅ `.app` on a Mac (`bunx tauri build`), universal `.dmg` on GitHub Actions | ✅ automated smoke tests (`bun tests/native/apple-smoke.ts macos`): local mode (quit, relaunch, data kept) and connected mode against a local server (register, sync, token in the Keychain, macos device, signed in after restart) | MacBook (Apple Silicon, macOS 26.5), 2026-10-23 | tray / shortcut by hand, signing/notarization |
| iOS | ✅ simulator `.app` (`bunx tauri ios build --debug --target aarch64-sim`); `gen/apple` committed | ✅ automated smoke tests in the simulator (`bun tests/native/apple-smoke.ts ios`): local and connected mode (Keychain, ios device); used by hand connected to fin.pr0h0.me: sync, all pages fit the screen (safe areas OK) | iPhone 17 / 17 Pro simulators, iOS 26.5, 2026-10-23 | a real iPhone (Personal Team), Face ID, camera |

✅ = done and checked, ⬜ = open. GitHub artifacts: Actions → **native** → the run → Artifacts
(`finplat-linux`, `finplat-windows`, `finplat-macos`, `finplat-android`, `finplat-ios-simulator`).
The workflow runs only on "Run workflow" or a `v*` tag (macOS minutes count 10× on a private repo).

## How it works

```
apps/web (React, unchanged pages)          apps/native/src-tauri (Rust)
  src/platform/native.ts  ── invoke ──▶    store.rs   SQLite: one file per local store
  src/platform/store.ts                    secret.rs  server token in the OS credential store
                                           lib.rs     plugins, tray, global shortcut
  (isNative = '__TAURI_INTERNALS__')       capabilities/*.json  permissions per window/platform
```

- **Same UI everywhere.** The native app bundles `apps/web/dist`; pages never branch on the platform.
  Native-only behaviour lives in `apps/web/src/platform/` and is lazy-loaded, so the web bundle does
  not change.
- **Storage.** The web app keeps its data in IndexedDB. The native app uses `MemoryStore` from
  `packages/storage` with a `StorePersistence` backend: reads come from memory, every write
  transaction is committed to SQLite first (one SQLite transaction, so a crash never leaves half a
  write; a failed commit changes nothing). Rows are the same JSON as on the web; binary values
  (attachments, original statement files) are tagged base64. Files live in the OS app data dir:
  Linux `~/.local/share/me.pr0h0.finplat/`, Windows `%APPDATA%\me.pr0h0.finplat\`, macOS
  `~/Library/Application Support/me.pr0h0.finplat/`, Android/iOS app sandbox. One file per store:
  `finplat.sqlite3` (local mode) and `finplat@<server host>.sqlite3` (connected mode cache).
  The whole database is held in memory (fine for a personal ledger; see the `ponytail:` note in
  `packages/storage/src/memory.ts` for the upgrade path).
- **Server connection.** The native app can connect to any compatible server (the web app only
  talks to the server that serves it). Requests go through `tauri-plugin-http` (Rust side: no
  CORS), and the app signs in as a native device: `POST /auth/login` with
  `device: {platform: linux|windows|macos|android|ios}` returns a **bearer token**. The token is kept
  in the **OS credential store** (macOS/iOS Keychain, Windows Credential Manager, Linux Secret
  Service: `src-tauri/src/secret.rs`, keyring crate); `app/store.ts` keeps it out of localStorage and
  puts it back at start. Where there is no usable credential store (Android; a Linux session without
  GNOME Keyring/KWallet) it stays in the app's private settings (`connection.token`). Signing in again
  from the "session ended" banner registers a new device and replaces the token.
- **Files.** Exports (CSV, PDF reports, charts), encrypted backups and attachment downloads go through
  one helper (`downloadBlob` in `apps/web/src/lib/format.ts`): a browser download on the web, the
  **OS save dialog** in the app (`tauri-plugin-dialog`; `tauri-plugin-fs` may write only the path the
  user picked). Opening files (imports, receipts) uses the normal file input, which the WebViews
  turn into the OS file picker; drag & drop onto the Import page works (window `dragDropEnabled: false`
  hands drops to the web app).
- **Not in the native app:** service worker / PWA update prompt (the app updates as a whole),
  Web Push (replaced by OS notifications, below), passkeys (WebAuthn is bound to the server's web
  origin; the native app signs in with the password).
- **Notifications.** "Browser notifications" on the Notifications page turns on OS notifications
  (`tauri-plugin-notification`, asks for permission). Local alerts (budget, bills) and new server
  notifications seen by the 60 s poll are shown as OS notifications while the app runs. There is no
  push when the app is closed (that needs APNs/FCM: open item).
- **Desktop extras:** tray icon (Open / Add transaction / Quit), global shortcut
  **Ctrl+Shift+E** (Cmd+Shift+E on macOS) opens quick entry from anywhere, single instance (a second
  launch focuses the running app), **start at login** (Settings → General → Desktop app;
  `tauri-plugin-autostart`, off by default), **keep running in the tray** when the window is closed
  (same card, shown only when the tray icon could be created; off by default because GNOME without the
  AppIndicator extension accepts a tray icon but never shows it; `src/tray.rs`, a `close-to-tray`
  marker file in the app config directory). Links to other sites open in the system browser.
- **Automatic backups (desktop):** Settings → Backups & data → Automatic backups: pick a folder once
  (OS dialog, remembered by `src/backup.rs` in `<app config>/backup-folder`), save a passphrase (kept
  in the OS keychain; the card is disabled without one). The app then writes an encrypted
  `finplat-backup-<date>.finplat` of every profile on the backup schedule (checked at start and hourly,
  `shell/AutoBackup.tsx`) and keeps the newest 10. The web page has no file-system scope: Rust writes
  only files with that name pattern into that folder. Restore as usual (Restore backup).
- **Mobile extras:** the app lock screen offers **fingerprint / Face ID** (tauri-plugin-biometric)
  when the device has it; the PIN stays the fallback. Biometrics only gate the UI, like the PIN.
  Android back button: closes dialogs, goes back in the app, leaves the app only from the dashboard.

## Repository layout

| Path | What |
|---|---|
| `apps/native/package.json` | `@finplat/native` workspace: Tauri CLI |
| `apps/native/src-tauri/tauri.conf.json` | app id `me.pr0h0.finplat`, window, bundle settings; builds `apps/web` first (`beforeBuildCommand`) |
| `apps/native/src-tauri/src/lib.rs` | plugins, tray, global shortcut, mobile entry point |
| `apps/native/src-tauri/src/store.rs` | SQLite persistence commands `store_load`, `store_commit`, `store_destroy` |
| `apps/native/src-tauri/src/secret.rs` | OS credential store commands `secret_get`, `secret_set`, `secret_delete` |
| `apps/native/src-tauri/capabilities/` | permissions: HTTP to any http(s) server, notifications, OS info, opener, save dialog + write of the chosen file; desktop: autostart; mobile: biometric, exit (back button) |
| `apps/native/src-tauri/icons/` | generated from `apps/web/public/icon-512.png` (`bunx tauri icon …`) |
| `apps/native/src-tauri/gen/android` | Android Studio project (generated once, committed) |
| `apps/native/src-tauri/gen/apple` | Xcode project: **not generated yet** (needs a Mac: `bunx tauri ios init`) |
| `apps/web/src/platform/native.ts` | platform detection, HTTP, SQLite persistence, notifications, biometrics, quick-add event |
| `apps/web/src/platform/store.ts` | `openStore(name)`: IndexedDB on the web, SQLite in the app (one instance per name) |
| `packages/storage/src/memory.ts` | `MemoryStore` + `StorePersistence` (tested: `memory-persist.test.ts`) |
| `infrastructure/docker/tauri.Dockerfile` | toolchain images: `linux`, `linux-test`, `android` |
| `scripts/native.sh` | builds in docker: `linux build`, `android build`, `linux check`, `run …` |
| `scripts/native-test.sh` + `tests/native/smoke.ts` | Linux app smoke test over WebDriver |
| `.github/workflows/native.yml` | builds all five platforms on GitHub runners (manual / tags) |

## Building and testing

All commands from the repository root. Versions: Rust stable (1.90+), Bun 1.4.2, Tauri CLI 2.x
(from `bun.lock`), Node not needed.

### Linux (this server, docker)

Toolchain images are built on first use (`infrastructure/docker/tauri.Dockerfile`; `REBUILD_IMAGE=1`
to rebuild). Rust, Cargo, Gradle and Bun caches live in docker volumes `finplat_cargo`,
`finplat_cargo_target`, `finplat_gradle`, `finplat_bun`.


```sh
scripts/native.sh linux build      # -> apps/native/dist/linux/{deb,rpm,appimage}/
scripts/native-test.sh             # starts the built binary under Xvfb and drives it (screenshots: tests/native/results/)
scripts/native-test.sh linux-connected   # same binary against the isolated E2E server stack (register, bearer token, sync, restart)
scripts/native.sh linux check      # cargo fmt --check + clippy (-D warnings) after Rust changes
```

The smoke tests: the app runs inside Tauri with the native bridges, local onboarding, account with an
opening balance, dashboard; quits; the SQLite file exists; starts again and finds the account and
balance restored from SQLite. Connected: registers on the server through the native HTTP client,
signs in as a `linux` device (bearer token), adds an account, syncs; the test checks the server
side through the API; it runs with a Secret Service (gnome-keyring) and checks the token is not in
localStorage; after a restart the app is still signed in (token read back from the keyring) with the
data cached in SQLite. The local test also turns "start at login" on and off (XDG autostart entry). Install a bundle on a desktop: `sudo apt install ./Finance*.deb`, or run
the AppImage directly.

Dev mode with live reload needs a desktop session: on a Linux desktop install the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and run `cd apps/native && bunx tauri dev`.

### Android (this server, docker)

```sh
scripts/native.sh android build    # signed release: apps/native/dist/android/app-arm64-release.apk (phones),
                                   # app-arm-release.apk (old 32-bit phones), x86/x86_64 (emulators), .aab (Play Store)
scripts/native.sh android run bunx tauri android build --debug --apk --target x86_64   # debug APK for the emulator
scripts/native-test.sh android     # boots a headless Android 15 emulator (needs /dev/kvm), installs the debug APK,
                                   # drives its WebView over the DevTools protocol (screenshots: tests/native/results/)
scripts/native-test.sh android-ui  # the same emulator in a window on your X11 desktop, debug APK installed and
                                   # launched, to click around by hand (Ctrl+C stops it)
```

**Docker Desktop has no `/dev/kvm`** (its containers run inside a VM), so the emulator cannot start
there. Install Docker Engine next to it (`sudo apt-get install docker-ce containerd.io`, from the
Docker apt repository Desktop already uses) and point only these commands at it:
`DOCKER_CONTEXT=default scripts/native-test.sh android`. Builds work on either engine.

**Install on your phone:** copy `apps/native/dist/android/app-arm64-release.apk` to the phone (or
`adb install` it), open it, allow "install unknown apps" for the file manager/browser once. Updates
install over the old version only if they are signed with the same key (below).

**Signing key (keep it safe!):** release builds are signed with the upload keystore in
`apps/native/.signing/` (`finplat-upload.jks` + `keystore.properties` with its password; both
gitignored, copy of the properties in `src-tauri/gen/android/keystore.properties`). **Back up the
`.signing` folder** (password manager or encrypted backup): without it you cannot ship updates to
phones that have the app installed, only uninstall + reinstall (which deletes local data). For the
Play Store, use it as the upload key with Play App Signing. On another machine copy the folder back
and recreate `src-tauri/gen/android/keystore.properties` from it; without the file builds are unsigned.

Details of the Android build:
- `src-tauri/gen/android` is the Android Studio project (`tauri android init`, committed). App id
  `me.pr0h0.finplat`, min SDK 24 (Android 7), target/compile SDK 37.
- `MainActivity.kt` pads the web app by the system-bar, display-cutout and keyboard insets: Android
  15+ draws apps edge to edge and the WebView does not report those insets to CSS. The status and
  navigation bar area shows the app's surface color (`res/values*/themes.xml`).
- Back button (`apps/web/src/platform/native.ts`): closes an open dialog/drawer, else goes back in
  the app's history, else to the dashboard, and only there leaves the app.
- Debug builds allow WebView debugging (chrome://inspect on a desktop Chrome with the phone attached
  by USB), which is how the emulator test drives the app.

### Windows (needs a Windows PC or VM)

1. Install: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   ("Desktop development with C++"), [Rust](https://rustup.rs) (MSVC toolchain), [Bun](https://bun.sh).
   WebView2 is already part of Windows 10/11.
2. `git clone https://github.com/pr0h0/finance-platform && cd finance-platform && bun install`
3. Dev: `cd apps/native && bunx tauri dev` (opens the app with live reload of the web app).
4. Release: `bunx tauri build` → `src-tauri/target/release/bundle/msi/*.msi` and `nsis/*-setup.exe`.

Or without a Windows machine: GitHub → Actions → **native** → Run workflow (platforms `windows`),
download the `finplat-windows` artifact, install it in a VM.

### macOS (needs a Mac)

1. Install Xcode (App Store) and run it once, then `xcode-select --install`, Rust, Bun.
   **Rust 1.85 or newer** (dependencies use edition 2024; the docker images use 1.90). If your default
   is older and you do not want to change it: `rustup toolchain install 1.90` and
   `rustup override set 1.90` **in `apps/native`** (not only `src-tauri`: the iOS build runs cargo
   from `apps/native`).
2. `bun install`, then `cd apps/native && bunx tauri dev`.
3. Release: `bunx tauri build --target universal-apple-darwin` (needs
   `rustup target add aarch64-apple-darwin x86_64-apple-darwin`) → `.app` and `.dmg`.
   Unsigned builds open with right-click → Open the first time.

### iOS (needs a Mac with Xcode)

1. `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
2. Xcode needs the **iOS platform of its own SDK version** (Xcode 26.5 → iOS 26.5 simulator,
   ~8.5 GB): `xcodebuild -downloadPlatform iOS` (or Xcode → Settings → Components). Without it every
   iOS build fails with "Simulator SDK … is not installed".
3. `src-tauri/gen/apple` is generated and committed (2026-10-23). Regenerate only when Tauri asks:
   `bunx tauri ios init`. It installs Homebrew packages by itself (`xcodegen`, `libimobiledevice`
   and its `openssl@4`, which relinks the `openssl` command: `brew unlink openssl@4 && brew link
   openssl@3` puts it back) and needs CocoaPods (`brew install cocoapods`; the gem install wants sudo).
   iOS permission texts (Face ID, camera, photos) live in `src-tauri/Info.ios.plist`, merged at build.
4. Simulator: `bunx tauri ios dev` (pick a simulator), or build once and install:
   `bunx tauri ios build --debug --target aarch64-sim` →
   `src-tauri/gen/apple/build/arm64-sim/Finance Platform.app`;
   `xcrun simctl install booted "<that .app>"` and `xcrun simctl launch booted me.pr0h0.finplat`.
   Installing over an existing install keeps its data; `xcrun simctl uninstall booted
   me.pr0h0.finplat` wipes it.
5. Your iPhone: Xcode → Settings → Accounts → add your Apple ID (free "Personal Team"); on the
   iPhone Settings → Privacy & Security → Developer Mode on; connect by cable; then
   `bunx tauri ios dev --host` and pick the phone (Mac and phone on the same Wi-Fi), or
   `bunx tauri ios dev --open` and press Run in Xcode. First run: trust the developer on the phone
   (Settings → General → VPN & Device Management). Free-account installs expire after 7 days.
6. Release / TestFlight: Apple Developer Program ($99/year), set `bundle > iOS > developmentTeam`
   in `tauri.conf.json`, `bunx tauri ios build --export-method app-store-connect`.

### Automated smoke tests on a Mac (macOS app, iOS simulator)

WKWebView has no WebDriver or CDP, so **debug builds** run a tiny page driver (`DRIVER` in
`src-tauri/src/lib.rs`, only when `FINPLAT_DRIVER` is set; not compiled into release builds): it polls
the test's local HTTP server for an expression, evaluates it and posts the result back.
`tests/native/apple-smoke.ts` runs the same scenario as Linux/Android (`tests/native/page.ts`):

```bash
cd apps/native && bunx tauri build --debug --no-bundle && cd ../..
bun tests/native/apple-smoke.ts macos            # throwaway HOME: your real app data is untouched

cd apps/native && bunx tauri ios build --debug --target aarch64-sim && cd ../..
xcrun simctl boot "iPhone 17 Pro"                # any simulator of the installed iOS runtime
SIM=booted APP="$PWD/apps/native/src-tauri/gen/apple/build/arm64-sim/Finance Platform.app" \
  bun tests/native/apple-smoke.ts ios            # reinstalls the app: wipes the simulator's app data
```

With `SERVER=http://localhost:3811` it runs the connected scenario instead (register, sync, token in
the Keychain and not in localStorage, device platform on the server, still signed in after a
restart). Debug builds keep the token under their own Keychain service `me.pr0h0.finplat.debug`
(`secret.rs`; the test deletes it afterwards) and, when test-driven (`FINPLAT_DRIVER`), skip the
single-instance plugin: tests run beside an installed copy of the app without touching it. Use a
simulator you do not use by hand for `ios` (the test reinstalls the app).
Start a throwaway server first: the E2E stack published on 127.0.0.1:3811 (no `.env` needed):

```bash
cat > /tmp/compose.mac.yml <<'YML'
services:
  api:
    env_file: !reset []
    environment: { PUBLIC_URL: http://localhost:3811, ALLOWED_ORIGINS: http://localhost:3811 }
  gateway:
    ports: !override ["127.0.0.1:3811:8080"]
YML
POSTGRES_PASSWORD=e2e-local docker compose -p finplat-e2e -f docker-compose.yml \
  -f docker-compose.e2e.yml -f /tmp/compose.mac.yml up -d --build --wait
```

The browser E2E suite runs on a Mac too (`scripts/e2e.sh`; Docker Desktop, a `.env` with at least
`POSTGRES_PASSWORD`, which is gitignored). If Docker commands hang while `docker version` answers,
Docker Desktop's VM is down: quit Docker Desktop completely and start it again (it may ask for the
admin password).

Screenshots go to `tests/native/results/` (iOS always; macOS only if the terminal has the Screen
Recording permission).

## Checklists for final testing on each OS

Run through these on the real OS; tick them here (and in `docs/implementation-status.md`) when done.

### Every platform
- [ ] App starts, onboarding in local mode, add account and transactions, restart: data still there.
- [ ] Connected mode: Welcome → "Connect to server" → `https://fin.pr0h0.me` → sign in with the
      password → profile list → dashboard; the Sync page shows no errors; Settings → Devices on the
      web shows the native device with its platform.
- [ ] Import a statement PDF (file picker and drag & drop onto the Import page).
- [ ] Receipt photo / attachment on a transaction; open it again after a restart.
- [ ] Notifications page → turn on → a budget alert or reminder shows as an OS notification.
- [ ] App lock: set a PIN in Settings → Security, restart, unlock.
- [ ] Export (CSV / PDF report) saves a file the user can find.
- [ ] Links in the app (e.g. "Open <server>") open the system browser.

### Desktop (Windows, macOS, Linux desktop)
- [ ] Tray icon menu: Open, Add transaction, Quit.
- [ ] Settings → Backups & data → Automatic backups: choose a folder (OS dialog), save a passphrase,
      "Back up now" writes a file there; it restores on another device.
- [ ] Settings → General → "Keep running in the tray": closing the window hides it, the tray's Open
      brings it back, Quit ends the app; off again: closing the window quits.
- [ ] Ctrl+Shift+E (Cmd+Shift+E) opens quick entry while another app is focused.
- [ ] Starting the app twice focuses the first window.
- [ ] Windows: SmartScreen warning on the unsigned installer (expected until code signing).
- [ ] macOS: Gatekeeper on the unsigned app (right-click → Open), dark mode follows the system.

### Mobile (Android, iOS)
- [ ] Layout: bottom navigation and quick add work with the thumb; text scaling.
- [ ] Biometric unlock on the lock screen (and PIN fallback).
- [ ] Camera: "Read receipt" / attachment offers the camera.
- [ ] Back button / swipe back behaves (Android: back goes back in the app, exits at the dashboard).
- [ ] Background → foreground keeps state; sync resumes.

## Releases and signing

| Platform | Unsigned today | To sign |
|---|---|---|
| Windows | SmartScreen warning | Azure Trusted Signing (~$10/month) or a code-signing certificate; `bundle > windows > signCommand` |
| macOS | Gatekeeper warning | Apple Developer ID + notarization (`APPLE_*` env vars for `tauri build`) |
| iOS | simulator only | Apple Developer Program, TestFlight |
| Android | see Android section | keystore (see Android section); Play Store $25 once |
| Linux | none needed | optional: sign the AppImage / host an apt repo |

### Auto-update (done 2026-10-23)

Installed apps check `https://fin.pr0h0.me/downloads/latest.json` at start and every 6 hours and
show a bar "Finance Platform X is available — Update / Later" (`apps/web/src/platform/updates.ts`,
`shell/NativeUpdatePrompt.tsx`).
- **Desktop:** `tauri-plugin-updater` downloads the bundle, verifies its minisign signature against
  `plugins.updater.pubkey` (tauri.conf.json) and installs it, then the app restarts. Linux updates
  the **AppImage** only (a .deb/.rpm install has to be updated by installing the new package);
  Windows runs the NSIS installer (passive); macOS replaces the `.app`.
- **Android:** `downloads/android.json` names the newest arm64 APK; "Update" opens it in the browser and
  the package installer installs it over the old app (same upload key, higher versionCode, which
  Tauri derives from the version).
- **iOS:** no in-app updates (App Store / TestFlight later).
- **Keys:** `apps/native/.signing/updater.key` + `updater.password` (gitignored, only on the Linux
  server; **back them up**, a new key breaks updates of every installed app), also stored as GitHub
  secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Feed hosting:** the gateway serves the `finplat_downloads` volume at `/downloads/`
  (`infrastructure/docker/gateway.conf`); `*.json` is never cached.

**Publish a release** (on the Linux server, clean `main`):
```bash
scripts/release.sh 0.2.0 "What changed"
```
It bumps the version (tauri.conf.json, Cargo.toml), commits "release v0.2.0", pushes the tag, waits
for the `native` workflow (the tag build adds `--config src-tauri/tauri.release.conf.json`, which
creates the signed updater bundles), downloads the desktop bundles, builds the signed Android APKs
here, writes `latest.json` + `android.json` and copies everything to
`https://fin.pr0h0.me/downloads/0.2.0/`. If a step fails after the tag was pushed, rerun with
`SKIP_TAG=1`.

Verified here: a signed AppImage built with the release config and the GitHub-secret key; the app
read a local feed, showed the update bar, downloaded the bundle and checked its signature (a feed
claiming another version than the signed one is refused). Not yet done: a real release through
GitHub, and installing an update on each OS. Apps installed before 0.2.0 have no updater: install
0.2.0 by hand once.

## Open items (native)

- Push notifications while the app is closed (FCM / APNs via the server's notification job).
- E2EE profile keys in the OS credential store too (today in the app's SQLite, like on the web in
  IndexedDB), and the bearer token on Android in the Android Keystore (a small Kotlin plugin; the
  keyring crate has no Android backend).
- Local MCP server for desktop (PLAN feature 131).
- Code signing of the Windows/macOS bundles (the auto-update signature is separate and done).
- Android: share a statement/receipt from another app into Finance Platform (share target).
- macOS: unsigned (ad-hoc signed) builds may ask for Keychain access again after every update (the
  item's access list is tied to the binary's signature); a Developer ID signature fixes it.
