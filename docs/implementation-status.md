# Implementation status

Tracks all 145 features of PLAN.md. Update the row in the same commit as the work.

Statuses: `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED` (code exists, not fully verified),
`TESTED` (automated tests pass + functionally verified), `BLOCKED_EXTERNAL`, `DEFERRED_TO_PHASE`.
DEFERRED_TO_PHASE is **not** complete. Phase numbers follow PLAN §3 (1 backend, 2 web, 3 mobile, 4 desktop).

Current target: backend + web (Phases 1–2). Mobile (3) and desktop (4) are deferred.

## Foundation (Phase 0)

| Item | Status | Tests |
|---|---|---|
| Monorepo, Bun workspaces, 15 packages | TESTED | `scripts/bun.sh test packages apps/web/src` |
| Go API skeleton, module layout, config, logging redaction, error format | TESTED | `scripts/go.sh test ./...` |
| PostgreSQL schema (all PLAN §6 entities), goose migrations | TESTED | migrations apply on startup; trigger tests in internal/changes |
| Sync change log + audit helper (`internal/changes`) | TESTED | internal/changes tests (DB) |
| Profile authorization helper (`internal/authz`) | TESTED | internal/authz tests (DB) |
| Auth: Argon2id, cookie sessions + CSRF, bearer device tokens, sessions, recovery codes, rate limits, registration policies | TESTED | `internal/auth/auth_test.go` (CSRF, IDOR, revocation, recovery, rate limit) |
| Idempotency-Key middleware | TESTED | internal/httpx tests (DB) |
| Money engine TS + Go, conformance fixtures | TESTED | both runners pass packages/test-fixtures/conformance |
| OpenAPI 3.1 contract | IMPLEMENTED | redocly lint: valid |
| Docker (dev + prod-like), gateway on 127.0.0.1:3810 | TESTED | health/meta via gateway, Chromium render check |
| CI workflow | IMPLEMENTED | not yet run on GitHub |

## Shared TS engine (web local mode) — packages/finance-engine, forecasting, currency, charts

Engine-level only; each feature row below stays owned by its API/web module.

| Area (features) | Status | Tests | Notes |
|---|---|---|---|
| Balances, balance history, net worth (49, 52, 61) | TESTED | finance-engine `critical-cases`, `engine`, conformance `aggregation.json` | |
| Aggregations: category (+parent rollup), merchant, income vs expense, savings rate (54–59) | TESTED | conformance `aggregation.json`; §46 cases 3–7 | Go runner pending (no pure Go aggregation exported) |
| FX valuation, historical rates, EUR/BAM parity, converter, exposure (16–20, 23, 24) | TESTED | conformance `fx_lookup.json` (TS + Go `exchangerates.Lookup`); currency tests | `fin.Converter` diverges on EUR/BAM, see known-issues |
| Recurrence expansion, annualization, installments, plan occurrences, matching (26–29, 33, 34, 37, 38) | TESTED | conformance `recurrence.json`, `subscriptions.json` (TS + Go pass); §46 cases 11, 13 | |
| Budget periods, utilization, rollover, alerts, actual vs planned (39–45) | TESTED | conformance `budgets.json`; §46 case 10 | Go runner pending |
| Forecast (daily, expected/conservative/optimistic), shortfalls, safe-to-spend, what-if, goals, emergency fund (66–75) | TESTED | conformance `forecast.json`; forecasting tests; §46 case 12 | Go runner pending |
| Rules, history suggestions, duplicates, recurring detection (76–78, 80) | TESTED | finance-engine `engine.test.ts` | no shared fixture yet |
| Insights + unusual expenses (64, 65) | TESTED | finance-engine `engine.test.ts` | no shared fixture yet |
| Chart data helpers | TESTED | charts tests | |
| Performance: 50k transactions, 2-year forecast over 200 plans | TESTED | `engine.test.ts`, `forecast.test.ts` (< 5 s each, ~1 s observed) | |

## Features

