# Known issues and limitations

- Mobile (Phase 3) and desktop/Tauri (Phase 4) not started: DEFERRED_TO_PHASE.
- (fixed) `docs/api/openapi.yaml` stays hand-maintained but cannot drift silently: `TestOpenAPICoversEveryRoute`
  (apps/api/internal/server) walks the chi router and fails on undocumented or stale operations, and
  `bun run api:check` fails when `packages/api-client/src/schema.gen.ts` (openapi-typescript) is stale.
  `packages/domain` types are still hand-written next to the generated ones.
- (fixed) redocly lint (2.67.1) has no warnings: explicit 4xx responses and tag descriptions. One documented
  exception in `.redocly.lint-ignore.yaml`: `/oauth/authorize` has no 2xx (it only redirects).
- (fixed) `.github/workflows/ci.yml` runs on GitHub (private repo `pr0h0/finance-platform`); `scripts/ci.sh` runs the same
  steps locally in docker (gofmt, vet, `go test -race` on the dev postgres, bun install/typecheck/lint/test,
  generated-types check, redocly lint, web build, the three image builds).
- Dev compose `down -v` also removes the shared `finplat_gomod/gobuild/bun` cache volumes (harmless, just
  slower next run). Use `down` without `-v`; reset the dev DB with `docker volume rm finplat-dev_pgdata`.
- (fixed) Client IP: the API trusts only `X-Real-IP` (httpx.RealIP), which the gateway overwrites with
  Cloudflare's `CF-Connecting-IP` (or the TCP peer) and it clears `True-Client-IP`; spoofed headers no longer
  bypass the per-IP auth limit. Anyone on the host itself can reach 127.0.0.1:3810 and set `CF-Connecting-IP`
  (host-local trust). Do not publish the API port in prod.
- (fixed) A fresh public server no longer hands the admin account to the first visitor: with
  `REGISTRATION_POLICY=first_user` the first registration needs `SETUP_TOKEN` (generated and logged at
  startup in production when unset; the live instance has it in `.env`).
- E2E (`scripts/e2e.sh`) runs against an isolated `finplat-e2e` compose project (fresh DB, no host ports,
  removed afterwards), never against the public instance. It rebuilds the shared `finplat-*:latest` image
  tags; the running prod containers keep their image until they are recreated.

## Importers (packages/importer-sdk, packages/bank-importers)
- OCR (`generic-ocr` importer and receipt scanning) is self-hosted: the web build copies the tesseract.js
  worker, LSTM wasm cores and eng/bos/hrv language data to /tesseract/ (~10 MB, loaded on first use, not
  precached); nothing is fetched from a CDN. Receipt OCR is covered by the Playwright connected spec; the
  statement OCR importer itself has no automated test. Scanned PDFs can only be rasterised in a browser.
  Results are always low-confidence and flagged `requiresApproval`.
- Receipt scanning extracts total, date and payee only (no line items); values are suggestions the user must
  tick. Other languages than eng/bos/hrv need their traineddata added to vite.config.ts.
- Optional bank integrations (feature 102) are not built: they need a chosen PSD2/aggregator provider and
  credentials, which this project does not have.
- The hosted web app talks only to its own server (CSP `connect-src 'self'` + SameSite session cookie);
  entering another server address offers a link to that server's own web app. Connecting one client to
  arbitrary servers is for the desktop/mobile apps (Phase 3/4).
- JSON, XLSX/XLS and PDF are parsed whole-file (capped by `maxBytes`); CSV/TSV/QIF/MT940 stream, CAMT/OFX are tokenized as a stream (one entry in memory) but keep the `maxBytes` cap.
- Custom code adapters (Feature 112): QuickJS checks its CPU deadline between bytecode steps and inside the regex engine (catastrophic backtracking is stopped, test in sandbox.test.ts); a single huge native call (e.g. `new Array(1e8).fill()`) can still overrun it until the heap limit or, in the web app, the worker watchdog (3x timeout + 5 s, worker terminated) stops it. Non-web callers of `runInSandbox` have no host-side wall clock. Adapters are per device (localStorage); clearing site data deletes them. They only receive decoded text (no binary formats).
- Generic PDF text import (template) rebuilds rows from text positions; multi-line descriptions keep only their first line. The Raiffeisen BiH importer has its own layout parser and keeps them whole.
- Raiffeisen BiH: only the "IZVOD - OBAVIJEST" PDF layout is supported (seen on current-account/card statements in KM); other products or currencies are untested. PDF parsing runs only in the web client, so MCP/connected uploads must send the client-parsed result.
- Merchant templates (Feature 125) match whole words: a bank description that glues the merchant to other
  letters ("PEKARAPRIMJER") no longer matches "Pekara Primjer"; add that spelling as an alias. Diacritics are
  folded (č/ć→c, š→s, ž→z, đ→d or dj); other transliterations (e.g. "ZH") need an alias.
