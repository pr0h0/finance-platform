Backend (Phase 1) and the web app (Phase 2) are built; `scripts/ci.sh` and `scripts/e2e.sh` (Chromium,
Firefox, WebKit) pass. Native apps (Phases 3–4) started 2026-10-23: one Tauri 2 project (`apps/native`)
for Linux, Windows, macOS, Android and iOS. Linux and Android are built and smoke-tested on the Linux
server (docker, Xvfb, Android emulator), macOS and iOS (simulator) on a Mac; Windows builds on GitHub
Actions (`native` workflow) and waits for a Windows machine. **Start with docs/native/README.md** for native work. Automatic bank
integrations (102) are deferred indefinitely.

Native, in order:
1. Mac (2026-10-23): macOS app and iOS simulator build and pass the smoke test; `gen/apple` committed.
   Connected mode (Keychain) tested on both. Left: a real iPhone (free Personal Team, 7-day installs),
   tray/shortcut by hand, signing.
2. On Windows: install the `finplat-windows` artifact (or `bunx tauri dev`), tick the checklist.
3. Android on a real phone: `apps/native/dist/android/app-arm64-release.apk`, checklist (biometrics,
   camera, notifications, connected mode against fin.pr0h0.me).
4. First release through `scripts/release.sh 0.2.0` (auto-update is built: docs/native/README.md
   "Auto-update"), then install it by hand once on each device; later versions update themselves.
5. Desktop items of PLAN still open: local MCP bridge (131); Android Keystore for the token and E2EE
   keys. Done: close-to-tray, automatic backups to a folder, E2EE keys in the OS keychain.
6. Push notifications when the app is closed (FCM/APNs from the server's notification job).

Web/backend, highest value next:
1. Remaining English outside JSX (toasts in `.ts` modules, option-label arrays, enum values such as account
   types, server insights and error details).
2. Firefox E2E stalls under parallel load (see known-issues).
3. Raiffeisen BiH: other products/currencies once real samples exist (only the KM "IZVOD" layout is known).
