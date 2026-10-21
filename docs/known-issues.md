# Known issues and limitations

- **Phase 0 only**: all API modules are registered but have no routes yet (they return the JSON 404
  `route_not_found`). `auth.Middleware` does not populate a principal yet, so authenticated endpoints will
  return 401 until the auth module lands.
- Raiffeisen Bank BiH importer: BLOCKED_EXTERNAL (no statement sample).
- Mobile (Phase 3) and desktop/Tauri (Phase 4) not started: DEFERRED_TO_PHASE.
- `docs/api/openapi.yaml` is hand-maintained; TS types in `packages/domain` are not generated from it, so
  drift is possible until a CI check is added.
- OpenAPI lint warnings: operations use a `default` error response instead of explicit 4xx entries; tags lack
  descriptions.
- CI workflow has not yet been executed on GitHub.
- Dev compose `down -v` also removes the shared `finplat_gomod/gobuild/bun` cache volumes (harmless, just
  slower next run). Use `down` without `-v`; reset the dev DB with `docker volume rm finplat-dev_pgdata`.
- `middleware.RealIP` trusts `X-Forwarded-For`; safe only because the API container is reachable solely
  through the gateway (no published port in prod). Do not publish the API port in prod.

## Importers (packages/importer-sdk, packages/bank-importers)
- OCR importer (`generic-ocr`, tesseract.js) is implemented but not covered by automated tests: it needs
  language data from the network and raster input. Scanned PDFs can only be rasterised in a browser.
  Results are always low-confidence and flagged `requiresApproval`.
- XML (CAMT/OFX), JSON, XLSX/XLS and PDF are parsed whole-file (capped by `maxBytes`); only CSV/TSV/QIF/MT940 stream.
- PDF text import rebuilds rows from text positions; multi-line descriptions keep only their first line.
- QIF: day/month order is inferred per file; all-ambiguous files assume MM/DD (DD.MM for dot dates) with a warning. QIF splits are kept raw only.
- MT940 `:86:` is used verbatim; bank-specific sub-field parsing (`?20`, `/REMI/` …) is not done.
- CAMT batched entries (several TxDtls) become one record for the entry total.
- Web app must call `setPdfWorkerSrc()` (bundled pdf.worker URL) before PDF import in the browser.
- fp1 fingerprint must be implemented identically in Go (docs/importing/fingerprint.md, vectors in
  packages/test-fixtures/imports/fingerprint.json); TS side passes the vectors.

## Shared TS engine (packages/finance-engine, forecasting)
- Go conformance runner (`apps/api/internal/conformance_test`) runs recurrence, subscriptions and fx_lookup;
  aggregation, budgets and forecast fixtures are skipped until the Go modules export pure functions over
  in-memory data.
- `analytics/fin.Converter` lets a provider EUR/BAM quote newer than the seeded 1999 fixed row override the
  1.95583 parity (violates invariant 5); `exchangerates.Lookup` is correct. The 3 cases are skipped by name in
  the Go runner (`finConverterDivergence`) — remove them once fixed.
- Rule regexes run on the JS engine; only the RE2-compatible subset is guaranteed to behave like Go. Patterns
  are capped at 256 chars (no other ReDoS protection on the client).
- Budget `utilization` is `null` when the limit is <= 0 (OpenAPI `BudgetStatus` types it as non-null Decimal).
- Annualization uses the documented approximations of Go `recurrence.PerYear` (365-day year, 52 weeks,
  4 per month for an un-ordinaled weekday in a monthly rule).
- Forecast converts foreign balances at the start-date rate for the whole horizon (constant-rate assumption,
  listed in `assumptions`).

## Ledger core (accounts, ledger, transactions, categories, merchants, currency, exchangerates, attachments)
- Attachment links are synced through the `attachments` entity; a transaction's `attachmentIds` in its sync
  snapshot is only refreshed when the transaction itself changes (clients should derive links from attachments).
- Attachments: only `STORAGE_BACKEND=local` (S3 returns 501); no server-side encryption or virus scan; HEIC/HEIF
  and office documents are rejected by the sniffing allowlist. A crash between file rename and commit can leave
  an orphan file (never referenced, never served).
- Transaction "archiving" is the `void` status (kept, excluded from balances) — there is no separate archive flag.
- Reconciliation computes the difference and optionally books an `adjustment`; it does not mark individual
  transactions `reconciled` and keeps no reconciliation history table (the audit log has each run).
- Cross rates via EUR are rounded once to 18 fraction digits before the single money rounding.
- Provider refresh runs in-process (goroutine started by `exchangerates.Register` when JOBS_ENABLED); only the
  Frankfurter/ECB wire format is implemented. On-demand historical fetches are throttled per provider/date for
  10 minutes per process. Balances/net worth use cached snapshots only (no network on that read path).
- List endpoints of simple entities (tags, templates, categories, merchants, accounts) page with an offset cursor.
- Undo applies the previous audit snapshot of a transaction; it cannot undo changes to imported evidence
  (refused, as any edit would be) and only covers the transaction itself, not linked fee/refund transactions.
