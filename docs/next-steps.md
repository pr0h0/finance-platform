# Next steps

Backend (Phase 1) and the web app (Phase 2) are built; `scripts/ci.sh` and `scripts/e2e.sh` (Chromium,
Firefox, WebKit) pass. Mobile (Phase 3), desktop/Tauri (Phase 4) and the local MCP server (131) are
DEFERRED_TO_PHASE. Automatic bank integrations (102) are deferred indefinitely.

Highest value next:
1. Sync for `import_batches` / `imported_raw_records` made while connected (or route connected imports
   through `/imports`), and upload device-entered exchange rates.
2. Remaining English outside JSX (toasts in `.ts` modules, option-label arrays, enum values such as account
   types, server insights and error details).
3. Firefox E2E stalls under parallel load (see known-issues).
4. Raiffeisen BiH: other products/currencies once real samples exist (only the KM "IZVOD" layout is known).