| # | Name | Platforms | Phase | Status | Backend module / package | Tests | Notes / limitations |
|---|---|---|---|---|---|---|---|
| 1 | Expense tracking | API, Web | 1-2 | TESTED (API) | ledger, transactions, accounts, categories, merchants | `internal/transactions/api_test.go` TestCriticalExpenseIncome…, TestEditUndo… | API: create/edit (manual amounts re-post immutable postings)/duplicate/void/delete/undo, audited corrections (`/transactions/{id}/adjustments`). Transaction 'archiving' = status `void` (kept, excluded from balances). Web UI by web agent. |
| 2 | Income tracking | API, Web | 1-2 | TESTED (API) | ledger, transactions | `internal/transactions/api_test.go` TestCriticalExpenseIncome… | API: income kind, income categories; refunds are a separate kind (not income), transfers never income. |
| 3 | Multiple accounts | API, Web | 1-2 | TESTED (API) | accounts, ledger | `internal/transactions/api_test.go` (all) | API: 11 account types (asset/liability), per-account currency, opening balance on create, archive; delete refused once the account has transactions; balance + daily balance history from postings. |
| 4 | Transfers between accounts | API, Web | 1-2 | TESTED (API) | transactions, ledger, exchangerates | `internal/transactions/api_test.go` TestCriticalExpenseIncome…, TestCriticalFX… | API: two-posting transfers; different currencies -> `fx` with currency_conversions (bank-actual amount or rate snapshot of the booking date); fee recorded as linked expense. |
| 5 | Transaction categories | API, Web | 1-2 | TESTED (API) | categories | `internal/transactions/api_test.go` TestAuthorizationAndHierarchy | API: CRUD with kind/color/icon, archive, starter set `POST /categories/defaults` (`categories.SeedDefaults`). Deleted categories stay referenced by historical splits. |
| 6 | Subcategories | API, Web | 1-2 | TESTED (API) | categories, transactions | `internal/transactions/api_test.go` TestCriticalSplitsAndRefunds, TestAuthorizationAndHierarchy | API: parent/child up to depth 5, cycle check, delete refused while children exist; filtering by a parent includes subcategories. |
| 7 | Custom tags | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestEditUndo… | API: tag CRUD (case-insensitive unique), tagIds on transactions, bulk add/remove, filter by tag. |
| 8 | Split transactions | API, Web | 1-2 | TESTED (API) | ledger, transactions | `internal/transactions/api_test.go` TestCriticalSplitsAndRefunds | API: up to 500 splits per transaction, exact sum enforced in ledger.validate (every write path), PUT replace keeps existing split ids (reorder/recategorize), split templates (fixed amounts + weighted remainder, largest remainder). |
| 9 | Transaction attachments | API, Web | 1-2 | TESTED (API) | attachments | `internal/transactions/api_test.go` TestAttachments, attachments/filename_test.go | API: multipart upload to ATTACHMENTS_DIR/<profile>/<id> (path from UUIDs only), content-sniffed allowlist (JPEG/PNG/GIF/WebP/PDF/text), size limit, sha256, download with nosniff + sandbox CSP + attachment disposition, link/unlink, delete removes content. STORAGE_BACKEND=s3 not implemented (501). HEIC not accepted. |
| 10 | Transaction search and filtering | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestEditUndo…, TestCriticalSplits… | API: from/to, account(s), category (incl. children), merchant, tag, kind, status, source (import source), currency, text (description/notes/payee/reference/merchant/raw bank text, ILIKE), amount range (magnitude), uncategorized, related; keyset cursor (bookingDate desc, id). |
| 11 | Quick expense entry | API, Web | 1-2 | IMPLEMENTED (API) | transactions | covered by create tests | API: minimal create needs kind, accountId, amount, bookingDate (single split from categoryId). 'Remember recent selections' is a web concern. |
| 12 | Transaction templates | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestAuthorizationAndHierarchy, TestCriticalSplitsAndRefunds | API: transaction templates CRUD (kind, accounts, amount, category, merchant, tags) + split templates (applied via PUT splits `splitTemplateId`). One-click reuse = client prefill + POST /transactions. |
| 13 | Refunds and reimbursements | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestCriticalSplitsAndRefunds | API: `POST /transactions/{id}/refunds` (partial, capped at the original total, proportional category allocation or explicit splits); reimbursements use the same refund kind with payee. |
| 14 | Transaction import | API, Web | 1-2 | IN_PROGRESS | transactions, accounts, categories, attachments, imports | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Client side: importer framework + 13 format importers in packages/importer-sdk + bank-importers (TESTED). API staging/commit and web UI owned by imports/web agents. |
| 15 | Transaction export | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestEditUndo… | API: `GET /transactions/export?format=csv|json` with all search filters; CSV one row per split, BOM, formula-injection escaping for text cells. No XLSX (CSV is the spreadsheet format). |
| 16 | Multiple currencies | API, Web | 1-2 | TESTED (API) | currency, money | `internal/transactions/api_test.go` TestCriticalFX… | API: ISO 4217 table (`GET /currencies`), scale-exact money in Go. |
| 17 | Primary reporting currency | API, Web | 1-2 | IMPLEMENTED (API) | ledger | TestCriticalFX… (balances?currency=) | API: `GET /balances?currency=` values in any currency (default profile base_currency); original amounts never rewritten. Changing base currency is the profiles module. |
| 18 | Automatic conversion | API, Web | 1-2 | TESTED (API) | exchangerates, currency, ledger | `internal/transactions/api_test.go` TestCriticalFX… | API: conversion with snapshot rates (direct, inverse, cross via EUR), single rounding (half_up default). |
| 19 | Historical rates | API, Web | 1-2 | TESTED (API) | exchangerates | `internal/transactions/api_test.go` TestCriticalFX…, conformance_test TestFXLookup | Valuation policy: latest snapshot on/before the date; fixed EUR/BAM always current; same date manual > fixed > provider. Snapshots never updated in place; used rates cannot be deleted; recorded fx keep their rate. |
| 20 | Manual override | API, Web | 1-2 | TESTED (API) | exchangerates, transactions | `internal/transactions/api_test.go` TestCriticalFX… | API: profile manual rates (`POST/DELETE /exchange-rates`) and per-transaction actual settlement amount (`toAmount` -> method bank_actual). |
| 21 | Multi-currency accounts | API, Web | 1-2 | TESTED (API) | accounts, ledger | TestCriticalFX… | API: accounts in any currency; `isMultiCurrency` accounts hold postings in several currencies (balances per currency). |
| 22 | Currency fees | API, Web | 1-2 | TESTED (API) | transactions | `internal/transactions/api_test.go` TestCriticalFX… | API: transfer/fx `fee` -> separate expense (feeCategoryId) linked by relatedTransactionId + currency_conversions.fee_amount; implied bank rate stored for bank_actual conversions (markup vs reference rate derivable). |
| 23 | Built-in converter | API, Web | 1-2 | TESTED (API) | currency | `internal/transactions/api_test.go` TestCriticalFX… | API: `POST /convert` (date or explicit rate, rounding mode, stale flag). 'Result becomes planned expense' is client + planning. |
| 24 | Currency analytics | API, Web | 1-2 | NOT_STARTED | currency, exchangerates | — |  |
| 25 | Exchange-rate updates | API, Web | 1-2 | TESTED (API) | exchangerates | `internal/transactions/api_test.go` TestExchangeRateProviderFetchAndOfflineFallback | API: Frankfurter/ECB http provider (`ecb`, migration 20261021123417), periodic refresh (JOBS_ENABLED, FX_REFRESH_INTERVAL), on-demand historical fetch, DB cache, offline fallback (`stale: true`), admin refresh, json.Number parsing (no floats). |
| 26 | Planned expenses | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 27 | Recurring expenses | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 28 | Recurring income | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 29 | Subscription manager | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 30 | Bill calendar | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 31 | Payment reminders | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 32 | Planned versus actual | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 33 | Planned transaction matching | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 34 | Flexible recurrence | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 35 | Expense priorities | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 36 | Confidence levels | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 37 | Installment payments | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 38 | Annual planning | API, Web | 1-2 | NOT_STARTED | planning, recurrence | — |  |
| 39 | Category budgets | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 40 | Monthly budgets | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 41 | Custom budget periods | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 42 | Rollover | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 43 | Budget alerts | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 44 | Actual versus budget | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 45 | Planned spending consideration | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 46 | Budget templates | API, Web | 1-2 | NOT_STARTED | budgets | — |  |
| 47 | Financial overview | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 48 | Customizable widgets | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 49 | Current balance | API, Web | 1-2 | TESTED (API) | ledger | `internal/transactions/api_test.go` TestCriticalExpenseIncome… | API: `GET /balances?accountId=&asOf=` per account/currency + converted values. Dashboard widget by web agent. |
| 50 | Upcoming expenses | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 51 | Monthly summary | API, Web | 1-2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 52 | Account breakdown | API, Web | 1-2 | TESTED (API) | ledger, accounts | `internal/transactions/api_test.go` TestCriticalExpenseIncome… | API: per-account balances with converted value and classification (share = converted / assets, computed client-side). |
| 53 | Quick actions | Web (+API) | 2 | NOT_STARTED | analytics (web dashboard) | — |  |
| 54 | Spending by category | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 55 | Income versus expenses | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 56 | Spending trends | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 57 | Period comparisons | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 58 | Merchant analytics | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 59 | Savings rate | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 60 | Recurring cost analysis | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 61 | Net worth | API, Web | 1-2 | IN_PROGRESS | ledger (balance parts), analytics | TestCriticalExpenseIncome… (netWorth/assets/liabilities) | Balance parts done in API: netWorth/assets/liabilities on `/balances` (accounts flagged includeInNetWorth; null + missingRates when a rate is missing). Net-worth history/analytics belongs to analytics. |
| 62 | Financial reports | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 63 | Report export | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 64 | Automated financial insights | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 65 | Unusual expense detection | API, Web | 1-2 | NOT_STARTED | analytics | — |  |
| 66 | Future balance forecasting | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 67 | Daily cash flow | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 68 | Safe-to-spend | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 69 | What-if scenarios | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 70 | Optimistic and conservative forecasts | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 71 | Long-term projections | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 72 | Savings goals | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 73 | Goal contributions | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 74 | Goal completion estimates | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 75 | Emergency fund tracking | API, Web | 1-2 | NOT_STARTED | forecasting, savings | — |  |
| 76 | Categorization rules | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 77 | Transaction suggestions | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 78 | Duplicate detection | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 79 | Receipt scanning | API, Web | 1-2 | NOT_STARTED | automation, transactions | — | Web: upload/camera capture + user-verified breakdown. Native camera flows Phase 3. |
| 80 | Recurring payment detection | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 81 | Smart notifications | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 82 | Global shortcuts | API, Web | 1-2 | NOT_STARTED | automation, transactions | — | Web: in-app keyboard shortcuts. OS-global shortcuts are desktop (Phase 4). |
| 83 | Bulk editing | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 84 | Undo and history | API, Web | 1-2 | NOT_STARTED | automation, transactions | — |  |
| 85 | Local-first storage | API, Web | 1-2 | IN_PROGRESS (API done) | web storage, sync, backups, auth, households | `internal/auth/*_test.go` TestSyncInterruptedRecovery | API: server side of local-first is the sync log (push/pull/snapshot) so clients can work offline and reconcile later. Client local storage is the web agent's part. |
| 86 | Offline mode | API, Web | 1-2 | IN_PROGRESS (API done) | web storage, sync | `internal/auth/*_test.go` TestSyncInterruptedRecovery, TestSyncConcurrentEditsMergeOrConflict | API: offline ops pushed later with client ids + opIds (idempotent), stale-base edits merged or turned into conflicts. Client offline queue: web agent. |
| 87 | Optional cloud synchronization | API, Web | 1-2 | TESTED (API) | sync, auth, devices | `internal/auth/*_test.go` TestSync* | API: `/sync/push` (≤500 ops, idempotent by opId, savepoint per op), `/sync/pull` (cursor, durable per-device checkpoint), `/sync/snapshot` (paged current state), `/sync/status`, `/sync/conflicts` + resolve (server/client/merged). Entities become pushable via `sync.RegisterEntity` (owning modules must register; unregistered types → `unsupported_entity`). |
| 88 | End-to-end encryption | API, Web | 1-2 | IN_PROGRESS (API done) | sync (encrypted_records, key envelopes) | `internal/auth/*_test.go` TestSyncE2EEAcrossDevices (XChaCha20-Poly1305 + sealed-box key wrap across two devices) | API: e2ee profiles store only validated ciphertext envelopes (`encrypted_records`), stale updates always conflict, wrapped keys via `/sync/keys`, device revocation revokes envelopes. Client-side libsodium crypto + key rotation: not built yet. Switching an existing profile's privacy mode is refused once it has data. |
| 89 | Automatic backups | API, Web | 1-2 | IN_PROGRESS (API done) | backups | `internal/auth/*_test.go` TestScheduledBackups, TestBackupExportRestore | API: manual + scheduled server backups (BACKUP_SCHEDULE, retention, advisory lock), AES-256-GCM at rest with BACKUP_ENCRYPTION_KEY (alg "none" recorded when unset). Local (client) backups: web agent. |
| 90 | Backup restoration | API, Web | 1-2 | TESTED (API) | backups | `internal/auth/*_test.go` TestBackupExportRestore | API: restore from uploaded backup/export into a new profile or an empty owned profile (pre-restore backup), all ids remapped, sync log rebuilt. E2EE exports are restored client-side (409 server-side). |
| 91 | Application lock | API, Web | 1-2 | NOT_STARTED | web storage, sync, backups, auth, households | — | Web: PIN/passphrase lock. Biometric lock is mobile/desktop (Phase 3/4). |
| 92 | Financial profiles | API, Web | 1-2 | TESTED (API) | profiles | `internal/auth/*_test.go` TestProfilesCRUDAndValidation, TestObjectLevelAuthorization | API: CRUD (client-chosen id allowed), roles owner/editor/viewer, members, profile settings, soft delete; default "Personal" profile at registration. |
| 93 | Household sharing | API, Web | 1-2 | TESTED (API) | households, profiles | `internal/auth/*_test.go` TestHouseholdSharing | API: households, roles owner/admin/member/viewer, email-bound single-use invite tokens (7 days, no SMTP), profiles shareable only with household members, leaving/removal ends shared-profile access, last-owner protection. |
| 94 | Data portability | API, Web | 1-2 | TESTED (API) | backups | `internal/auth/*_test.go` TestBackupExportRestore | API: `GET /export` open JSON format documented in docs/api/export-format.md (all profile tables + snapshots). Attachment file contents not included. |
| 95 | macOS | macOS desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop is developed later on macOS hardware. |
| 96 | Windows | Windows desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop is developed later on Windows hardware. |
| 97 | Linux | Linux desktop (Tauri) | 4 | DEFERRED_TO_PHASE | platform | — | Desktop deferred; architecture (storage abstraction, mcp-contracts) kept compatible. |
| 98 | Web | API, Web | 1-2 | NOT_STARTED | platform | — | Phase 0 shell only (server status page). |
| 99 | Mobile | Android, iOS | 3 | DEFERRED_TO_PHASE | platform | — | Mobile is Phase 3. |
| 100 | Cross-platform synchronization | API, Web | 1-2 | IN_PROGRESS (API done) | sync | `internal/auth/*_test.go` TestSync* | API: deterministic op-log sync with per-profile server_version, device identity, tombstones, conflict records; mobile/desktop clients deferred. |
| 101 | Bank statement import | API, Web | 1-2 | IN_PROGRESS | platform | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Client side parsers TESTED (CSV/TSV/XLSX/XLS/OFX/QFX/QIF/CAMT.053/054/MT940/JSON/text PDF; OCR optional, untested). See docs/importing/formats.md. |
| 102 | Optional bank integrations | API, Web | 1-2 | NOT_STARTED | platform | — |  |
| 103 | Themes | Web | 2 | NOT_STARTED | platform | — |  |
| 104 | Localization | API, Web | 1-2 | NOT_STARTED | platform | — | Phase 0: packages/localization skeleton (en catalog, fallback). |
| 105 | Accessibility | Web | 2 | NOT_STARTED | platform | — |  |
| 106 | First-launch mode selection | Web (+API) | 2 | NOT_STARTED | web, sync, api-client | — |  |
| 107 | Custom backend URL | API, Web | 1-2 | NOT_STARTED | web, sync, api-client | — |  |
| 108 | Synchronization dashboard | Web (+API) | 2 | IN_PROGRESS (API done) | sync | `internal/auth/*_test.go` TestSyncInterruptedRecovery | API: `/sync/status` (head, own devices' checkpoints/last push, open conflicts, storage bytes), `/devices`. Dashboard UI: web agent. |
| 109 | Server migration | API, Web | 1-2 | IN_PROGRESS (API done) | backups | `internal/auth/*_test.go` TestBackupExportRestore | API: export on old server + restore on new server with id remapping; flow in docs/api/export-format.md. Client "change server" UI: web agent. |
| 110 | Bank importer registry | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | TS `ImporterRegistry` + `createRegistry()` (detect ranking, sdkVersion/semver checks, blocked importers refused) TESTED. API /importers by imports module. |
| 111 | Custom bank templates | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Declarative template schema v1 (zod, data only, no code/regex) + engine TESTED; docs/importing/templates.md. |
| 112 | Code-based bank adapters | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | `BankImporter` contract, `ResultBuilder`, banks/<id>/ adapter slot; bundled-only (no runtime code loading). Contributor guide docs/importing/README.md. |
| 113 | Import preview | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Client helpers: totals(), per-row errors/warnings/confidence, readTablePreview(). Preview UI not in this package. |
| 114 | Import history and rollback | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 115 | Import deduplication | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | fp1 fingerprint (docs/importing/fingerprint.md, shared vectors packages/test-fixtures/imports/fingerprint.json) + matchExisting() TESTED in TS; Go side must pass the same vectors. |
| 116 | Account reconciliation | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | checkStatementBalance(), checkRunningBalances() exact minor-unit arithmetic TESTED (client side). |
| 117 | Mapping editor | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Client helpers readTablePreview() + suggestTemplate() + validateTemplate() TESTED; editor UI by web agent. |
| 118 | Community templates | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Contribution/testing procedure documented (docs/importing/README.md); example synthetic templates in packages/test-fixtures/imports/templates/. |
| 119 | Device management | API, Web | 1-2 | TESTED (API) | sync (devices), auth | `internal/auth/*_test.go` TestDeviceRevocationEndsSessions, TestSyncE2EEAcrossDevices | API: enroll (login with device or POST /devices, optional X25519 public key), rename, revoke (ends its sessions, revokes its key envelopes); push/pull require an active device of the caller. |
| 120 | Self-hosted administration | API, Web | 1-2 | TESTED (API) | admin, audit, auth | `internal/auth/*_test.go` TestAuditAndAdmin, TestRegistrationPolicies | API: `/admin/settings` (runtime registration policy; env-only settings rejected), `/admin/users` (list/create/disable/promote; disabling revokes sessions; no self-lockout), `/admin/stats` (counts, DB/backup/attachment bytes), `/admin/diagnostics`, `/admin/audit`, profile `/audit`. |
| 121 | Raiffeisen Bank BiH integration | API, Web | 1 | BLOCKED_EXTERNAL | imports, importer-sdk, bank-importers | — | Needs a real (sanitized) Raiffeisen BiH statement. Only the plug-in slot exists: packages/bank-importers/src/banks/raiffeisen-bih (README + manifest, detect=0, parse throws importer_blocked; tested). |
| 122 | Historical import | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Parsers stream line formats (CSV/TSV/QIF/MT940) via Web Streams; whole-file formats capped by maxBytes. No date restriction. |
| 123 | Editable imported records | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 124 | Unlimited category splitting | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — | Phase 0: split invariant + allocation (largest remainder) in engine. |
| 125 | Merchant-specific templates | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 126 | Uncategorized inbox | API, Web | 1-2 | NOT_STARTED | imports, importer-sdk, bank-importers | — |  |
| 127 | Historical completeness | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | coverageSources/computeCoverage/monthlyCoverage (complete/partial/missing/unverified/conflicting) TESTED client side. |
| 128 | Immutable source preservation | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Phase 0: imported_raw_records with DB immutability trigger. NormalizedRecord.raw keeps every source field as read + rowNumber + importer id/version. |
| 129 | Opening balance reconstruction | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | checkRunningBalances() derives opening balance from printed balances; statement opening/closing from CAMT/MT940/JSON. |
| 130 | Import reprocessing | API, Web | 1-2 | IN_PROGRESS | imports, importer-sdk, bank-importers | `scripts/bun.sh test packages/importer-sdk packages/bank-importers` (client) | Every importer has a semver version stored per result; fingerprints are parser-version independent so reprocessing can re-match. Reprocess flow itself is API/web. |
| 131 | Local MCP server | Desktop | 4 | DEFERRED_TO_PHASE | mcp, mcp-contracts | — | Native local MCP server ships with desktop; contracts in packages/mcp-contracts. |
| 132 | Remote MCP endpoint | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 133 | Per-client authorization | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 134 | Read-only queries | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 135 | Granular write access | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 136 | Categorization tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 137 | Split tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 138 | Budget and planning tools | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 139 | Cash-flow simulation | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 140 | AI financial analysis | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 141 | Proposed changes and approvals | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 142 | Audit history | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 143 | Client management | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 144 | Data scope restrictions | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — |  |
| 145 | MCP documentation | API, Web | 1-2 | NOT_STARTED | mcp, mcp-contracts | — | Phase 0: packages/mcp-contracts tool schemas. |
