Backend (Phase 1) and the web app (Phase 2) are built; `scripts/ci.sh` and `scripts/e2e.sh` (Chromium,
Firefox, WebKit) pass. Native apps (Phases 3–4) started 2026-10-23: one Tauri 2 project (`apps/native`)
for Linux, Windows, macOS, Android and iOS. Linux and Android are built and smoke-tested on the Linux
server (docker, Xvfb, Android emulator), macOS and iOS (simulator) on a Mac; Windows builds on GitHub
Actions (`native` workflow) and waits for a Windows machine. **Start with docs/native/README.md** for native work. Automatic bank
integrations (102) are deferred indefinitely.

Native, in order:
1. Mac (2026-10-23): macOS app and iOS simulator build and pass the smoke test; `gen/apple` committed.
   Left: run the connected-mode test (`SERVER=… bun tests/native/apple-smoke.ts macos|ios`, docs/native/
   README.md), a real iPhone (free Personal Team, 7-day installs), tray/shortcut by hand, signing.
2. On Windows: install the `finplat-windows` artifact (or `bunx tauri dev`), tick the checklist.
3. Android on a real phone: `apps/native/dist/android/app-arm64-release.apk`, checklist (biometrics,
   camera, notifications, connected mode against fin.pr0h0.me).
4. Desktop items of PLAN still open: auto-update with signed releases (tauri-plugin-updater + an update
   feed, e.g. on the server), E2EE keys in the OS keychain (the token already is), scheduled automatic
   backups to a folder, local MCP bridge (131), close-to-tray.
5. Push notifications when the app is closed (FCM/APNs from the server's notification job).

Web/backend, highest value next:
1. Upload device-entered exchange rates (connected imports already reach the server: E2E
   `import-sync.spec.ts`).
2. Remaining English outside JSX (toasts in `.ts` modules, option-label arrays, enum values such as account
   types, server insights and error details).
3. Firefox E2E stalls under parallel load (see known-issues).
4. Raiffeisen BiH: other products/currencies once real samples exist (only the KM "IZVOD" layout is known).