- (fixed) Merchant templates (Feature 125): the web import applies the approved merchant and split template inside the commit write (`CommitRow.merchantId/splitTemplateId`); the web uncategorized inbox matches the description to a merchant and offers its split template.
- QIF: day/month order is inferred per file; all-ambiguous files assume MM/DD (DD.MM for dot dates) with a warning. QIF splits are kept raw only.
- MT940 `:86:` is used verbatim; bank-specific sub-field parsing (`?20`, `/REMI/` …) is not done.
- CAMT batched entries (several TxDtls) become one record for the entry total.
- Web app must call `setPdfWorkerSrc()` (bundled pdf.worker URL) before PDF import in the browser; the server must
  serve `.mjs` as JavaScript (fixed in `infrastructure/docker/nginx-base.conf`).
- (fixed) fp1 fingerprint is implemented identically in Go; both pass packages/test-fixtures/imports/fingerprint.json.

## Shared TS engine (packages/finance-engine, forecasting)
- (fixed) The Go conformance runner (`apps/api/internal/conformance_test`) now runs every family and op with
  nothing skipped: recurrence, subscriptions, fx_lookup (both Go paths), budget periods and status, forecast and
  planEvents, aggregation (incl. income by category, cashflow, net worth). Aggregation and budget status seed the
  fixture ledger into Postgres, so these runners skip when the dev database is down.
- `real-server.test.ts` (run by `scripts/e2e.sh`) adds an end-to-end web-vs-REST check for budget status totals,
  net worth with a manual USD rate and the merchant ranking; it was not re-run after the parity changes.
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
- Attachments: no virus scan; HEIC/HEIF and office documents are rejected by the sniffing allowlist. A crash
  between storing the file (rename / S3 put) and commit can leave an orphan object (never referenced, never
  served). S3: the bucket must already exist; admin diagnostics only check the local directory. With
  ATTACHMENT_ENCRYPTION_KEY, encrypted files are sealed/opened whole in memory (bounded by MAX_UPLOAD_BYTES);
  existing plain files are not re-encrypted, and there is no key rotation (losing the key loses those files).
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

## Auth, sync, backups, admin (apps/api/internal/{auth,sync,backups,admin,...})
- Rate limits are in-process fixed windows (per IP and per email on auth, per user on sync); with several API
  replicas each enforces its own window.
- `invite_only` registration means an admin creates the account (`POST /admin/users`); household invitations
  require the invitee to already have an account. No email delivery: invite tokens / recovery codes are
  passed on by the user (no SMTP needed).
- (fixed) `/api/v1/meta.registrationPolicy` shows the effective policy (admin setting over environment).
- Only the registration policy is changeable at runtime; MCP/FX/backup schedule stay environment settings.
- Sync push is registered for accounts, categories, tags, merchants, transactions, transaction/split
  templates, categorization rules, recurrence schedules, planned transactions, planned occurrences,
  subscriptions, budgets, budget allocations, savings goals and contributions (integration pass). Still not
  pushable as sync ops: `attachments` and new `import_batches` (the client sync engine uploads them over
  REST: POST /attachments, POST /imports with client ids; `import_batches` status changes then sync), and
  `imported_raw_records` (uploaded inside the batch). E2EE profiles keep attachments and imports on the
  device (the server would see plaintext). Local imports made before the source file was kept on the device
  are refused with `source_missing` and stay local. Client-chosen child ids (postings, splits) are
  replaced by server ids and come back in the pulled snapshot; budget allocations created through REST get
  server ids too.
