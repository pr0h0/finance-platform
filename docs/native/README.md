# Native apps (desktop + mobile)

One Tauri 2 project, `apps/native`, builds the Finance Platform app for **Linux, Windows, macOS,
Android and iOS** around the same React web app (`apps/web`). Read this file first when you continue
native work on another machine or in a new session: it says what is done, what was verified where,
and what is left per platform.

Last updated: 2026-10-23.

## Status per platform

| Platform | Builds | Verified | Where it was verified | Left to do |
|---|---|---|---|---|
| Linux | ✅ `.deb`, `.rpm`, `.AppImage` (docker: `scripts/native.sh linux build`; also GitHub Actions) | ✅ two automated smoke tests drive the real binary: local mode (`scripts/native-test.sh`) and connected mode against a real server (`scripts/native-test.sh linux-connected`) | this Linux server, Xvfb + WebDriver | a real desktop session: tray icon, global shortcut, OS notifications |
| Android | ✅ signed per-ABI `.apk` + `.aab` (docker: `scripts/native.sh android build`; GitHub Actions unsigned) | ✅ automated smoke test in an emulator (`scripts/native-test.sh android`): local mode, restart, back button | this Linux server, Android 15 emulator (KVM) | a real phone: biometrics, camera, notifications, connected mode (checklist) |
| Windows | ✅ `.msi` + setup `.exe` (GitHub Actions `native`, 2026-10-23) | ⬜ not run on Windows yet | — | install on Windows/VM, checklist below; code signing |
| macOS | ✅ universal `.dmg` (GitHub Actions `native`, 2026-10-23) | ⬜ not run on a Mac yet | — | checklist below; signing/notarization |
| iOS | ✅ simulator `.app` compiles (GitHub Actions `native`, 2026-10-23) | ⬜ not run in a simulator or on an iPhone yet | — | `tauri ios init` on a Mac (commit `gen/apple`), simulator + iPhone, checklist below |

✅ = done and checked, ⬜ = open. GitHub artifacts: Actions → **native** → the run → Artifacts
(`finplat-linux`, `finplat-windows`, `finplat-macos`, `finplat-android`, `finplat-ios-simulator`).
The workflow runs only on "Run workflow" or a `v*` tag (macOS minutes count 10× on a private repo).

✅ = done and checked, ⬜ = open.

## How it works

```
apps/web (React, unchanged pages)          apps/native/src-tauri (Rust)
  src/platform/native.ts  ── invoke ──▶    store.rs   SQLite: one file per local store
  src/platform/store.ts                    lib.rs     plugins, tray, global shortcut
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
  `device: {platform: linux|windows|macos|android|ios}` returns a **bearer token**, kept in the app
  settings (`connection.token`). Signing in again from the "session ended" banner registers a new
  device and replaces the token.
- **Not in the native app:** service worker / PWA update prompt (the app updates as a whole),
  Web Push (replaced by OS notifications, below), passkeys (WebAuthn is bound to the server's web
  origin; the native app signs in with the password).
- **Notifications.** "Browser notifications" on the Notifications page turns on OS notifications
  (`tauri-plugin-notification`, asks for permission). Local alerts (budget, bills) and new server
  notifications seen by the 60 s poll are shown as OS notifications while the app runs. There is no
  push when the app is closed (that needs APNs/FCM: open item).
- **Desktop extras:** tray icon (Open / Add transaction / Quit), global shortcut
  **Ctrl+Shift+E** (Cmd+Shift+E on macOS) opens quick entry from anywhere, single instance (a second
  launch focuses the running app). Links to other sites open in the system browser.
- **Mobile extras:** the app lock screen offers **fingerprint / Face ID** (tauri-plugin-biometric)
  when the device has it; the PIN stays the fallback. Biometrics only gate the UI, like the PIN.

## Repository layout

| Path | What |
|---|---|
| `apps/native/package.json` | `@finplat/native` workspace: Tauri CLI |
| `apps/native/src-tauri/tauri.conf.json` | app id `me.pr0h0.finplat`, window, bundle settings; builds `apps/web` first (`beforeBuildCommand`) |
| `apps/native/src-tauri/src/lib.rs` | plugins, tray, global shortcut, mobile entry point |
| `apps/native/src-tauri/src/store.rs` | SQLite persistence commands `store_load`, `store_commit`, `store_destroy` |
| `apps/native/src-tauri/capabilities/` | permissions: HTTP to any http(s) server, notifications, OS info, opener; biometric on mobile |
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
scripts/native.sh linux check      # quick cargo check after Rust changes
```

