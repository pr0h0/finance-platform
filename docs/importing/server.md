# Server-side imports (Go, `apps/api/internal/imports`)

The API stages, deduplicates, reconciles, commits and rolls back imports for both the web client and
connected/MCP use. REST contract: OpenAPI tag `imports`.

## Two ways in (`POST /api/v1/imports`)

| | body | parser |
|---|---|---|
| web client | JSON `ClientImportStage`: `{importerId, importerVersion, accountId, fileName, fileSha256, source (base64), result (ImportResult), templateId?, reprocessedFromBatchId?}` | TS importer in the browser (all formats incl. XLSX/XLS/PDF/OCR) |
| connected / scripts / MCP | `multipart/form-data`: `file`, `accountId`, optional `importerId`, `templateId` | Go port of the TS importer |

Go ports (same ids, versions and fp1 fingerprints as `packages/bank-importers`): `generic-csv`,
`generic-tsv` (templates from [templates.md](templates.md); `xlsx`/`pdf` templates are client-only),
`generic-ofx`, `generic-qfx`, `generic-qif`, `generic-camt053`, `generic-camt054`, `generic-mt940`,
`generic-json` (finplat interchange). Parity with TS is enforced by
`apps/api/internal/imports/golden_test.go` against goldens generated from the TS importers on the shared
fixtures (`scripts/bun.sh run apps/api/internal/imports/testdata/golden/generate.ts`).
`GET /api/v1/importers` lists them, the client-only ones (`serverSide: false`) and the
**BLOCKED_EXTERNAL** `raiffeisen-bih` placeholder, which is refused with `importer_blocked_external`.

Upload safety: `MAX_UPLOAD_BYTES` (default 25 MiB) per file; client-parsed JSON may be up to 2× that; a ZIP
must contain exactly one statement (≤16 entries scanned, no nested ZIPs, no `..` paths, uncompressed size
≤ limit and compression ratio ≤ 100 checked while reading, not trusted from headers); encodings UTF-8/16,
Windows-1250 and ISO-8859-2 are detected; XML with a DOCTYPE is refused; markup nesting is bounded;
≤ 100 000 records per batch; every text field is clipped to 4 KiB.

## Staging → preview → commit

Staging (one DB transaction) stores the original bytes (`import_batch_sources`, immutable), the
statement (`bank_statements`), one immutable `imported_raw_records` row per record with the server-computed
fp1 fingerprint, and an `import_reconciliation_results` row per record:

| outcome | rule | default selection |
|---|---|---|
| `duplicate` | same fingerprint already linked to a live transaction on this account (other batch) | off |
| `matched` | (reprocess) same fingerprint linked to the batch being reprocessed; or a live, not-yet-imported transaction on the account with the same signed amount within ±3 days (manual entry) | on — links, never duplicates |
| `conflict` | an imported transaction with the same amount within ±1 day but another fingerprint (overlapping statements from different formats) | off |
| `new` | none of the above; `suggestedCategoryId` from the user's previous classification of the same source description, or a merchant default category | on |
| `error` | currency differs from a single-currency account, unknown currency, too many decimals | cannot be selected |

Reconciliation: opening balance (statement, or reconstructed from the first running balance) + Σ rows =
closing balance; running balances are checked row by row. `GET /imports/{id}/preview` pages rows with totals
and the reconciliation. `POST /imports/{id}/commit` (Idempotency-Key) takes per-row overrides
(`selected`, `categoryId`, `description`) and:

- refuses a statement that does not reconcile unless `allowUnreconciled: true`;
- re-checks duplicates committed meanwhile by another batch;
- creates transactions (`source = import`, one posting, one split) or links matched ones, atomically;
- `createOpeningBalance: true` books statement-opening − ledger-before-start as `opening_balance`
  (or a reconciliation `adjustment` when there is earlier history) the day before the statement;
- compares the ledger with the closing balance (`stats.ledgerMatchesClosing`, `ledgerDifference`).

An interrupted commit leaves the batch `staged`; retry it.

## Rollback, reprocessing

`POST /imports/{id}/rollback` soft-deletes exactly the transactions the batch created (synced tombstones)
and restores links it changed (a matched manual transaction gets unlinked; a reprocess-relinked one goes back
to its previous record). Unrelated transactions are never touched.

`POST /imports/{id}/reprocess` re-parses the stored original with the current importer/template version
into a new staged batch (`reprocessedFromBatchId`). Rows matching the old batch's records are `matched`:
committing relinks the existing transactions to the new evidence, so categories, splits, notes and tags
survive. Old transactions absent from the new parse are listed in `stats.orphanedTransactionIds` and left
for the user. Client-only importers return `client_reprocess_required` (re-run in the browser and stage with
`reprocessedFromBatchId`).

## Coverage and inbox

`GET /imports/coverage` (and the MCP tool `get_import_coverage`): per account, day segments and months
with `complete` (statement balances reconcile with the file and the ledger), `unverified` (imported without
balances), `conflicting` (balances disagree), `partial` (month partly covered), `missing`.

`GET /imports/inbox` (and `get_uncategorized_transactions`): live income/expense/refund transactions
without a split or with an uncategorized split.