- Sync push bodies are bounded by `MAX_BODY_BYTES` (default 1 MiB); clients must split large batches.
- E2EE: server side only (ciphertext storage, key envelopes, revocation). Client crypto, PDK rotation and
  re-encryption, and converting an existing profile between privacy modes are not implemented; PATCH of
  `privacyMode` is refused once the profile has data.
- `PATCH /profiles/{id}` cannot detach a profile from its household (null `householdId` is ignored); deleting
  the household detaches its profiles.
- Server backups: without `BACKUP_ENCRYPTION_KEY` they are stored unencrypted (metadata says `alg: none`,
  diagnostics flags it). Attachment file contents are not part of exports/backups. Restore of an exported
  e2ee profile is refused server-side. Restore of foreign-key cycles between different tables is not
  supported (none exist in the current schema).
- Audit `from`/`to` filters are UTC calendar days.

## Planning, budgets, forecasting, analytics, automation, notifications (Go API)
- No holiday calendar: business-day adjustment only moves Saturday/Sunday.
- Plan occurrences moved by a date override more than 62 days away from their rule date are not found by
  range queries (expansion window). `PUT /plans/{id}/occurrences/{date}` keeps working.
- Forecasts value future amounts at today's rate (constant-rate assumption, listed in `assumptions`) and,
  like the web, use only each account's main-currency balance and events (other currencies held in a
  multi-currency account are left out with a warning).
- Annual planning returns smoothed monthly amounts; it does not write them into budget allocations.
- Budget `alert` uses actual spending only; `projectedUtilization` shows actual + planned.
- Anomaly and recurring detection use fixed thresholds (documented in docs/architecture/planning-analytics.md);
  no per-profile tuning yet.
- Email/push delivery: only notifications generated by the server job are sent (not the ones the web app
  creates locally); delivery runs with the generator every 15 minutes when `JOBS_ENABLED` (no admin trigger).
  Titles/bodies follow `users.locale` (en/bs; the web sets it from the UI language when connected); Bosnian ones
  format amounts as `1.234,56 KM`. Quiet hours use `users.timezone`.
  Push to endpoints on private/loopback addresses is refused (SSRF guard), so self-hosted push services on a
  LAN are not supported. Mailpit/MinIO for tests: `docker compose -f docker-compose.dev.yml --profile
  integrations up -d mailpit minio` (MinIO image is the community `pgsty/minio` build; upstream stopped
  publishing images).
- `/analytics/import-coverage` uses `import_batches.coverage_start/end`; the imports module's `/imports/coverage`
  is the richer statement-level view.
- (fixed) Rules run automatically on REST/MCP-created transactions and server import commits
  (`ledger.AutoCategorize`, set by the automation module). Transactions arriving by sync push are not
  re-categorized: the device already ran its rules (manual entries and imports).
- (fixed) Financial parity web vs REST/MCP: budget status, forecast (scenario rules, credit limits, per-account
  shortfalls in account currency, safe-to-spend accounts and horizon) and aggregation now use one rule set and
  pass the same fixtures on both sides. Remaining input differences: the server values planned budget amounts
  at min(due date, today) while the web uses the due-date rate lookup (same rate unless rates exist for future
  dates); forecasts on the server read balances from Postgres, the web from its sync cache.
- (fixed) Budget rollover is chained on both sides; a period close freezes the stored carry, and the synced
  period allocation row carries `periodStart` so the web applies it. Period rows written before this change
  have no `periodStart` in the client cache: the web falls back to the chained value for them (equal unless
  older transactions changed after the close) until the row is re-synced.
- (fixed) Chained rollover started at the budget start, so a backdated carry_surplus/carry_both budget with no
  history inherited every elapsed period's allocation. The chain now starts at the first period with any spending
  (Go and TS, conformance `budgets.json`). Months with real but zero spending before that are treated the same.
- Forecast behaviour changes from aligning with the web: plans without an account and events in another
  currency than their account are left out (warning) instead of moving the total; only stored pending
  occurrences become overdue (rule dates that were never stored are not assumed to happen today).
