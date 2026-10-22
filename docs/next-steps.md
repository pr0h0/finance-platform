# Next steps

Backend (Phase 1) and the web app (Phase 2) are built and pass the integration checks listed at the end of
`implementation-status.md`. Mobile (Phase 3) and desktop/Tauri (Phase 4) are DEFERRED_TO_PHASE.

Highest value next:
1. Sync for `import_batches`, `imported_raw_records` and `attachments` (or route connected-mode imports and
   attachments through the server APIs), and upload device-entered exchange rates.
2. Browser-test the remaining flows: local → connected activation, E2EE activation/unlock/rotation, households
   with two users, admin pages, MCP proposal approval, app lock (`tests/e2e`).
3. Accessibility audit (axe) in the E2E suite; Firefox/WebKit projects.
4. Go runners for the `budgets`, `forecast` and `aggregation` conformance fixtures; fix the
   `analytics/fin.Converter` EUR/BAM divergence (known-issues).
5. Raiffeisen BiH importer once a real statement format is available (BLOCKED_EXTERNAL).
6. Email/push notifications (SMTP settings exist, delivery is not built).
