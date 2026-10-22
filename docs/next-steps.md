# Next steps

Backend (Phase 1) and the web app (Phase 2) are built; `scripts/ci.sh` and `scripts/e2e.sh` (Chromium,
Firefox, WebKit) pass. Mobile (Phase 3), desktop/Tauri (Phase 4) and the local MCP server (131) are
DEFERRED_TO_PHASE. Automatic bank integrations (102) are deferred indefinitely.

Highest value next:
1. Server-side guard for end-to-end encrypted profiles: plaintext REST/MCP/job writes into an e2ee profile
   stall its clients' sync (they accept envelopes only). Only `POST /categories/defaults` refuses today.
2. Sync for `import_batches` / `imported_raw_records` made while connected (or route connected imports
   through `/imports`), and upload device-entered exchange rates.
3. Web inbox: offer the merchant's split template (REST inbox already returns `suggestion.splitTemplateId`;
   `merchantMatcher` from `@finplat/importer-sdk` gives the same on the client).
4. Remaining English outside JSX (toasts in `.ts` modules, option-label arrays, enum values such as account
   types, server-generated notification texts and server PDF/CSV labels).
5. A GitHub (or other) remote so `.github/workflows/ci.yml` actually runs; until then use `scripts/ci.sh`.
6. Raiffeisen BiH: other products/currencies once real samples exist (only the KM "IZVOD" layout is known).