- (fixed) Budgets created/edited by REST or MCP now reach the web with their limits (`budget_allocations` sync
  changes). Profile settings and exchange rates now sync in connected mode (REST side data of the sync engine).
  A device-entered manual rate for a pair/date that the profile already has on the server is dropped in favour
  of the server's rate (409). E2EE profiles keep settings and manual rates on the device.
- (fixed) Merchant analytics: refunds without their own merchant net against the refunded transaction's merchant
  (Go and TS); Go counts transactions (not split lines) and labels name groups like the TS engine.
- (fixed) PDF reports embed DejaVu Sans regular+bold (subset: Latin incl. č ć đ š ž, Cyrillic, currency symbols) with
  ToUnicode maps. Labels follow `?lang=`/the user's locale (en/bs); dynamic server warnings other than the constant ones
  stay English. Still: the PDF is a single text column; characters outside the subset (emoji,
  CJK, ₿) print as �. Report CSV has `?bom=true` for Excel.


## Imports API (apps/api/internal/imports)
- One batch = one account. Multi-account statements (several CAMT `Stmt`/MT940 accounts in one file) are
  staged against the chosen account; rows are not split per `accountRef`. Several statements of the same
  account in one file are merged (first opening, last closing balance).
- Server-side OFX converts `<CURRENCY>` foreign amounts like the TS importer; it does not port the TS
  converter's rounding edge cases beyond half-up (covered by the golden fixture only).
- Go parsers read whole uploads in memory (bounded by `MAX_UPLOAD_BYTES`, 100 000 records; the bytes are stored as evidence anyway). CAMT is decoded as an `encoding/xml` token stream; OFX/QIF/MT940/JSON build whole structures.
- Commit creates up to 100k transactions in one DB transaction (COPY) but records one sync change per
  transaction (4 round trips each); very large batches can approach the 60 s request timeout.
- Fuzzy matching is amount + date (±3 days manual, ±1 day imported) only; descriptions are not compared.
- Category suggestions: same source description previously classified by the user, then merchant default
  category; enabled automation rules run after that at commit.
- Reprocessing of client-only importers (XLSX/XLS/PDF/OCR) must be re-run in the web client.
- Coverage days are computed in memory per account (≤ 25 years per call).
- `GET /analytics/import-coverage` (analytics module) and `GET /imports/coverage` both exist; the imports one
  is authoritative for batch statuses (reconciliation + ledger check).

## Remote MCP (apps/api/internal/mcp)
- (fixed) OAuth 2.1 authorization server for /mcp (claude.ai / Claude Desktop connectors, Claude Code `/mcp`).
- OAuth: public clients only (no client secrets); Client ID Metadata Documents (MCP 2025-11-25) are not
  supported, clients must use DCR. Unused DCR registrations, expired codes and tokens are never cleaned up.
  A client that retries a refresh with an already rotated refresh token loses the grant (no grace period)
  and must authorize again. Loopback redirect URIs must match exactly, including the port. Consent needs a
  signed-in server session in the web app (local-only mode shows a notice). The OAuth `scope` parameter is
  not used to preselect capabilities (defaults are always read-only).
- Stateless Streamable HTTP: no server-initiated requests/notifications, no resumable SSE streams.
- (fixed) `get_attachments` reads through `attachments.Content` (local or S3, server-side encryption undone);
  only E2EE attachments return metadata only (images/PDFs up to 4 MiB).
- (fixed) `get_income_summary` has a per-income-category breakdown (`byCategory`).
- Budget status, savings goals, budgets and categorization rules are refused for account-restricted clients
  (they span all accounts). Forecasts include only granted accounts.
- `list_recurring_expenses` converts annualized amounts at today's rate; plan amounts stay native.
- Rate limit is per client IP (auth.RateLimit), not per MCP client.
- Proposal expiry is lazy (on list/approve/apply); expired rows are not cleaned up.
- Batch approval is not atomic: it approves ids one by one and stops at the first error.