The smoke tests: the app runs inside Tauri with the native bridges, local onboarding, account with an
opening balance, dashboard; quits; the SQLite file exists; starts again and finds the account and
balance restored from SQLite. Connected: registers on the server through the native HTTP client,
signs in as a `linux` device (bearer token), adds an account, syncs; the test checks the server
side through the API; after a restart the app is still signed in with the data cached in SQLite. Install a bundle on a desktop: `sudo apt install ./Finance*.deb`, or run
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
```

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
2. `bun install`, then `cd apps/native && bunx tauri dev`.
3. Release: `bunx tauri build --target universal-apple-darwin` (needs
   `rustup target add aarch64-apple-darwin x86_64-apple-darwin`) → `.app` and `.dmg`.
   Unsigned builds open with right-click → Open the first time.

### iOS (needs a Mac with Xcode)

1. `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
2. `cd apps/native && bunx tauri ios init` (creates `src-tauri/gen/apple`; commit it).
3. Simulator: `bunx tauri ios dev` (pick a simulator).
4. Your iPhone: Xcode → Settings → Accounts → add your Apple ID (free "Personal Team"); on the
   iPhone Settings → Privacy & Security → Developer Mode on; connect by cable; then
   `bunx tauri ios dev --host` and pick the phone (Mac and phone on the same Wi-Fi), or
   `bunx tauri ios dev --open` and press Run in Xcode. First run: trust the developer on the phone
   (Settings → General → VPN & Device Management). Free-account installs expire after 7 days.
5. Release / TestFlight: Apple Developer Program ($99/year), set `bundle > iOS > developmentTeam`
   in `tauri.conf.json`, `bunx tauri ios build --export-method app-store-connect`.

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

## Releases and signing (open)

| Platform | Unsigned today | To sign |
|---|---|---|
| Windows | SmartScreen warning | Azure Trusted Signing (~$10/month) or a code-signing certificate; `bundle > windows > signCommand` |
| macOS | Gatekeeper warning | Apple Developer ID + notarization (`APPLE_*` env vars for `tauri build`) |
| iOS | simulator only | Apple Developer Program, TestFlight |
| Android | see Android section | keystore (see Android section); Play Store $25 once |
| Linux | none needed | optional: sign the AppImage / host an apt repo |

Updates: `tauri-plugin-updater` with GitHub Releases is the planned path (not added yet).

## Open items (native)

- Push notifications while the app is closed (FCM / APNs via the server's notification job).
- Secure storage of the bearer token and E2EE keys in the OS keychain (Keychain, Credential
  Manager, Secret Service, Android Keystore). Today they sit in the app's private data directory
  (WebView storage / SQLite), protected by the OS sandbox and the app lock, not by the keychain.
- Local MCP server for desktop (PLAN feature 131).
- Auto-update (tauri-plugin-updater) and signed release pipeline.
- Desktop: close-to-tray option, start at login.
- Android: share a statement/receipt from another app into Finance Platform (share target).
- iOS: safe-area insets (notch / home indicator) come from `viewport-fit=cover` + CSS `env()`:
  header and onboarding pad by `safe-area-inset-top`, the bottom navigation by
  `safe-area-inset-bottom`. Not seen on an iPhone yet: check the header, dialogs and the mobile
  menu drawer on a simulator with a notch.