## Client data layer (packages/storage, sync-client, api-client, localization)
- Real-API sync works for every table listed in the API section (`packages/sync-client/src/real-server.test.ts`,
  run with `FINPLAT_API_URL=http://api:8080 scripts/bun.sh test packages/sync-client/src/real-server.test.ts`
  while the dev stack is up; plus the Playwright connected-mode journey). E2EE has not been run against the
  real API. Exchange rates entered on a device are local only (not uploaded), so server-side valuations of a
  connected profile only see server/provider rates.
- Activation (local profile -> server) does not upload imports or attachments made while the profile was
  local; their transactions get `importRecordId = null`. Imports and attachments made in connected mode are
  uploaded by the sync engine (see the sync entry above).
- `LocalFinanceService` reads compute balances by scanning all transactions of the profile (fine for tens of
  thousands; add a balance cache if profiles grow beyond that). Transaction history/undo (feature 84),
  reconciliations and server-only analytics endpoints are not mirrored locally (engine functions are).
- Discarding a server-rejected op leaves the local row with the rejected edit until it changes again.
- E2EE: device private key and unlocked keyrings are stored in browser storage (not a secure enclave); the
  IndexedDB database itself is not encrypted at rest; the app lock only gates the UI. Revocation creates a new
  key generation but old envelopes are not re-encrypted (lazy re-encryption not implemented).
- Recovery code is 52 Crockford-base32 characters instead of the "24 words" of ADR 0005 (same 256-bit entropy).
- Encrypted backups hold the whole payload in memory (fine for typical personal data; streaming not done).
- (fixed) `bs` locale is complete (typechecked against `en`, plurals one/few/other); bs short dates are dd.MM.yyyy.

## Web insight pages (dashboard, planning, budgets, analytics, goals, subscriptions, reports, notifications)
- All figures are computed client-side from the DataSource (`@finplat/finance-engine` / `@finplat/forecasting`) in both local and connected mode; the server's analytics/forecast endpoints are not called. Connected mode therefore shows what the local sync cache holds, and depends on server sync entities that are not registered yet (see the sync gaps above).
- `planned_occurrences` and `budget_allocations` are read through the generic `FinanceOps.list` with a cast (they are not in the typed `EntityName` list).
- Dismissed insights/anomalies and the browser-notification opt-in are stored in local profile settings, which are not synced (not the server's `anomaly_dismissals`).
- Local notifications are generated only while the app is open (dashboard or notifications page). Email/push need connected mode (server job, Settings → Notifications); push in the browser needs the production build (the service worker is not registered under `vite dev`).
- Changing a subscription's price updates its plan in place (no superseding plan / price history as in the Go API), so older planned-vs-actual rows use the new price.
- The forecast values every account at the reporting-currency rate of today (engine rule) and uses only each account's main-currency balance; other currencies held in multi-currency accounts are left out.
- Web PDF export is the browser's print-to-PDF with a print stylesheet; connected profiles can also download the server PDF (`GET /reports/{kind}?format=pdf`, Unicode fonts embedded, E2E-checked), but the web page has no button for it. PNG export rasterizes the chart SVG.
- Drill-down links pass `from,to,kind,categoryId,merchantId,q,accountIds,currency` to `/transactions`; a top-level category filter may not include its subcategories depending on the transactions page filter.
- No dedicated component tests for the React pages; compute modules have unit tests and every page was smoke-rendered in Chromium (Playwright) with seeded local data.

## Web ledger pages (transactions, accounts, import, rules, converter)

- The transactions table loads the whole profile ledger into memory (`ops.ledger()`) and filters/sorts there;
  rendering is virtualized, but very large profiles (100k+) pay the IndexedDB read on every page load.
- Undo/history needs connected mode (server audit log); local mode has no change history.
- Reconciliation books the difference as an `adjustment` correcting the latest transaction on that account up
  to the statement date (local service API); a negative difference on an account without transactions is refused.
  Reconciliations are not stored as records (no `reconciled` status is set).
- Import reprocess asks the user to pick the original file again (only parsed records are stored locally) and
  rolls the old batch back first; the new batch is not linked via `reprocessedFromBatchId` in local mode.
- Import templates and statement-balance results are kept in profile settings (`import.templates`,
  `import.checks`), not in the server `import_templates` table.
- Applying a rule from the editor runs all enabled rules on the matched transactions (local `applyRules`).
- PDF attachments open in a new tab (gateway CSP `object-src 'none'` blocks inline embedding). OCR imports need
  tesseract language data from a CDN, which the strict CSP blocks unless self-hosted.
- Template names and the per-row "save as template" use `window.prompt`.
- (fixed) Ledger pages' strings go through `t()` with Bosnian translations.


## Web shell (onboarding, settings, sync, households, devices, MCP, admin)

- Connected mode uploads and downloads ledger, planning, budget, goal and rule data (Playwright journey:
  register → sync → second device → offline edit → reconnect). Imports and attachments made while connected
  are still refused by sync (`unsupported_entity`) and listed on /sync; local-to-connected activation with
  imported data uploads the transactions with `importRecordId = null`. Activation (with duplicate merge) and
  E2EE (encrypt on A, unlock with passphrase on B and recovery code on C) run in the E2E suite.
- (fixed) E2EE: plaintext REST/MCP/import/job writes into an end-to-end encrypted profile are refused with 409
  `e2ee_profile` (`changes.Record`), MCP grants on e2ee profiles are refused (and older grants answer
  `e2ee_profile`), and the consent page/grant dialog exclude or flag them. REST reads of an e2ee profile still
  return empty lists/analytics (the server has only ciphertext); they are not refused.
- (fixed) A device that signed in to an e2ee profile pulled before it was unlocked and stored ciphertext as records
  (transactions page crashed). The engine now refuses envelopes without a key (`ProfileLockedError`); devices that
  hit the old bug should disconnect and connect again to re-download the profile.
- (fixed) Safari private windows / WebKit ephemeral sessions refuse Blob values in IndexedDB; attachment and
  import-source bytes are now stored as ArrayBuffer (older Blob rows still read).
- WebKitGTK (Playwright's WebKit on Linux) crashes the page in `pushManager.getSubscription()`; the app now only
  asks when notification permission is granted, so push itself is untested on WebKit.
- Activation always creates the server profile with the local profile's id (or reuses it); merging a local profile
  into a different existing server profile is not offered because `RemoteDataSource` maps one id to both sides.
  While connected, local profiles that were not activated are hidden; they reappear after disconnecting.
- The hosted web app can only connect to its own origin: the gateway CSP keeps `connect-src 'self'`, and cookie
  sessions are same-site. Using another server means opening that server's web app.
- Scheduled local backups are reminders (banner when due) plus a one-click encrypted download; browsers cannot
  write backup files silently, and the passphrase is never stored. Device-backup restore is local mode only.
- The app lock is an Argon2id verifier in localStorage that hides the UI; it does not encrypt IndexedDB. Clearing
  site data removes both the lock and the data. Biometric unlock is Phase 3/4.
- The MCP management page is at `/agents` because `/mcp` is the MCP protocol endpoint (proxied by the gateway).
- Bosnian: `apps/web/src/lib/i18n.test.ts` now also catches template literals inside `?:`, capitalized English
  passed as call arguments and English `label`/`title` properties, and checks runtime keys (enums, widget titles,
  importer limitations); the dashboard, filters, forecast assumptions, insights and the hits it found are
  translated. The scans are heuristics: still English are lowercase-start fragments outside JSX, label maps whose
  keys are enum values (e.g. the rules page summary `field op "value"`, notification kinds, import batch status,
  sync entity names on activation), notification titles/bodies generated in `.ts`, server-generated text
  (insights, error details, and MCP forecast texts — REST forecasts honour `?lang=`/`users.locale`), and sentences translated in pieces around inline
  values (`{n} {t('…records,')}`). Merchant names of importers ("Generic CSV") stay as-is.
- (fixed) Chromium has no Bosnian ICU data (bs-BA formatted as `-BAM 1,234.50`, `2026 M03 31`); `intlLocale()` in
  `@finplat/localization` substitutes `sr-Latn-BA` (same BiH conventions: `1.234,56 KM`). Firefox/WebKit use bs.
- (fixed) Accessibility: `tests/e2e/specs/a11y.spec.ts` runs axe-core (WCAG 2.1 A/AA) on every main page in
  light and dark mode and on the server pages; serious/critical violations fail the suite. Fixed: accent
  contrast on tinted surfaces, links inside text now underlined, calendar out-of-month days no longer dimmed
  with opacity. Moderate/minor axe findings are not gated.
- `libsodium` (app lock, backups, E2EE) needs `'wasm-unsafe-eval'` in the gateway CSP `script-src` (added).

## Native apps (apps/native, Tauri 2) — 2026-10-23
Full state and checklists: docs/native/README.md.
- Windows, macOS and iOS are built on GitHub Actions only; nobody has run them yet. Linux was driven
  headless (Xvfb); tray icon, global shortcut and OS notifications were not seen on a real desktop.
  Android ran in an emulator only (no biometrics, camera or real notifications there).
- The bearer token is in the OS credential store on desktop/iOS; on Android (and Linux without a
  Secret Service) it stays in the app's private settings. E2EE keys stay in the app's SQLite.
  Signing in again from the "session ended" banner registers a new device.
- No push notifications while the app is closed; OS notifications are shown while it runs.
- No passkeys in the native app (WebAuthn is bound to the server's web origin): password sign-in.
- No auto-update, no signed Windows/macOS builds yet (SmartScreen / Gatekeeper warnings).
- The whole local database is loaded into memory at start (MemoryStore + SQLite write-through);
  fine for a personal ledger, revisit for very large data.
- Exports and backups use the OS save dialog; on iOS the save dialog has not been tried (Files app
  integration may need the share sheet instead).
- iOS: `src-tauri/gen/apple` is not committed yet (generate with `tauri ios init` on a Mac).

## Integration pass (2026-10-22)
- E2E suite (`tests/e2e`, `scripts/e2e.sh`) runs every journey in Chromium, Firefox and WebKit (Playwright
  1.63 image) against an isolated `finplat-e2e` stack with Mailpit; `admin.spec.ts` runs alone afterwards because
  it closes registration for a moment. Firefox under CPU load (three browsers in parallel on a busy host)
  sometimes never reports a page event to Playwright although every resource finished (traces show the bundle
  received in ~40 ms and nothing pending), and occasionally hangs before DOMContentLoaded. It does not reproduce
  with Firefox alone (12/12, 18/18 runs) and blocking service workers does not change it. Navigations now wait
  for `domcontentloaded` instead of `load`, and CI runs keep one retry; retried tests are reported as flaky. Still failing in
  Firefox about half the time (even with Firefox alone): `activation.spec.ts` "E2EE profile … B and C", which opens
  three contexts; one hangs in `page.goto` before DOMContentLoaded. Chromium and WebKit pass it.
- Real bugs found by the new journeys and fixed: pdf.js worker (`.mjs`) served as octet-stream with nosniff, so every
  PDF import failed in the built app; Bosnian formatting in Chromium; the E2EE fresh-device crash; WebKit Blob
  storage; the "ready to work offline" prompt covering page buttons until closed.
- `/api/v1/meta.registrationPolicy` reflects `.env`; the deployed instance uses `first_user`: the first account
  registered on https://fin.pr0h0.me becomes the admin and later sign-ups are refused. Register yourself first.
- `ALLOWED_ORIGINS` in the deployed `.env` also contains `http://127.0.0.1:3810` so the stack can be used and
  tested directly on the host; remove it if you never browse to the loopback port.
- The Secure session cookie works on `http://127.0.0.1:3810` only in browsers that treat loopback as a secure
  context (Chromium, Firefox). Non-browser HTTP clients over plain http must use bearer tokens (device login).
- Deployed 2026-10-22 (`docker compose -p finplat up -d --build`, `.env` unchanged; VAPID keys are generated into
  the server settings on first use, OAuth tokens are opaque and hashed, so no new env was needed; SMTP is unset so
  email delivery is off on the live instance). Verified through the tunnel: `/api/health`, `/api/v1/meta`
  (schema 20261022120001), both `/.well-known/oauth-*` documents, `/mcp` 401 without a token, pdf.js worker
  served as `text/javascript`.
- The e2e stack reads the production `.env` (compose `env_file`) and overrides the settings it needs.
